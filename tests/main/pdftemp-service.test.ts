/**
 * The server-PDF temp cache (pass I-b) with FAKE seams: temp naming is content-addressed
 * (sha256 → `<hash>.pdf`), the 20MiB cap refuses in band before any chunk moves, the staging
 * file is cleaned on every failure path, a cached copy short-circuits the remote pull, the
 * `file://` URL is percent-encoded, and the sweep empties (only) the cache dir. No webview
 * DOM here; the `pdfTemp:*` handler is a thin passthrough (fileio-ipc grammar, tested for
 * the registration shape in its own family).
 */
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createPdfTempService,
  pdfFileUrlOf,
  type PdfTempFs,
  type PdfTempRemote,
} from "../../src/main/fileio/pdftemp-service";

/** In-memory PdfTempFs: directories are implicit (a created dir just records files). */
const fakeFs = (): PdfTempFs & { saves: Map<string, Buffer> } => {
  const saves = new Map<string, Buffer>();
  return {
    saves,
    mkdirp() {
      return Promise.resolve();
    },
    writeNew(path, bytes) {
      saves.set(path, Buffer.from(bytes));
      return Promise.resolve({ ok: true });
    },
    rename(from, to) {
      const buf = saves.get(from);
      if (buf === undefined)
        return Promise.resolve({ ok: false, message: "ENOENT: " + from });
      saves.delete(from);
      saves.set(to, buf);
      return Promise.resolve({ ok: true });
    },
    exists(path) {
      return Promise.resolve(saves.has(path));
    },
    removeQuiet(path) {
      saves.delete(path);
      return Promise.resolve();
    },
    listFiles() {
      return Promise.resolve([...saves.keys()]);
    },
  };
};

const sha = (buf: Buffer): string =>
  createHash("sha256").update(buf).digest("hex");

const remoteOk = (bytes: Buffer): PdfTempRemote => ({
  sizeOf() {
    return Promise.resolve({ ok: true, size: bytes.length });
  },
  readPage(_serverId, _path, position, length) {
    return Promise.resolve({
      ok: true,
      buf: Buffer.from(bytes.subarray(position, position + length)),
      bytes: Math.min(length, bytes.length - position),
    });
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
    const finalPath = join("/ud/cache/pdf", `${sha(bytes)}.pdf`);
    expect(fs.saves.get(finalPath)).toEqual(bytes);
    expect(res.fileUrl).toBe(pdfFileUrlOf(finalPath));
    // staging is consumed — no stray files around the cache
    expect([...fs.saves.keys()]).toEqual([finalPath]);
  });

  it("a re-open of the same path answers the memoized copy (no re-pull)", async () => {
    const bytes = Buffer.from("pdf-bytes-one");
    const fallback = remoteOk(bytes);
    const pulls = vi.fn((...args: Parameters<PdfTempRemote["readPage"]>) =>
      fallback.readPage(...args),
    );
    const fs = fakeFs();
    const service = createPdfTempService({
      dir: () => "/ud",
      fs,
      remote: { ...fallback, readPage: pulls },
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
    const readPage = vi.fn(() =>
      Promise.resolve({ ok: true, buf: Buffer.alloc(0), bytes: 0 }),
    );
    const service = createPdfTempService({
      dir: () => "/ud",
      fs: fakeFs(),
      remote: {
        sizeOf() {
          return Promise.resolve({ ok: true, size: 21 * 1024 * 1024 });
        },
        readPage: () =>
          Promise.resolve({ ok: true, buf: Buffer.alloc(0), bytes: 0 }),
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
        sizeOf() {
          return Promise.resolve({
            ok: false,
            message: "no such file",
            notFound: true,
          });
        },
        readPage() {
          return Promise.resolve({ ok: false, message: "unreached" });
        },
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
        sizeOf() {
          return Promise.resolve({ ok: true, size: 1000 });
        },
        readPage(_serverId, _path, position) {
          return Promise.resolve(
            position > 0
              ? { ok: false, message: "socket died" }
              : { ok: true, buf: Buffer.alloc(0), bytes: 256 },
          );
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
  it("removes every cached copy in the dir (no-op when the dir is gone)", async () => {
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
    const gone = createPdfTempService({
      dir: () => "/ud/cache/pdf",
      fs: {
        ...fakeFs(),
        listFiles() {
          return Promise.resolve(null);
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
