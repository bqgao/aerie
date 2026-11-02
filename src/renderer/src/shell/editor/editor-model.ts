/**
 * Pure renderer-side logic for the Editor pane (pass I-a), kept lib-free and window-free so it
 * loads under both tsconfig passes and the jsdom/node test envs — the sftp-model split. The pane
 * component owns the React wiring and the actual I/O calls; this file owns the STATE RULES:
 * tab identity (re-opening an identity focuses the existing tab), the tab-list reducer
 * (open/close/activate with the rail's neighbor-selection rule), dirty math (snapshot vs
 * draft), the Markdown mode toggle (preserve the draft exactly — component state, not a
 * remount), cursor line:col, and the read-only matrix (capped ≥ binary); plus the origin badge
 * logic. Humanized bytes re-use the SFTP pane's humanizer rather than forking it.
 */
import type { ServerProfile } from "@shared/servers";

export type EditorOrigin =
  | { kind: "local"; path: string }
  | {
      kind: "server";
      serverId: string;
      /** The profile's display name at open time (the badge label; profiles can be renamed). */
      serverName: string;
      path: string;
      /** True when the hosting profile doubles as a remote opencode host (profile.opencode) —
       *  the badge says so; the file ops themselves are identical (any server file is editable). */
      opencode: boolean;
    };

export type EditorStatus = "loading" | "ready" | "pdf" | "binary" | "error";

export interface EditorTab {
  id: string;
  origin: EditorOrigin;
  name: string;
  status: EditorStatus;
  /** The user's working text while `ready`; identical to `snapshot` right after a load/save. */
  draft: string;
  /** The content at the last successful load OR save — the dirty baseline. */
  snapshot: string;
  bytes: number;
  /** True when the read hit the 512KiB cap — the tab renders read-only with a banner. */
  capped: boolean;
  /** PDF tabs only: the `file://` URL the <webview> viewer loads (the tab kind is visible in
   *  `status === "pdf"`; the URL survives applyRead for re-focusing the tab body). */
  pdfUrl: string | null;
  /** Markdown tabs only: Edit ⇄ Preview over the DRAFT. */
  mode: "edit" | "preview";
  /** The last failure's raw message (in-band; the footer shows it verbatim). */
  error: string | null;
}

/** One tab per file identity: `local:<abs path>` | `srv:<serverId>:<remote path>`. */
export function tabIdOf(origin: EditorOrigin): string {
  return origin.kind === "local"
    ? `local:${origin.path}`
    : `srv:${origin.serverId}:${origin.path}`;
}

/** The bare last segment of a path with either separator (the tab label). */
export function basenameEditorish(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

export function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

/** PDFs open the READ-ONLY webview viewer (route (a), zero deps): the binary refusal that
 *  still applies to other binaries never fires for .pdf — the tab kind routes by name. */
export function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** A `file://` URL for an absolute local path (the PDF tab's <webview> src — server PDFs get
 *  their URL from main's temp copy instead). Percent-encodes every segment so spaces and
 *  `#`/?& characters survive the URL parse. Pure: the renderer never string-concats a file
 *  URL anywhere else. Works for both spellings of a Windows absolute path (backslashes
 *  become slashes, the drive segments with the rest). */
export function pdfLocalUrlOf(path: string): string {
  // Percent-encode only what a URL parse can't keep verbatim (spaces, %, #, ?, non-ASCII…);
  // the RFC's unreserved + sub-delim characters — including `$`, `:`, `&`, `!`, `(`, `)`,
  // `*`, `+` — stay literal so a Windows drive (`file:///C:/…`) parses as written.
  const enc = (c: string) =>
    /[A-Za-z0-9\-._~!$&'()*+,;=:]/.test(c) ? c : encodeURIComponent(c);
  const normal = path.replace(/\\/g, "/");
  const segments = normal.split("/");
  // Keep the URL's empty host: `file:///<abs path>` even for Windows drive paths ("C:/…"
  // has no leading slash, so the empty first segment is what supplies the third slash).
  if (segments[0] !== "") segments.unshift("");
  return `file://${segments
    .map((seg) =>
      seg ? seg.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:]/g, enc) : "",
    )
    .join("/")}`;
}

export function newEditorTab(origin: EditorOrigin): EditorTab {
  return {
    id: tabIdOf(origin),
    origin,
    name: basenameEditorish(origin.path),
    status: "loading",
    draft: "",
    snapshot: "",
    bytes: 0,
    capped: false,
    pdfUrl: null,
    mode: "edit",
    error: null,
  };
}

export type TabEdit =
  | { op: "open"; origin: EditorOrigin }
  | { op: "close"; id: string }
  | { op: "activate"; id: string };

/** The tab-list reducer. `open` focuses an existing identity instead of duplicating it;
 *  `close` moves the selection to the removed tab's right neighbor (else the last tab left);
 *  `activate` selects. Pure: returns the next list + selection. */
export function reduceTabs(
  tabs: readonly EditorTab[],
  activeId: string | null,
  edit: TabEdit,
): { tabs: EditorTab[]; activeId: string | null } {
  switch (edit.op) {
    case "open": {
      const id = tabIdOf(edit.origin);
      if (tabs.some((tab) => tab.id === id)) {
        return { tabs: [...tabs], activeId: id };
      }
      return { tabs: [...tabs, newEditorTab(edit.origin)], activeId: id };
    }
    case "close": {
      const index = tabs.findIndex((tab) => tab.id === edit.id);
      if (index < 0) return { tabs: [...tabs], activeId };
      const next = tabs.filter((tab) => tab.id !== edit.id);
      if (activeId !== edit.id) return { tabs: next, activeId };
      const neighbor = next[Math.min(index, next.length - 1)] ?? null;
      return { tabs: next, activeId: neighbor?.id ?? null };
    }
    case "activate":
      return { tabs: [...tabs], activeId: edit.id };
  }
}

/** A fresh read REPLACES the in-progress state: the tab was loading (this is its first fill) and
 *  any draft it held is superseded by what's on disk now. The pdf variant carries no content —
 *  only the `file://` URL for the <webview> viewer (local files stream from disk; server PDFs
 *  stream from the main-side temp copy). */
export type TabRead =
  | { ok: true; kind: "text"; content: string; bytes: number; capped: boolean }
  | { ok: true; kind: "pdf"; url: string; bytes: number }
  | { ok: false; binary?: boolean; message: string };

export function applyRead(tab: EditorTab, read: TabRead): EditorTab {
  if (!read.ok) {
    return {
      ...tab,
      status: read.binary ? "binary" : "error",
      error: read.message,
      bytes: 0,
      capped: false,
      mode: "edit",
    };
  }
  if (read.kind === "pdf") {
    return {
      ...tab,
      status: "pdf",
      draft: "",
      snapshot: "",
      bytes: read.bytes,
      capped: false,
      pdfUrl: read.url,
      mode: "edit",
      error: null,
    };
  }
  return {
    ...tab,
    status: "ready",
    draft: read.content,
    snapshot: read.content,
    bytes: read.bytes,
    capped: read.capped,
    pdfUrl: null,
    mode: "edit",
    error: null,
  };
}

/** The user typed: the draft moves, nothing else (dirty = draft === snapshot breaks). */
export function setDraft(tab: EditorTab, draft: string): EditorTab {
  return { ...tab, draft };
}

/** A save verdict: success re-bases the snapshot to the draft (dirty clears); failure keeps
 *  everything dirty and parks the raw message for the footer's error line. */
export type TabSaved = { ok: true } | { ok: false; message: string };

export function applySaved(tab: EditorTab, saved: TabSaved): EditorTab {
  if (!saved.ok) {
    return { ...tab, error: saved.message };
  }
  return { ...tab, snapshot: tab.draft, error: null };
}

export function setMode(tab: EditorTab, mode: "edit" | "preview"): EditorTab {
  if (!canPreview(tab)) return { ...tab, mode: "edit" };
  return {
    ...tab,
    mode: mode === "preview" ? "preview" : "edit",
  };
}

/** Preview is for fresh, editable, Markdown tabs only — applying it to a capped/binary/failed
 *  tab would present the message view as prose. */
export function canPreview(tab: EditorTab): boolean {
  return tab.status === "ready" && !tab.capped && isMarkdownName(tab.name);
}

export function isDirty(tab: EditorTab): boolean {
  return tab.status === "ready" && tab.draft !== tab.snapshot;
}

/** The read-only reason for a tabless body: a capped `ready` tab is the one cap on v1's
 *  editing, and a `pdf` tab is read-only BY KIND (the webview viewer can never save). */
export function readOnlyReason(tab: EditorTab): "capped" | "pdf" | null {
  if (tab.status === "pdf") return "pdf";
  return tab.capped ? "capped" : null;
}

/** 1-based line:col for the footer status line from the textarea's selection position (the
 *  selection END drives the caret readout; an empty selection's start === end). */
export function cursorInfo(
  content: string,
  selectionStart: number,
): { line: number; col: number } {
  const before = content.slice(
    0,
    Math.max(0, Math.min(selectionStart, content.length)),
  );
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const col = before.length - lastNewline;
  return { line, col };
}

/** The origin badge's text: local files show the neutral local label; server files show
 *  the server name; an opencode host appends the product name (spec: "server name +
 *  "opencode"", badge colors re-use the server lamp hues). */
export function badgeText(
  origin: EditorOrigin,
  translate: { local: string; server: string; opencode: string },
): string {
  if (origin.kind === "local") return translate.local;
  return origin.opencode
    ? `${origin.serverName} ${translate.opencode}`
    : `${origin.serverName} ${translate.server}`;
}

/** Build a server tab's origin from a profile snapshot (the badge's opencode flag rides the
 *  profile's own field, never a guess from the path). */
export function serverOriginOf(
  profile: ServerProfile,
  path: string,
): EditorOrigin {
  return {
    kind: "server",
    serverId: profile.id,
    serverName: profile.name,
    path,
    opencode: profile.opencode !== undefined,
  };
}
