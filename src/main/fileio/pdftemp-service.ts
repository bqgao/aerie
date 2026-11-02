/**
 * The server-PDF temp cache (pass I-b) behind the `pdfTemp:*` channels. When a PDF tab opens
 * a file that lives on a saved server, main pulls it HERE — over the app's ONE pooled SSH
 * connection (its sftp subsystem, borrowed per pull when the SFTP transfer service's cached
 * channel doesn't apply: this pull is silent — no transfer registry, no progress pushes —
 * so it opens its own channel through the pool's withClient seam and lets it close).
 *
 * The temp copy is content-addressed: the pull streams into a staging file, hashes the bytes
 * (sha256), then renames the staging file to `<hash>.pdf`. Identity rules follow the editor:
 * the same file re-opened lands the cached copy without a re-pull, and two servers can't
 * collide (different bytes → different hashes; identical bytes are interchangeable).
 *
 * Conventions (same as fileio-service / sftp-service): handlers NEVER reject — every failure
 * is in-band `{ ok:false, error, notFound?/tooLarge? }`; input is re-shaped through the shared
 * remote-path builder; the real filesystem and the SSH pool sit behind seams so tests stand
 * in fakes; the 20MiB cap is checked against the remote stat BEFORE any chunk moves.
 *
 * The cache dir is wiped on app quit (`sweep()`, registered on will-quit by main); files a
 * crashed run missed are reclaimed by the same sweep next launch.
 */
import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import {
  PDFTEMP_CHUNK_BYTES,
  PDFTEMP_MAX_BYTES,
  type PdfTempManager,
  type PdfTempOpenResult,
} from "@shared/pdftemp";
import { normalizeRemotePath } from "@shared/sftp-paths";

/** The local filesystem seam (mirrors fileio-service's FileIoFs): a truncated write, the
 *  existence/size probes the cache-key step needs, and a best-effort teardown. */
export interface PdfTempFs {
  mkdirp(path: string): Promise<void>;
  writeNew(path: string, bytes: Buffer): Promise<{ ok: true } | { ok: false; message: string }>;
  rename(from: string, to: string): Promise<{ ok: true } | { ok: false; message: string }>;
  exists(path: string): Promise<boolean>;
  removeQuiet(path: string): Promise<void>;
  /** The sweep's walking of one directory's regular files; null = the dir itself is gone. */
  listFiles(dir: string): Promise<string[] | null>;
}

/** The real PdfTempFs over node:fs/promises. */
export const realPdfTempFs: PdfTempFs = {
  async mkdirp(path) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { recursive: true });
  },
  async writeNew(path, bytes) {
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, bytes, { flag: "w" });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
  async rename(from, to) {
    try {
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
  async exists(path) {
    try {
      const { stat } = await import("node:fs/promises");
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  async removeQuiet(path) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(path, { force: true });
    } catch {
      // cleanup is best-effort by contract
    }
  },
  async listFiles(dir) {
    try {
      const { readdir, stat } = await import("node:fs/promises");
      const names = await readdir(dir);
      const files: string[] = [];
      for (const name of names) {
        const full = nodePath.join(dir, name);
        try {
          if ((await stat(full)).isFile()) files.push(full);
        } catch {
          // a mid-sweep vanish is exactly what the sweep is for
        }
      }
      return files;
    } catch {
      return null; // dir gone — the sweep has nothing to do here
    }
  },
};

/** The remote read seam over the pooled connection: a stat first (the cap + identity gates
 *  run against it) and positioned page reads after (one page in flight, sequential — the
 *  editor tab doesn't need parallel throughput). Failures carry the raw message; `notFound`
 *  is matched server-message-style like the SFTP service does. */
export interface PdfTempRemote {
  sizeOf(
    serverId: string,
    path: string,
  ): Promise<
    | { ok: true; size: number }
    | { ok: false; message: string; notFound?: boolean }
  >;
  readPage(
    serverId: string,
    path: string,
    position: number,
    length: number,
  ): Promise<
    | { ok: true; buf: Buffer; bytes: number }
    | { ok: false; message: string; notFound?: boolean }
  >;
}

const ENOENT_RE = /no such file|No such|ENOENT|does not exist/i;
const asError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));

export function createPdfTempRemote(
  manager: PdfTempManager,
  onError?: (message: string) => void,
): PdfTempRemote {
  /** Borrow the pooled client's sftp subsystem, as a promise (null when not connected). */
  const borrow = (
    serverId: string,
  ): Promise<{ ok: true; sftp: SftpLike } | { ok: false; message: string }> =>
    new Promise((resolve) => {
      const got = manager.withClient(serverId, (rpc) => {
        try {
          if (!rpc.sftp) {
            resolve({
              ok: false,
              message: "The pooled connection cannot open SFTP channels.",
            });
            return;
          }
          rpc.sftp((err, sftp) => {
            if (err || !sftp) {
              resolve({ ok: false, message: err?.message ?? "Could not open the SFTP channel." });
              return;
            }
            resolve({ ok: true, sftp: sftp as SftpLike });
          });
        } catch (e) {
          resolve({ ok: false, message: asError(e).message });
        }
      });
      if (!got) resolve({ ok: false, message: "The server is not connected." });
    });
  const runOp = async <R extends { ok: boolean }>(
    serverId: string,
    op: (sftp: SftpLike) => Promise<R>,
  ): Promise<R | { ok: false; message: string }> => {
    const borrowed = await borrow(serverId);
    if (!borrowed.ok) return borrowed;
    try {
      return await op(borrowed.sftp);
    } catch (err) {
      const e = asError(err);
      onError?.(e.message);
      return { ok: false, message: e.message };
    }
  };
  const statOf = (sftp: SftpLike, path: string): Promise<SftpAttrsLike> =>
    new Promise((resolve, reject) => {
      sftp.stat(path, (err, attrs) => (err ? reject(err) : resolve(attrs)));
    });
  const openHandle = (sftp: SftpLike, path: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      sftp.open(path, "r", (err, handle) => (err ? reject(err) : resolve(handle)));
    });
  const readAt = (
    sftp: SftpLike,
    handle: unknown,
    buf: Buffer,
    pos: number,
    length: number,
  ): Promise<number> =>
    new Promise((resolve, reject) => {
      sftp.read(handle, buf, 0, length, pos, (err, n) =>
        err ? reject(err) : resolve(n),
      );
    });
  const closeHandle = async (sftp: SftpLike, handle: unknown): Promise<void> => {
    try {
      await new Promise<void>((resolve) => sftp.close(handle, () => resolve()));
    } catch {
      // a handle-close failure never changes the pull's verdict
    }
  };
  return {
    async sizeOf(serverId, path) {
      return runOp<{ ok: true; size: number } | { ok: false; message: string }>(serverId, async (sftp) => {
        let attrs: SftpAttrsLike;
        try {
          attrs = await statOf(sftp, path);
        } catch (err) {
          const e = asError(err);
          onError?.(e.message);
          return { ok: false, ...(ENOENT_RE.test(e.message) ? { notFound: true } : {}), message: e.message };
        }
        if (attrs.isDirectory()) {
          return { ok: false, message: "Path is not a file." };
        }
        return { ok: true, size: attrs.size };
      });
    },
    async readPage(serverId, path, position, length) {
      return runOp<{ ok: true; buf: Buffer; bytes: number } | { ok: false; message: string }>(
        serverId,
        async (sftp) => {
          let handle: unknown;
          try {
            handle = await openHandle(sftp, path);
          } catch (err) {
            const e = asError(err);
            onError?.(e.message);
            return { ok: false, ...(ENOENT_RE.test(e.message) ? { notFound: true } : {}), message: e.message };
          }
          try {
            const buf = Buffer.alloc(length);
            const n = await readAt(sftp, handle, buf, position, length);
            return { ok: true, buf, bytes: n };
          } finally {
            await closeHandle(sftp, handle);
          }
        },
      );
    },
  };
}

/** The sftp shape the real pooled client hands back (ssh2's SftpClient, narrowed — the
 *  ambient ssh2-types.d.ts names it richer than this needs). */
interface SftpLike {
  open(path: string, flags: string, cb: (err: Error | undefined, handle: unknown) => void): void;
  read(
    handle: unknown,
    buf: Buffer,
    offset: number,
    length: number,
    position: number | null,
    cb: (err: Error | undefined, bytesRead: number) => void,
  ): void;
  close(handle: unknown, cb: (err: Error | undefined) => void): void;
  stat(path: string, cb: (err: Error | undefined, attrs: SftpAttrsLike) => void): void;
}
interface SftpAttrsLike {
  size: number;
  isDirectory(): boolean;
}

export interface PdfTempDeps {
  /** The cache dir itself (userData/cache/pdf at the composition root) — a function because
   *  Electron paths are only valid once app is ready, and callers keep one instance for the
   *  app's lifetime. */
  dir(): string;
  fs?: PdfTempFs;
  remote: PdfTempRemote;
  /** The hasher behind the content-addressed names (default sha256 hex); fixed so tests
   *  name files deterministically. */
  hash?: (buf: Buffer) => string;
  /** The chunk page (shared constant by default). */
  chunkBytes?: number;
  /** The max transfer (shared constant by default). */
  maxBytes?: number;
}

export interface PdfTempService {
  /** One server PDF → the `file://` URL of its main-side temp copy. Never rejects; raw
   *  IPC input is re-shaped here (the handler passes it through untouched). */
  open(serverId: unknown, path: unknown): Promise<PdfTempOpenResult>;
  /** Best-effort teardown of the cache dir's files (registered on app will-quit; a missed
   *  file is reclaimed by the same sweep next launch). */
  sweep(): Promise<void>;
}

/** Build a `file://` URL for an absolute local path (the renderer's webview src). Callers
 *  never string-concat this — percent-encoding lives here, one definition. */
export function pdfFileUrlOf(abs: string): string {
  const forward = abs.replace(/\\/g, "/");
  const segments = forward.split("/").map((seg) =>
    seg === "" ? "" : encodeURIComponent(seg),
  );
  return `file://${segments.join("/")}`;
}

export function createPdfTempService(deps: PdfTempDeps): PdfTempService {
  const fs = deps.fs ?? realPdfTempFs;
  const hash = deps.hash ?? ((buf: Buffer) => createHash("sha256").update(buf).digest("hex"));
  const chunk = deps.chunkBytes ?? PDFTEMP_CHUNK_BYTES;
  const maxBytes = deps.maxBytes ?? PDFTEMP_MAX_BYTES;
  // "<serverId>:<path>" is refined to a normalized path before any SSH touch, matching the
  // SFTP family's input rule: the only remote path builder runs first.
  const norm = (rawPath: unknown): string | null => normalizeRemotePath(
    typeof rawPath === "string" ? rawPath : "",
  );

  // Staging uniqueness across same-ms pulls: pid + a monotonic local counter.
  let stagingSeq = 0;

  const openImpl = async (
    serverId: unknown,
    rawPath: unknown,
  ): Promise<PdfTempOpenResult> => {
    if (typeof serverId !== "string" || !serverId) {
      return { ok: false, error: "No server." };
    }
    const path = norm(rawPath);
    if (!path) {
      return { ok: false, error: "Invalid path." };
    }
    // The cap: the remote stat answers it before any byte moves (in-band refusal).
    const sized = await deps.remote.sizeOf(serverId, path);
    if (!sized.ok) {
      return { ok: false, error: sized.message, ...(sized.notFound ? { notFound: true } : {}) };
    }
    if (sized.size > maxBytes) {
      return {
        ok: false,
        error: `PDF is too large to open (${sized.size} bytes, cap ${maxBytes}).`,
        tooLarge: true,
      };
    }
    // Pull to a staging path, then content-address the final name. The cache dir must
    // exist before the staged write; the mkdir is per-open (it is idempotent and cheap).
    const dir = deps.dir();
    try {
      await fs.mkdirp(dir);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const staging = nodePath.join(dir, `staging-${process.pid}-${++stagingSeq}`);
    let bytes: Buffer;
    if (sized.size === 0) {
      bytes = Buffer.alloc(0);
    } else {
      const chunks: Buffer[] = [];
      let position = 0;
      while (position < sized.size) {
        const length = Math.min(chunk, sized.size - position);
        const page = await deps.remote.readPage(serverId, path, position, length);
        if (!page.ok) {
          await fs.removeQuiet(staging);
          return { ok: false, error: page.message, ...(page.notFound ? { notFound: true } : {}) };
        }
        if (page.bytes <= 0) break; // the remote shrank mid-read: serve what landed
        chunks.push(Buffer.from(page.buf.subarray(0, page.bytes)));
        position += page.bytes;
      }
      bytes = Buffer.concat(chunks);
    }
    const staged = await fs.writeNew(staging, bytes);
    if (!staged.ok) {
      await fs.removeQuiet(staging);
      return { ok: false, error: staged.message };
    }
    const name = `${hash(bytes)}.pdf`;
    // No extension "wording" is kept: bytes → hash → fixed ".pdf".
    const finalPath = nodePath.join(dir, name);
    /** The cache dir is the app's own: absolute paths only by the dir() contract. */
    if (await fs.exists(finalPath)) {
      await fs.removeQuiet(staging);
      return { ok: true, fileUrl: pdfFileUrlOf(finalPath), bytes: bytes.length, cached: true };
    }
    const moved = await fs.rename(staging, finalPath);
    if (!moved.ok) {
      await fs.removeQuiet(staging);
      return { ok: false, error: moved.message };
    }
    return { ok: true, fileUrl: pdfFileUrlOf(finalPath), bytes: bytes.length, cached: false };
  };

  return {
    open: async (serverId, path) => {
      try {
        return await openImpl(serverId, path);
      } catch (err) {
        // the never-rejects belt: a composition bug must not breach the IPC contract
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    async sweep() {
      const files = await fs.listFiles(deps.dir());
      if (!files) return;
      await Promise.all(files.map((f) => fs.removeQuiet(f)));
    },
  };
}
