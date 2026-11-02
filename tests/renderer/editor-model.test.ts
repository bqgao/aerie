/**
 * The Editor pane's pure rules (pass I-a) under jsdom: tab identity/focus, the open/close/
 * activate reducer, dirty math, the Markdown mode toggle's draft preservation, the read-only
 * matrix, and the cursor readout. Store wiring (atoms) is exercised where it buys confidence.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyRead,
  applySaved,
  badgeText,
  basenameEditorish,
  canPreview,
  cursorInfo,
  isDirty,
  isMarkdownName,
  newEditorTab,
  readOnlyReason,
  reduceTabs,
  serverOriginOf,
  setDraft,
  setMode,
  tabIdOf,
  type EditorOrigin,
  type EditorTab,
} from "../../src/renderer/src/shell/editor/editor-model";
import {
  $editorActiveId,
  $editorTabs,
  applyTabRead,
  closeEditorTab,
  editorTabOf,
  openEditorTab,
  setTabDraft,
} from "../../src/renderer/src/shell/editor/editor-store";

const local = (path: string): EditorOrigin => ({ kind: "local", path });
const server = (name = "srv-1", path = "/srv/a.txt"): EditorOrigin => ({
  kind: "server",
  serverId: name,
  serverName: `Server ${name}`,
  path,
  opencode: false,
});

const read = (
  content: string,
  opts: { bytes?: number; capped?: boolean } = {},
) => ({
  ok: true as const,
  kind: "text" as const,
  content,
  bytes: opts.bytes ?? Buffer.byteLength(content),
  capped: opts.capped ?? false,
});

const open = (origin: EditorOrigin) =>
  reduceTabs([], null, { op: "open", origin });
const loaded = (origin: EditorOrigin, content: string): EditorTab =>
  applyRead(newEditorTab(origin), read(content));

describe("tab identity", () => {
  it("one tab per file identity: local paths and server files never collide", () => {
    expect(tabIdOf(local("/a/b.md"))).toBe("local:/a/b.md");
    expect(tabIdOf(server())).toBe("srv:srv-1:/srv/a.txt");
    expect(tabIdOf(server("x", "/a/b.md"))).not.toBe(tabIdOf(local("/a/b.md")));
  });

  it("re-opening an existing identity focuses the tab instead of duplicating it", () => {
    const first = reduceTabs([], null, { op: "open", origin: local("/a.md") });
    const again = reduceTabs(first.tabs, first.activeId, {
      op: "open",
      origin: local("/a.md"),
    });
    expect(again.tabs).toHaveLength(1);
    expect(again.activeId).toBe(first.activeId);
    // The focused record is preserved (its draft state wasn't reset):
    expect(again.tabs[0]).toBe(first.tabs[0]);
  });

  it("a different server's same-named path is a distinct tab", () => {
    const one = open(server("a", "/x/main.py"));
    const two = reduceTabs(one.tabs, one.activeId, {
      op: "open",
      origin: server("b", "/x/main.py"),
    });
    expect(two.tabs).toHaveLength(2);
  });

  it("tab labels are basenames with either separator; .md/.markdown detect as markdown", () => {
    expect(basenameEditorish("/a/long/name.md")).toBe("name.md");
    expect(basenameEditorish("C:\\dir\\file.markdown")).toBe("file.markdown");
    expect(isMarkdownName("notes.md")).toBe(true);
    expect(isMarkdownName("notes.MD")).toBe(true);
    expect(isMarkdownName("notes.markdown")).toBe(true);
    expect(isMarkdownName("readme.mdx")).toBe(false);
    expect(isMarkdownName("main.py")).toBe(false);
  });
});

describe("tab reducer — close/activate", () => {
  it("closing the active tab selects its right neighbor, else the last tab left", () => {
    const a = local("/a.txt");
    const b = local("/b.txt");
    const c = local("/c.txt");
    // Build the three-tab family open-by-open:
    let opened = open(a);
    for (const origin of [b, c]) {
      opened = reduceTabs(opened.tabs, opened.activeId, { op: "open", origin });
    }
    expect(opened.activeId).toBe(tabIdOf(c));
    // close a (not active) → selection stays on c:
    const closedA = reduceTabs(opened.tabs, opened.activeId, {
      op: "close",
      id: tabIdOf(a),
    });
    expect(closedA.activeId).toBe(tabIdOf(c));
    // close c (active, last) → falls back to b (the left neighbor):
    const closedC = reduceTabs(closedA.tabs, closedA.activeId, {
      op: "close",
      id: tabIdOf(c),
    });
    expect(closedC.activeId).toBe(tabIdOf(b));
    // close the ONLY remaining tab → empty state:
    const closedB = reduceTabs(closedC.tabs, closedC.activeId, {
      op: "close",
      id: tabIdOf(b),
    });
    expect(closedB.tabs).toHaveLength(0);
    expect(closedB.activeId).toBe(null);
  });

  it("closing an already-removed tab is a no-op", () => {
    const state = open(local("/a.md"));
    const again = reduceTabs(state.tabs, state.activeId, {
      op: "close",
      id: "local:/nope.md",
    });
    expect(again.tabs).toHaveLength(1);
    expect(again.activeId).toBe(state.activeId);
  });

  it("activate switches the selection without touching the list", () => {
    const one = open(local("/a.md"));
    const two = reduceTabs(one.tabs, one.activeId, {
      op: "open",
      origin: local("/b.md"),
    });
    const active = reduceTabs(two.tabs, two.activeId, {
      op: "activate",
      id: tabIdOf(local("/a.md")),
    });
    expect(active.activeId).toBe(tabIdOf(local("/a.md")));
    expect(active.tabs).toHaveLength(2);
  });
});

describe("dirty math", () => {
  it("loading tabs are never dirty; a ready tab is dirty iff draft !== snapshot", () => {
    const tab = newEditorTab(local("/a.md"));
    expect(isDirty(tab)).toBe(false);
    const ready = applyRead(tab, read("hello"));
    expect(isDirty(ready)).toBe(false);
    expect(isDirty(setDraft(ready, "hello!"))).toBe(true);
    expect(isDirty(setDraft(ready, "hello"))).toBe(false);
  });

  it("a save re-bases the snapshot (dirty clears); a failed save keeps everything dirty", () => {
    const ready = applyRead(newEditorTab(local("/a.md")), read("hello"));
    const edited = setDraft(ready, "hello!");
    const saved = applySaved(edited, { ok: true });
    expect(isDirty(saved)).toBe(false);
    expect(saved.snapshot).toBe("hello!");
    // The failed save leaves the draft pending and parks the message:
    const failed = applySaved(setDraft(saved, "hello!!"), {
      ok: false,
      message: "disk full",
    });
    expect(isDirty(failed)).toBe(true);
    expect(failed.error).toBe("disk full");
  });

  it("an error/binary read is never dirty (nothing to edit)", () => {
    const failed = applyRead(newEditorTab(local("/a.bin")), {
      ok: false,
      binary: true,
      message: "binary",
    });
    expect(failed.status).toBe("binary");
    expect(isDirty(failed)).toBe(false);
    const errored = applyRead(newEditorTab(local("/a.txt")), {
      ok: false,
      message: "not found",
    });
    expect(errored.status).toBe("error");
    expect(errored.error).toBe("not found");
    expect(isDirty(errored)).toBe(false);
  });
});

describe("capped read-only state", () => {
  it("a capped tab is ready but renders read-only; an uncapped tab is editable", () => {
    const capped = applyRead(
      newEditorTab(local("/big.log")),
      read("x", {
        bytes: 512 * 1024,
        capped: true,
      }),
    );
    expect(capped.status).toBe("ready");
    expect(capped.capped).toBe(true);
    expect(readOnlyReason(capped)).toBe("capped");
    const plain = applyRead(newEditorTab(local("/small.txt")), read("hi"));
    expect(readOnlyReason(plain)).toBe(null);
  });
});

describe("Markdown mode toggle (draft preservation)", () => {
  it("edit ⇄ preview flips markdown-only, ready tabs, and never touches the draft", () => {
    const ready = loaded(local("/notes.md"), "# hello");
    const preview = setMode(ready, "preview");
    expect(preview.mode).toBe("preview");
    expect(preview.draft).toBe(ready.draft);
    expect(preview.snapshot).toBe(ready.snapshot);
    const backToEdit = setMode(preview, "edit");
    expect(backToEdit.mode).toBe("edit");
    expect(backToEdit.draft).toBe("# hello");
  });

  it("typing WHILE in preview mode keeps saving into the draft (state, not a remount)", () => {
    const preview = setMode(loaded(local("/notes.md"), "# hello"), "preview");
    const edited = setDraft(preview, "# hello\nmore");
    expect(setMode(edited, "edit").draft).toBe("# hello\nmore");
  });

  it("preview is unavailable for non-markdown, capped, or failed tabs — mode stays edit", () => {
    expect(canPreview(loaded(local("/main.py"), "print(1)"))).toBe(false);
    expect(setMode(loaded(local("/main.py"), "print(1)"), "preview").mode).toBe(
      "edit",
    );
    expect(
      canPreview(
        applyRead(
          newEditorTab(local("/big.md")),
          read("x", {
            bytes: 513 * 1024,
            capped: true,
          }),
        ),
      ),
    ).toBe(false);
    expect(
      canPreview(
        loaded(local("/gone.md"), "") &&
          applyRead(newEditorTab(local("/gone.md")), {
            ok: false,
            message: "missing",
          }),
      ),
    ).toBe(false);
  });

  it("a binary read resets mode to edit", () => {
    const preview = setMode(loaded(local("/x.md"), "a"), "preview");
    const readAgain = applyRead(preview, {
      ok: false,
      binary: true,
      message: "binary",
    });
    expect(readAgain.mode).toBe("edit");
  });
});

describe("cursorInfo (footer line:col)", () => {
  it("should compute 1-based line:col from the selection position", () => {
    const content = "alpha\nbeta\ngamma";
    expect(cursorInfo(content, 0)).toEqual({ line: 1, col: 1 });
    expect(cursorInfo(content, 2)).toEqual({ line: 1, col: 3 });
    expect(cursorInfo(content, 6)).toEqual({ line: 2, col: 1 });
    expect(cursorInfo(content, 13)).toEqual({ line: 3, col: 3 });
  });

  it("is defensive over out-of-range positions", () => {
    expect(cursorInfo("", 999)).toEqual({ line: 1, col: 1 });
    const content = "abc";
    expect(cursorInfo(content, -5)).toEqual({ line: 1, col: 1 });
    expect(cursorInfo(content, 999)).toEqual({ line: 1, col: 4 });
  });
});

describe("origin badges", () => {
  it("local shows the neutral label; server shows its name; opencode appends the product", () => {
    const tr = { local: "Local", server: "SSH", opencode: "opencode" };
    expect(badgeText(local("/a.md"), tr)).toBe("Local");
    expect(badgeText(server(), tr)).toBe("Server srv-1 SSH");
    expect(badgeText({ ...server(), opencode: true } as EditorOrigin, tr)).toBe(
      "Server srv-1 opencode",
    );
  });

  it("serverOriginOf stamps the opencode flag from the profile's own field", () => {
    const profile = {
      id: "p1",
      name: "Nas",
      opencode: { servePort: 4096, autoTunnel: true },
    };
    expect(serverOriginOf(profile as never, "/x")).toMatchObject({
      kind: "server",
      serverId: "p1",
      serverName: "Nas",
      opencode: true,
    });
    expect(
      serverOriginOf({ id: "p2", name: "Plain" } as never, "/x"),
    ).toMatchObject({ opencode: false });
  });
});

describe("the store (atoms + write paths)", () => {
  beforeEach(() => {
    $editorTabs.set([]);
    $editorActiveId.set(null);
  });

  it("open/read/edit round-trips and close splices with the neighbor rule", () => {
    openEditorTab(server("s", "/a.md"));
    const aId = $editorActiveId.get() as string;
    expect($editorTabs.get()).toHaveLength(1);
    applyTabRead(aId, read("draft one"));
    openEditorTab(local("/b.txt"));
    const bId = $editorActiveId.get() as string;
    applyTabRead(bId, read("draft two"));
    setTabDraft(bId, "draft two edited");
    expect(editorTabOf(bId)?.draft).toBe("draft two edited");
    expect(isDirty(editorTabOf(bId) as EditorTab)).toBe(true);
    // Re-open focuses instead of duplicating (and the draft survives):
    openEditorTab(server("s", "/a.md"));
    expect($editorTabs.get()).toHaveLength(2);
    expect($editorActiveId.get()).toBe(aId);
    // Close the ACTIVE one → falls back to the right neighbor's left... (b is active here)
    closeEditorTab(bId);
    expect($editorTabs.get()).toHaveLength(1);
    expect($editorActiveId.get()).toBe(aId);
    expect(editorTabOf(aId)?.draft).toBe("draft one");
  });
});
