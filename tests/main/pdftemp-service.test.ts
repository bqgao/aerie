/**
 * The server-PDF temp cache (pass I-b) with FAKE seams: temp naming is content-addressed
 * (sha256 → `<hash>.pdf`), the 20MiB cap refuses in band before any chunk moves, the staging
 * file is cleaned on every failure path, a cached copy short-circuits the remote pull, the
 * `file://` URL is percent-encoded, and the sweep empties (only) the cache dir. No webview
 * DOM here; the `pdfTemp:*` handler is a thin passthrough (fileio-ipc grammar, tested for
 * the registration shape in its own family).
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createPdfTempService,
  type PdfTempFs,
  type PdfTempRemote,
} from "../../src/main/fileio/pdftemp-service";
import { pdfFileUrlOf } from "../../src/main/fileio/pdftemp-service";

/** In-memory PdfTempFs: directories are implicit (a created dir just records files). */
const fakeFs = (): PdfTempFs & {
  saves: Map<string, Buffer>;
  created: string[];
} => {
  const saves = new Map<string, Buffer>();
  const created: string[] = [];
  return {
    saves,
    created,
    async mkdirp(path) {
      created.push(path);
    },
    async writeNew(path, bytes) {
      saves.set(path, Buffer.from(bytes));
      return { ok: true };
    },
    async rename(from, to) {
      const buf = saves.get(from);
      if (buf === undefined) return { ok: false, message: "ENOENT: " + from };
      saves.delete(from);
      saves.set(to, buf);
      return { ok: true };
    },
    async exists(path) {
      return saves.has(path);
    },
    async removeQuiet(path) {
      saves.delete(path);
    },
    async listFiles() {
      return [...saves.keys()];
    },
  };
};

const sha = (buf: Buffer): string =>
  createHash("sha256").update(buf).digest("hex");

const remoteOk = (bytes: Buffer): PdfTempRemote => ({
  async sizeOf() {
    return { ok: true, size: bytes.length };
  },
  async readPage(_serverId, _path, position, length) {
    return {
      ok: true,
      buf: Buffer.from(bytes.subarray(position, position + length)),
      bytes: Math.min(length, bytes.length - position),
    };
  },
});

describe("the pull: one server PDF → one content-hash temp copy", () => {
  it("names the copy by the CONTENT hash and answers its file url", async () => {
    const bytes = Buffer.from("pdf-bytes-one");
    const fs = fakeFs();
    const service = createPdfTempService({
      dir: () => "/ud/cache/pdf",
      fs,
      remote: remoteOk(bytes),
      hash: sha,
    });
    const res = await service.open("srv-acme", "/srv/work/report.pdf");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bytes).toBe(bytes.length);
    expect(res.cached).toBe(false);
    const finalPath = `/ud/cache/pdf/${sha(bytes)}.pdf`;
    expect(fs.saves.get(finalPath)).toEqual(bytes);
    expect(res.fileUrl).toBe(pdfFileUrlOf(finalPath));
    // staging is consumed — no stray files around the cache
    expect([...fs.saves.keys()]).toEqual([finalPath]);
  });

  it("a second open of identical bytes re-uses the cached copy (no re-pull)", async () => {
    const bytes = Buffer.from("pdf-bytes-one");
    const pulls = vi.fn();
    const pull: PdfTempRemote = {
      ...remoteOk(bytes),
      readPage(...args: Parameters<PdfTempRemote["readPage"]>) {
        pulls(args[2]); // record only the position
        return remoteOk(bytes).readPage(...args);
      },
    };
    const fs = fakeFs();
    const service = createPdfTempService({
      dir: () => "/ud",
      fs,
      remote: pull,
      hash: sha,
    });
    const first = await service.open("srv-acme", "/srv/report.pdf");
    const second = await service.open("srv-acme", "/srv/report.pdf");
    expect(first.ok && first.cached).toBe(false);
    expect(second.ok && second.cached).toBe(true);
    expect(pulls).toHaveBeenCalledTimes(1);
  });

  it("zero-byte pdfs land the empty copy rather than failing", async () => {
    const fs = fakeFs();
    const service = createPdfTempService({
      dir: () => "/ud",
      fs,
      remote: remoteOk(Buffer.alloc(0)),
      hash: sha,
    });
    const res = await service.open("srv-acme", "/srv/empty.pdf");
    expect(res.ok).toBe(true);
    expect(res.ok && res.bytes).toBe(0);
  });
});

describe("the in-band refusals", () => {
  it("refuses over the 20MiB cap BEFORE any read moves, with the tooLarge crumb", async () => {
    const readPage = vi.fn();
    const service = createPdfTempService({
      dir: () => "/ud",
      fs: fakeFs(),
      remote: {
        async sizeOf() {
          return { ok: true, size: 21 * 1024 * 1024 };
        },
        readPage: readPage as unknown as PdfTempRemote["readPage"],
      },
      hash: sha,
    });
    const res = await service.open("srv-acme", "/srv/big.pdf");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.tooLarge).toBe(true);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("carries the not-found crumb from the remote stat", async () => {
    const service = createPdfTempService({
      dir: () => "/ud",
      fs: fakeFs(),
      remote: {
        async sizeOf() {
          return { ok: false, message: "no such file", notFound: true };
        },
        readPage: async () => ({ ok: false, message: "unreached" }),
      },
      hash: sha,
    });
    const res = await service.open("srv-acme", "/srv/gone.pdf");
    expect(res.ok).toBe(false);
    expect(res.ok ? false : res.notFound).toBe(true);
  });

  it("cleans the staging file when a mid-pull page fails", async () => {
    const fs = fakeFs();
    const service = createPdfTempService({
      dir: () => "/ud",
      fs,
      remote: {
        async sizeOf() {
          return { ok: true, size: 1000 };
        },
        async readPage(_serverId, _path, position) {
          return position > 0
            ? { ok: false, message: "socket died" }
            : { ok: true, buf: Buffer.alloc(0), bytes: 256 };
        },
      },
      hash: sha,
    });
    const res = await service.open("srv-acme", "/srv/x.pdf");
    expect(res.ok).toBe(false);
    expect([...fs.saves.keys()]).toEqual([]); // nothing staged or cached
  });

  it("never rejects, whatever the shape throws", async () => {
    const service = createPdfTempService({
      dir: () => {
        throw new Error("composition bug");
      },
      fs: fakeFs(),
      remote: remoteOk(Buffer.from("pdf")),
      hash: sha,
    });
    await expect(service.open("srv-acme", "/srv/x.pdf")).resolves.toMatchObject(
      {
        ok: false,
      },
    );
  });
});

describe("the will-quit sweep", () => {
  it("removes every cached copy in the dir (best-effort when empty/missing)", async () => {
    const bytes = Buffer.from("pdf-bytes-one");
    const fs = fakeFs();
    const service = createPdfTempService({
      dir: () => "/ud/cache/pdf",
      fs,
      remote: remoteOk(bytes),
      hash: sha,
    });
    await service.open("srv-acme", "/srv/report.pdf");
    expect([...fs.saves.keys()].length).toBe(1);
    await service.sweep();
    expect([...fs.saves.keys()]).toEqual([]);

    // a vanished dir answers null → the sweep is a no-op, not a rejection
    const bare = fakeFs();
    const gone = createPdfTempService({
      dir: () => "/ud/cache/pdf",
      fs: {
        ...bare,
        async listFiles() {
          return null;
        },
      },
      remote: remoteOk(bytes),
      hash: sha,
    });
    await expect(gone.sweep()).resolves.toBeUndefined();
  });
});

describe("pdfFileUrlOf (the temp copy's webview src)", () => {
  it("percent-encodes the awkward fragment characters and keeps `file:///` rooted", () => {
    expect(pdfFileUrlOf("/ud/cache/pdf/a b#1.pdf")).toBe(
      "file:///ud/cache/pdf/a%20b%231.pdf",
    );
    expect(pdfFileUrlOf("C:\\ud\\x.pdf")).toBe("file:///C:/ud/x.pdf");
  });
});
