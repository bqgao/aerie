import { beforeEach, describe, expect, it } from "vitest";
import {
  applyConflict,
  basenameRemoteish,
  compareEntries,
  humanizeBytes,
  humanizeMtime,
  joinRemoteFor,
  pathUpTo,
  pasteTargets,
  reduceSelection,
  renameSuggestion,
  SftpClipboard,
  sortEntries,
  type SelectionEdit,
} from "../../src/renderer/src/shell/sftp/sftp-model";
import {
  $sftpClipboard,
  $sftpServerId,
} from "../../src/renderer/src/shell/sftp/sftp-store";
import type { SftpEntry } from "@shared/sftp";

const entry = (
  name: string,
  kind: SftpEntry["kind"],
  size = 0,
  mtimeMs = 0,
): SftpEntry => ({ name, size, mtimeMs, kind });

beforeEach(() => {
  $sftpServerId.set(null);
  $sftpClipboard.set(null);
});

describe("sortEntries (dirs first both directions)", () => {
  const rows = [
    entry("zeta.txt", "file", 10, 2),
    entry("Beta", "dir", 0, 1),
    entry("alpha.txt", "file", 20, 3),
  ];

  it("name asc keeps dirs in front regardless of lexicographic order...", () => {
    expect(sortEntries(rows, "name", true).map((e) => e.name)).toEqual([
      "Beta",
      "alpha.txt",
      "zeta.txt",
    ]);
  });

  it("...and descending too (the dirs-first rule wins over the direction)", () => {
    expect(sortEntries(rows, "name", false).map((e) => e.name)).toEqual([
      "Beta",
      "zeta.txt",
      "alpha.txt",
    ]);
  });

  it("size and mtime sorts break ties by name", () => {
    const bySize = sortEntries(
      rows.filter((r) => r.kind === "file"),
      "size",
      false,
    );
    expect(bySize.map((e) => e.name)).toEqual(["alpha.txt", "zeta.txt"]);
    // Dir rank DOMINATES both directions: file-vs-dir keeps the dir ahead.
    expect(
      compareEntries(entry("b", "file"), entry("a", "dir"), "name", -1),
    ).toBe(1);
    expect(
      compareEntries(entry("a", "dir"), entry("b", "file"), "name", 1),
    ).toBe(-1);
  });
});

describe("reduceSelection (⌘/Shift semantics over display order)", () => {
  const rows = ["a", "b", "c", "d", "e"];

  it("plain click replaces; toggle flips one; clears empties", () => {
    const run = (
      state: ReadonlySet<string>,
      edit: SelectionEdit,
    ): ReadonlySet<string> => reduceSelection(state, rows, edit);
    expect(run(new Set(), { op: "set-one", name: "c" })).toEqual(
      new Set(["c"]),
    );
    const one = new Set(["c"]);
    expect(run(one, { op: "toggle", name: "c" })).toEqual(new Set());
    expect(run(one, { op: "toggle", name: "d" })).toEqual(new Set(["c", "d"]));
    expect(run(new Set(["a", "c", "e"]), { op: "clear" })).toEqual(new Set());
  });

  it("range fills the contiguous slice between anchor and hit in EITHER direction", () => {
    let state = reduceSelection(new Set(), rows, { op: "set-one", name: "b" });
    state = reduceSelection(state, rows, { op: "range", from: "b", to: "d" });
    expect([...state].sort()).toEqual(["b", "c", "d"]);
    // Reverse anchor: clicking upward ranges through the same slice
    const up = reduceSelection(
      reduceSelection(new Set(), rows, { op: "set-one", name: "d" }),
      rows,
      { op: "range", from: "d", to: "b" },
    );
    expect([...up].sort()).toEqual(["b", "c", "d"]);
  });

  it("⌘A selects everything displayed; anchors missing from the list degrade to the hit", () => {
    expect([...reduceSelection(new Set(), rows, { op: "all" })]).toEqual(rows);
    expect(
      reduceSelection(new Set(), rows, { op: "range", from: "ghost", to: "b" }),
    ).toEqual(new Set(["b"]));
  });
});

describe("pasteTargets (copy keeps; cut clears; conflicts split)", () => {
  it("builds pairs; a name that exists in the target splits into conflicts", () => {
    const clipboard: SftpClipboard = {
      mode: "copy",
      paths: ["/src/a.txt", "/src/b.txt"],
    };
    const plan = pasteTargets(clipboard, "/dst", new Set(["b.txt"]));
    expect(plan.cleared).toBe(false);
    expect(plan.pairs).toEqual([{ from: "/src/a.txt", to: "/dst/a.txt" }]);
    expect(plan.conflicts).toEqual([{ from: "/src/b.txt", to: "/dst/b.txt" }]);
  });

  it("cut flags one-shot clearing; root target keeps the leading slash", () => {
    const cut: SftpClipboard = { mode: "cut", paths: ["/src/x"] };
    const plan = pasteTargets(cut, "/", new Set());
    expect(plan.cleared).toBe(true);
    expect(plan.pairs).toEqual([{ from: "/src/x", to: "/x" }]);
  });

  it("empty clipboard is a no-op (no pairs, no clear, no conflict)", () => {
    const plan = pasteTargets(null, "/dst", new Set());
    expect(plan.cleared).toBe(false);
    expect(plan.pairs).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });
});

describe("applyConflict / renameSuggestion", () => {
  it("overwrite keeps the target, skip drops, rename suffixes", () => {
    const taken = new Set(["file.txt", "file-2.txt"]);
    expect(
      applyConflict("file.txt", "/x/file.txt", "overwrite", (c) =>
        taken.has(c),
      ),
    ).toEqual({
      action: "overwrite",
      target: "/x/file.txt",
    });
    expect(
      applyConflict("file.txt", "/x/file.txt", "skip", (c) => taken.has(c))
        .action,
    ).toBe("skip");
    expect(
      applyConflict("file.txt", "/x/file.txt", "rename", (c) => taken.has(c)),
    ).toEqual({
      action: "rename",
      target: "/x/file-3.txt",
    });
  });

  it("renameSuggestion is the conflict candidate helper (dotfile-safe)", () => {
    const taken = new Set([".profile"]);
    expect(renameSuggestion(".profile", (c) => taken.has(c))).toBe(
      ".profile-2",
    );
  });
});

describe("humanizers + breadcrumb math", () => {
  it("bytes humanize across the unit ladder", () => {
    expect(humanizeBytes(0)).toBe("0 B");
    expect(humanizeBytes(999)).toBe("999 B");
    expect(humanizeBytes(1000)).toBe("1 KB");
    expect(humanizeBytes(4200)).toBe("4.2 KB");
    expect(humanizeBytes(1_500_000)).toBe("1.5 MB");
    expect(humanizeBytes(-1)).toBe("—");
  });

  it("mtime humanizes to the locale (non-crash)", () => {
    const shown = humanizeMtime(1751500000_000);
    expect(shown.length).toBeGreaterThan(3);
    expect(humanizeMtime(0)).toBe("—");
  });

  it("basename works across separators and pathsUpTo walks the segments", () => {
    expect(basenameRemoteish("/a/b/c.txt")).toBe("c.txt");
    expect(basenameRemoteish("/plain.txt")).toBe("plain.txt");
    expect(pathUpTo("/bqgao/Work/x", 1)).toBe("/bqgao/Work");
    expect(pathUpTo("/", 0)).toBe("/");
    expect(joinRemoteFor("/a", "b")).toBe("/a/b");
  });
});
