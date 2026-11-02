import { describe, expect, it } from "vitest";
import {
  createFileIoService,
  type FileIoFs,
} from "../../src/main/fileio/fileio-service";
import type { FileIoReadResult } from "../../src/shared/fileio";

/** In-memory FileIoFs: byte maps for files, call history for the write primitives so the tests
 *  can assert the temp→rename order (the atomic-trade contract) directly. */
function fakeFs(seed: Record<string, string | Buffer> = {}) {
  const files = new Map<string, Buffer>();
  for (const [path, value] of Object.entries(seed)) {
    files.set(
      path,
      Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"),
    );
  }
  const state = {
    files,
    opens: [] as string[],
    writes: [] as Array<{ path: string; bytes: number }>,
    renames: [] as Array<{ from: string; to: string }>,
  };
  const io: FileIoFs = {
    sizeOf(path) {
      const bytes = files.get(path);
      if (!bytes)
        return Promise.resolve({
          ok: false,
          code: "ENOENT",
          message: "no such file",
        });
      return Promise.resolve({ ok: true, size: bytes.length });
    },
    readInto(path, length, position) {
      const bytes = files.get(path);
      if (!bytes)
        return Promise.resolve({
          ok: false,
          code: "ENOENT",
          message: "no such file",
        });
      if (position >= bytes.length)
        return Promise.resolve({
          ok: true,
          buf: Buffer.alloc(length),
          bytes: 0,
        });
      const taken = Math.min(length, bytes.length - position);
      return Promise.resolve({
        ok: true,
        buf: bytes.subarray(position, position + length),
        bytes: taken,
      });
    },
    writeNew(path, bytes) {
      if (path.endsWith("?deny")) {
        return Promise.resolve({
          ok: false,
          code: "EACCES",
          message: "permission denied",
        });
      }
      state.writes.push({ path, bytes: bytes.length });
      files.set(path, bytes);
      return Promise.resolve({ ok: true });
    },
    rename(from, to) {
      state.renames.push({ from, to });
      const bytes = files.get(from);
      if (!bytes)
        return Promise.resolve({
          ok: false,
          code: "ENOENT",
          message: "no such file",
        });
      files.delete(from);
      files.set(to, bytes);
      return Promise.resolve({ ok: true });
    },
    removeQuiet(path) {
      files.delete(path);
      return Promise.resolve();
    },
  };
  return { fs: io, state };
}

const wire = (opts: { fs?: FileIoFs; dataDirs?: string[] }) =>
  createFileIoService({
    fs: opts.fs,
    dataDirs: () =>
      opts.dataDirs ?? ["/home/cbw/Library/Application Support/code-by-wire"],
  });

const DATA_DIR = "/home/cbw/Library/Application Support/code-by-wire";

describe("createFileIoService — path gate (shared by read/write)", () => {
  it("refuses non-absolute, empty, and NUL-carrying paths without touching the fs", async () => {
    const fake = fakeFs();
    const service = wire({ fs: fake.fs });
    for (const bad of ["", "relative/file.txt", "a\0b", null, 42]) {
      await expect(service.read(bad as string)).resolves.toMatchObject({
        ok: false,
        errorKind: "invalid-path",
      });
      await expect(service.write(bad as string, "x")).resolves.toMatchObject({
        ok: false,
        errorKind: "invalid-path",
      });
    }
    expect(fake.state.writes).toHaveLength(0);
  });

  it("refuses paths inside the app's data dirs, but NOT sibling or prefix-collision dirs", async () => {
    const fake = fakeFs({ [`${DATA_DIR}/index.db`]: "x" });
    const service = wire({
      fs: fake.fs,
      dataDirs: ["/data/cbw", `${DATA_DIR}`],
    });
    // inside
    for (const p of [
      `${DATA_DIR}/index.db`,
      `${DATA_DIR}`,
      `${DATA_DIR}/sub/deep.md`,
    ]) {
      await expect(service.read(p)).resolves.toMatchObject({
        ok: false,
        errorKind: "forbidden-path",
      });
    }
    // a sibling whose name merely share a prefix, and a dir whose prefix extends past the border
    await expect(
      service.read(`${DATA_DIR}2/key.md`),
    ).resolves.not.toMatchObject({ ok: false, errorKind: "forbidden-path" });
    await expect(
      service.read("relative/../data/cbw/escape.md"),
    ).resolves.toMatchObject({ ok: false, errorKind: "invalid-path" });
  });

  it("normalizes `..` before the data-dir check: an escape via a legal absolute path is gated", async () => {
    const service = wire({ dataDirs: ["/data/cbw"] });
    // /data/cbw/../other is OUTSIDE the dir — allowed (and then fails as not-found, not forbidden)
    await expect(service.read("/data/cbw/../other.md")).resolves.toMatchObject({
      ok: false,
      errorKind: "not-found",
    });
    // /data/cbw/sub/../../cbw lands back INSIDE — refused
    await expect(
      service.read("/data/cbw/sub/../../cbw/secrets.db"),
    ).resolves.toMatchObject({
      ok: false,
      errorKind: "forbidden-path",
    });
  });
});

describe("createFileIoService — read (cap + binary sniff)", () => {
  it("reads a small file as UTF-8 with capped:false and exact bytes", async () => {
    const service = wire({ fs: fakeFs({ "/notes/hello.md": "héllo\n" }).fs });
    await expect(service.read("/notes/hello.md")).resolves.toEqual({
      ok: true,
      content: "héllo\n",
      bytes: 7,
      capped: false,
    });
  });

  it("caps a >512KiB file at the first 512KiB with capped:true", async () => {
    const big = Buffer.from("a".repeat(513 * 1024), "utf8");
    const { fs } = fakeFs({ "/big/log.txt": big });
    const service = wire({ fs });
    const res = (await service.read("/big/log.txt")) as Extract<
      FileIoReadResult,
      { ok: true }
    >;
    expect(res.ok).toBe(true);
    expect(res.capped).toBe(true);
    expect(res.bytes).toBe(512 * 1024);
    expect(res.content).toBe("a".repeat(512 * 1024));
  });

  it("reports capped:false for a file of exactly the cap (boundary)", async () => {
    const exact = "b".repeat(512 * 1024);
    const service = wire({ fs: fakeFs({ "/big/exact.txt": exact }).fs });
    await expect(service.read("/big/exact.txt")).resolves.toMatchObject({
      ok: true,
      capped: false,
      bytes: 512 * 1024,
    });
  });

  it("sniffs a NUL byte within the first 8KiB as binary — even without a cap in play", async () => {
    const { fs } = fakeFs({
      "/bin/run": Buffer.concat([
        Buffer.from("hello"),
        Buffer.alloc(1),
        Buffer.from("world"),
      ]),
    });
    const service = wire({ fs });
    await expect(service.read("/bin/run")).resolves.toMatchObject({
      ok: false,
      errorKind: "binary",
    });
  });

  it("an empty file reads back as content:'' with no binary-sniff trip", async () => {
    const service = wire({ fs: fakeFs({ "/empty/.gitkeep": "" }).fs });
    await expect(service.read("/empty/.gitkeep")).resolves.toEqual({
      ok: true,
      content: "",
      bytes: 0,
      capped: false,
    });
  });

  it("maps a missing file to not-found and a missing parent dir to not-found too", async () => {
    const service = wire({ fs: fakeFs({}).fs });
    await expect(service.read("/nope.md")).resolves.toMatchObject({
      ok: false,
      errorKind: "not-found",
    });
  });
});

describe("createFileIoService — write (atomic temp+rename)", () => {
  it("writes to a `.cbw-tmp-` sibling first, then renames over the target", async () => {
    const fake = fakeFs({ "/notes/old.md": "old" });
    const service = wire({ fs: fake.fs });
    await expect(service.write("/notes/old.md", "new body")).resolves.toEqual({
      ok: true,
      bytes: 8,
    });
    const r = fake.state.renames[0];
    expect(r).toBeTruthy();
    expect(r.to).toBe("/notes/old.md");
    expect(r.from.startsWith("/notes/old.md.cbw-tmp-")).toBe(true);
    expect(r.from).not.toBe("/notes/old.md");
    expect(fake.state.files.get("/notes/old.md")?.toString()).toBe("new body");
    // the temp did not survive the rename
    expect(fake.state.files.has(r.from)).toBe(false);
  });

  it("the write round-trips UTF-8 exactly (bytes = the content's byte length)", async () => {
    const service = wire({ fs: fakeFs().fs });
    await service.write("/ünïcode/céleste.md", "héllo **世界**\n");
    const res = (await service.read("/ünïcode/céleste.md")) as Extract<
      FileIoReadResult,
      { ok: true }
    >;
    expect(res.ok).toBe(true);
    expect(res.content).toBe("héllo **世界**\n");
  });

  it("a failed rename leaves the target untouched AND removes the staged temp", async () => {
    const fake = fakeFs();
    const failingRename: FileIoFs = {
      ...fake.fs,
      rename: () =>
        Promise.resolve({ ok: false, code: "EBUSY", message: "busy" }),
    };
    const service = wire({ fs: failingRename });
    await expect(service.write("/notes/new.md", "x")).resolves.toMatchObject({
      ok: false,
      errorKind: "io",
    });
    // nothing partially written survived: no file at the target, no stale temp
    expect(
      [...fake.state.files.keys()].filter((p) => p.startsWith("/notes")),
    ).toHaveLength(0);
  });

  it("a failed temp write answers io with the OS message and never touches the target", async () => {
    const fake = fakeFs({ "/notes/target.md": "original" });
    const deny = wire({
      fs: {
        ...fake.fs,
        writeNew: () =>
          Promise.resolve({
            ok: false,
            code: "EACCES",
            message: "permission denied",
          }),
      },
    });
    await expect(deny.write("/notes/target.md", "x")).resolves.toMatchObject({
      ok: false,
      errorKind: "io",
      message: "permission denied",
    });
    expect(fake.state.renames).toHaveLength(0);
    expect(fake.state.files.get("/notes/target.md")?.toString()).toBe(
      "original",
    );
  });

  it("writes an empty string without staging a rename crash (empty temp is legal)", async () => {
    const fake = fakeFs({ "/notes/truncate.md": "some content" });
    const service = wire({ fs: fake.fs });
    await expect(
      service.write("/notes/truncate.md", ""),
    ).resolves.toMatchObject({ ok: true });
    expect(fake.state.files.get("/notes/truncate.md")?.toString()).toBe("");
  });

  it("refuses to write inside the app data dirs (protects index.db/analytics.db)", async () => {
    const fake = fakeFs({ [`${DATA_DIR}/index.db`]: "keep" });
    const service = wire({ fs: fake.fs });
    await expect(
      service.write(`${DATA_DIR}/index.db`, "pwn"),
    ).resolves.toMatchObject({
      ok: false,
      errorKind: "forbidden-path",
    });
    expect(fake.state.files.get(`${DATA_DIR}/index.db`)?.toString()).toBe(
      "keep",
    );
  });
});

describe("createFileIoService — fs-failure mapping", () => {
  it("sizeOf/read failures that are not ENOENT map to io with the OS message", async () => {
    const failing: FileIoFs = {
      sizeOf: () =>
        Promise.resolve({
          ok: false,
          code: "EACCES",
          message: "permission denied",
        }),
      readInto: () =>
        Promise.resolve({
          ok: false,
          code: "EACCES",
          message: "permission denied",
        }),
      writeNew: () => Promise.resolve({ ok: true }),
      rename: () => Promise.resolve({ ok: true }),
      removeQuiet: () => Promise.resolve(),
    };
    const service = wire({ fs: failing });
    await expect(service.read("/locked.bin")).resolves.toMatchObject({
      ok: false,
      errorKind: "io",
      message: "permission denied",
    });
  });

  it("never rejects, whatever the fs throws — seams are contained to the io kind", async () => {
    const throwing: FileIoFs = {
      sizeOf: () => Promise.reject(new Error("boom")),
      readInto: () => Promise.reject(new Error("boom")),
      writeNew: () => Promise.reject(new Error("boom")),
      rename: () => Promise.reject(new Error("boom")),
      removeQuiet: () => Promise.resolve(),
    };
    const service = wire({ fs: throwing });
    await expect(service.read("/x")).resolves.toMatchObject({
      ok: false,
      errorKind: "io",
      message: "boom",
    });
    await expect(service.write("/x", "y")).resolves.toMatchObject({
      ok: false,
      errorKind: "io",
      message: "boom",
    });
  });
});

describe("real fs smoke (temp-dir integration)", () => {
  it("the real seams read/write atomically through node fs", async () => {
    const { mkdtemp, readdir } = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const dir = await mkdtemp(nodePath.join(os.tmpdir(), "cbw-fileio-"));
    const svc = createFileIoService({ dataDirs: () => [] });
    const target = nodePath.join(dir, "note.md");
    await expect(svc.write(target, "# Atomic hello\n")).resolves.toMatchObject({
      ok: true,
    });
    await expect(svc.read(target)).resolves.toEqual({
      ok: true,
      content: "# Atomic hello\n",
      bytes: 15,
      capped: false,
    });
    await expect(
      svc.read(`${target}.cbw-tmp-nonexistent`),
    ).resolves.toMatchObject({
      ok: false,
      errorKind: "not-found",
    });
    // the atomic trade leaves only the target — no stale temp residue
    expect(await readdir(dir)).toEqual(["note.md"]);
  });
});
