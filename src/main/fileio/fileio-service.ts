/**
 * The editor's local-disk file service (pass I-a) behind the `fileio:*` channels. Same
 * conventions as the SFTP service: never rejects (in-band `{ok:false, errorKind, message}`),
 * input is re-shaped before use, and the real filesystem is narrowed behind a seam so tests
 * stand in an in-memory fake.
 *
 * The two user-facing guarantees (IDE_SPEC "File I/O channels"):
 * - PATH RULES — absolute paths only, and anything under the app's own data dirs (Electron's
 *   userData, where the index/analytics stores and settings live) is refused for both reads and
 *   writes, so an editor tab can never clobber the app's own state.
 * - ATOMIC WRITES — the payload goes to `<path>.cbw-tmp-<suffix>` first and is RENAMED over the
 *   target, so a crash mid-write leaves the old file intact (the possible stale temp is the
 *   acceptable residue; the reverse — a torn target — is not).
 *
 * The 512KiB cap and the 8KiB NUL sniff both happen here, main-side of the IPC boundary, so a
 * binary file's payload never crosses to the renderer at all.
 */
import * as nodePath from "node:path";
import {
  FILEIO_BINARY_SNIFF_BYTES,
  FILEIO_READ_CAP_BYTES,
  type FileIoErrorKind,
  type FileIoReadResult,
  type FileIoWriteResult,
} from "@shared/fileio";

/** The filesystem seam (mirrors sftp-service's LocalIo): every operation answers a structured
 *  result; `code` is the OS error code ("ENOENT"…) when one exists, so the service can map
 *  missing files to the `not-found` kind instead of a generic io message. */
export interface FileIoFs {
  sizeOf(
    path: string,
  ): Promise<
    { ok: true; size: number } | { ok: false; code?: string; message: string }
  >;
  readInto(
    path: string,
    length: number,
    position: number,
  ): Promise<
    | { ok: true; buf: Buffer; bytes: number }
    | { ok: false; code?: string; message: string }
  >;
  writeNew(
    path: string,
    bytes: Buffer,
  ): Promise<{ ok: true } | { ok: false; code?: string; message: string }>;
  rename(
    from: string,
    to: string,
  ): Promise<{ ok: true } | { ok: false; code?: string; message: string }>;
  /** Best-effort cleanup (stale temp after a failed rename) — a failure here is noise. */
  removeQuiet(path: string): Promise<void>;
}

/** The real FileIoFs over node:fs/promises: one open fd per read (bounded page), a fresh
 *  truncating temp file per write. `readInto` re-opens every call — the editor reads AT MOST the
 *  one cap window per open, so a dedicated fd holder would be ceremony. */
export const realFileIoFs: FileIoFs = {
  async sizeOf(path) {
    try {
      const { open } = await import("node:fs/promises");
      const fd = await open(path, "r");
      try {
        const { size } = await fd.stat();
        return { ok: true, size: size };
      } finally {
        await fd.close();
      }
    } catch (err) {
      return { ok: false, code: codeOf(err), message: messageOf(err) };
    }
  },

  async readInto(path, length, position) {
    try {
      const { open } = await import("node:fs/promises");
      const fd = await open(path, "r");
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fd.read(buf, 0, length, position);
        return { ok: true, buf, bytes: bytesRead };
      } finally {
        await fd.close();
      }
    } catch (err) {
      return { ok: false, code: codeOf(err), message: messageOf(err) };
    }
  },

  async writeNew(path, bytes) {
    try {
      const { open } = await import("node:fs/promises");
      const fd = await open(path, "w");
      try {
        if (bytes.length > 0) await fd.write(bytes, 0, bytes.length, 0);
        return { ok: true };
      } finally {
        await fd.close();
      }
    } catch (err) {
      return { ok: false, code: codeOf(err), message: messageOf(err) };
    }
  },

  async rename(from, to) {
    try {
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: codeOf(err), message: messageOf(err) };
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
};

const codeOf = (err: unknown): string | undefined =>
  err instanceof Error &&
  typeof (err as NodeJS.ErrnoException).code === "string"
    ? (err as NodeJS.ErrnoException).code
    : undefined;

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const kindOfCode = (code: string | undefined): FileIoErrorKind =>
  code === "ENOENT" ? "not-found" : "io";

export interface FileIoService {
  read(path: string): Promise<FileIoReadResult>;
  write(path: string, content: string): Promise<FileIoWriteResult>;
}

/** The pure binary sniff: a NUL byte inside the first `peekedBytes` of `buffer` (main-side
 *  only — a binary payload never reaches the renderer). */
function fileIoIsBinary(buffer: Buffer, peekedBytes: number): boolean {
  const peek = buffer.subarray(0, Math.min(peekedBytes, buffer.length));
  return peek.includes(0);
}

export interface FileIoDeps {
  /** The app's own data dirs (Electron's userData at the composition root) — refused for both
   *  reads and writes. A function, not a value, because getPath is only valid once app is ready
   *  and dirs don't change mid-session. */
  dataDirs(): string[];
  fs?: FileIoFs;
}

export function createFileIoService(deps: FileIoDeps): FileIoService {
  const fs = deps.fs ?? realFileIoFs;
  let tmpSeq = 0;

  /** The shared path gate: non-empty string, absolute, no NUL, and never inside one of the
   *  app's data dirs. `resolve` re-anchors relative segments so a `..` escape can't slip past
   *  the data-dir check; the case-folded compare keeps Windows' two-ways-of-spelling-it honest. */
  const gate = (
    raw: unknown,
  ):
    | { ok: true; resolved: string }
    | { ok: false; errorKind: FileIoErrorKind; message: string } => {
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) {
      return { ok: false, errorKind: "invalid-path", message: "Invalid path." };
    }
    if (!nodePath.isAbsolute(raw)) {
      return {
        ok: false,
        errorKind: "invalid-path",
        message: "Only absolute paths can be opened.",
      };
    }
    const resolved = nodePath.resolve(raw);
    const fold = (p: string) =>
      process.platform === "win32" ? p.toLowerCase() : p;
    for (const dir of deps.dataDirs()) {
      const base = fold(nodePath.resolve(dir));
      const candidate = fold(resolved);
      if (
        candidate === base ||
        candidate.startsWith(`${base}${nodePath.sep}`)
      ) {
        return {
          ok: false,
          errorKind: "forbidden-path",
          message: "The app refuses to edit its own data files.",
        };
      }
    }
    return { ok: true, resolved };
  };

  const ioFailure = (res: { code?: string; message: string }) => ({
    ok: false as const,
    errorKind: kindOfCode(res.code),
    message: res.message,
  });

  const contained = async <R extends { ok: boolean }>(
    run: () => Promise<R>,
  ): Promise<
    R | { ok: false; errorKind: FileIoErrorKind; message: string }
  > => {
    try {
      return await run();
    } catch (err) {
      return { ok: false, errorKind: "io", message: messageOf(err) };
    }
  };

  /** UTF-8 read with the cap + sniff (the "encoding assumption UTF-8" is literal: a torn
   *  multi-byte sequence at the cap boundary decodes to U+FFFD rather than failing). */
  const readImpl = async (rawPath: unknown): Promise<FileIoReadResult> => {
    const gated = gate(rawPath);
    if (!gated.ok) return gated;
    const sized = await fs.sizeOf(gated.resolved);
    if (!sized.ok) return ioFailure(sized);
    const capped = sized.size > FILEIO_READ_CAP_BYTES;
    const readLength = capped ? FILEIO_READ_CAP_BYTES : sized.size;
    if (readLength === 0) {
      return { ok: true, content: "", bytes: 0, capped: false };
    }
    const read = await fs.readInto(gated.resolved, readLength, 0);
    if (!read.ok) return ioFailure(read);
    // The sniff runs on the SLICE THAT WOULD SHIP: a binary file never crosses the boundary.
    if (fileIoIsBinary(read.buf, FILEIO_BINARY_SNIFF_BYTES)) {
      return {
        ok: false,
        errorKind: "binary",
        message: "Binary file — not editable in this version.",
      };
    }
    return {
      ok: true,
      content: read.buf.subarray(0, read.bytes).toString("utf8"),
      bytes: read.bytes,
      capped,
    };
  };

  /** Atomic trade (temp + rename) so a crash mid-write never tears the target. On a failed
   *  rename the temp is removed; the target either keeps its old content or gains the new one. */
  const writeImpl = async (
    rawPath: unknown,
    rawContent: unknown,
  ): Promise<FileIoWriteResult> => {
    const content = typeof rawContent === "string" ? rawContent : "";
    const gated = gate(rawPath);
    if (!gated.ok) return gated;
    const bytes = Buffer.from(content, "utf8");
    const tmp = `${gated.resolved}.cbw-tmp-${process.pid}-${++tmpSeq}`;
    const staged = await fs.writeNew(tmp, bytes);
    if (!staged.ok) return ioFailure(staged);
    const moved = await fs.rename(tmp, gated.resolved);
    if (!moved.ok) {
      await fs.removeQuiet(tmp);
      return ioFailure(moved);
    }
    return { ok: true, bytes: bytes.length };
  };

  return {
    read: (path: string) => contained(() => readImpl(path)),
    write: (path: string, content: string) =>
      contained(() => writeImpl(path, content)),
  };
}
