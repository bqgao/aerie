import { describe, expect, it } from "vitest";
import {
  conflictRenameCandidate,
  joinRemote,
  normalizeRemotePath,
  remoteBasename,
  remoteDirname,
  remotePathSegments,
} from "../../src/shared/sftp-paths";

describe("normalizeRemotePath", () => {
  it("rejects NUL, empty, and whitespace-only input", () => {
    expect(normalizeRemotePath("a\0b")).toBeNull();
    expect(normalizeRemotePath("")).toBeNull();
    expect(normalizeRemotePath("   ")).toBeNull();
  });

  it("collapses duplicate slashes and dot segments, preserving absolute-ness", () => {
    expect(normalizeRemotePath("/a//b/./c")).toBe("/a/b/c");
    expect(normalizeRemotePath("a/b/../c")).toBe("a/c");
    expect(normalizeRemotePath("/a/b/../../c")).toBe("/c");
    expect(normalizeRemotePath("/")).toBe("/");
  });

  it("pops lexically but clamps at root", () => {
    expect(normalizeRemotePath("/../../.")).toBe("/");
  });
});

describe("joinRemote (the only child-name builder)", () => {
  it("rejects names carrying separators, NUL, or emptiness (no traversal smuggle)", () => {
    expect(joinRemote("/a", "../b")).toBeNull();
    expect(joinRemote("/a", "x/y")).toBeNull();
    expect(joinRemote("/a", "x\0y")).toBeNull();
    expect(joinRemote("/a", "")).toBeNull();
  });

  it("joins a bare name onto dir (root keeps single slash)", () => {
    expect(joinRemote("/a", "b.txt")).toBe("/a/b.txt");
    expect(joinRemote("/", "home")).toBe("/home");
  });
});

describe("basename/dirname/segments", () => {
  it("derives the bare name", () => {
    expect(remoteBasename("/a/b/c.txt")).toBe("c.txt");
    expect(remoteBasename("/")).toBe("/");
  });

  it("derives the parent (root for root children)", () => {
    expect(remoteDirname("/a/b")).toBe("/a");
    expect(remoteDirname("/a")).toBe("/");
    expect(remoteDirname("/")).toBe("/");
  });

  it("splits breadcrumb segments root-first", () => {
    expect(remotePathSegments("/bqgao/Work")).toEqual(["bqgao", "Work"]);
    expect(remotePathSegments("/")).toEqual([]);
    expect(remotePathSegments("/x//y/.")).toEqual(["x", "y"]);
  });
});

describe("conflictRenameCandidate (the name-2.ext suffix)", () => {
  it("suffixes before the extension; skips ether-collisions", () => {
    const taken = new Set(["x.txt", "x-2.txt"]);
    const name = conflictRenameCandidate("x.txt", (c) => taken.has(c));
    expect(name).toBe("x-3.txt");
  });

  it("dotfiles never split their ext", () => {
    const taken = new Set([".profile", ".profile-2"]);
    const name = conflictRenameCandidate(".profile", (c) => taken.has(c));
    expect(name).toBe(".profile-3");
  });

  it("un-adorned names suffix bare", () => {
    const taken = new Set(["Makefile", "Makefile-2"]);
    expect(conflictRenameCandidate("Makefile", (c) => taken.has(c))).toBe(
      "Makefile-3",
    );
  });
});
