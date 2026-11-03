# Pass I — Lightweight IDE Workbench (Spec)

Binding scope for I-a; I-b items are explicitly deferred. Conservative, pattern-mapped:
every surface rides an existing mechanism (panes registry, SFTP channel service, the
transcript markdown pipeline, ConfirmDialog). No new visual language.

## Goal

Files open as TABS inside a docked "Editor" pane; edit and save back to the origin
(local disk, SSH server via SFTP, remote opencode host via the same SFTP path).
Markdown gets Preview/Edit with draft preservation. v1 covers text files.

## Surfaces

### Editor pane (new, registered in panes.ts, id "editor", default closed)

- One docked pane hosting an INTERNAL tab strip (the terminal rail's tab grammar:
  same tab metrics, close buttons, active treatment) + one editor view per tab.
- Pane body per tab, top→bottom: header row (file name + origin badge: local /
  server name / server name + "opencode", dirty dot), the editor, footer status line
  (line:col, encoding assumption UTF-8, size, read-only banner when capped).
- Empty state: "Open a file" hint + Open button + per-surface entry points below.

### Opening files (all flow into the same tab family)

1. SFTP pane context menu on a file: "Edit" (server files; server PDFs/images later — v1
   refuses non-text with an in-band message).
2. Editor pane Open button: a small picker — Local… (native open dialog) or Server…
   (server select + path input; reuses $serverProfiles).
3. Local files dragged onto the editor pane (Electron File API → paths).

### Tabs

- One tab per file identity: `local:<abs path>` | `srv:<serverId>:<remote path>`.
  Re-opening an identity focuses the existing tab.
- Tab survives pane close/reopen in-memory for the session; NOT persisted across app
  relaunch (v1; no revival contracts).
- Close with dirty draft → ConfirmDialog (Save / Discard / Cancel).
- Origin badge colors reuse server lamp hues; local badge is neutral.

## Editing model

- Textarea-based editor v1 (mono font, tab key inserts two spaces, no syntax highlight
  in EDIT mode — preview mode has Shiki). CodeMirror is an explicit I-b follow-up.
- Dirty tracking: initial content vs draft; dirty dot in header + tab.
- Ctrl/Cmd+S: writes via the origin's channel (below); on success clears dirty, footer
  flashes "Saved"; on failure the error line shows in the footer (never a reject).
- External change detection is OUT of scope v1 (no fs.watch on editor files).

### Markdown (.md/.markdown)

- Header toggle: Edit ⇄ Preview. Preview renders the DRAFT (not the saved file).
- Switching modes preserves the draft exactly (component state, not a remount).
- Preview reuses `workspace/markdown/` (MarkdownMessage + components + highlighter +
  math) with the transcript's styling treatment.
- Shiki code blocks render read-only in preview.

### Python and other text (.py, .ts, .js, .json, .txt, .sh, .yaml, …)

- Direct edit; no preview toggle. `.py` gets no special casing v1.

### Non-text & oversize (in-band refusals, never crashes)

- Binary sniff: NUL byte in first 8KB → "binary file, not editable v1" message view.
- Text cap: > 2MB → read-only first 512KB with a banner (editing disabled); PDF/image
  viewers are I-b.

## File I/O channels

### Local (new IPC family `fileio:*`)

- `read(path) → { ok, content?, bytes, capped? } | { ok:false, error }` — reads UTF-8,
  binary-sniffs, caps at 512KB with `capped:true`.
- `write(path, content) → ok | error` — atomic write (temp + rename) to avoid tearing.
- PATH RULES: absolute paths only; refuse anything under the app's own data dirs.
  No directory listing v1 (opening uses the native dialog / drag / SFTP).

### Server / remote opencode host (extend SftpService, not new IPC surface)

- `readFile(serverId, path)` — chunked read over the SAME channel cache the pane uses;
  binary-sniff + 512KB cap server-side of the IPC boundary; returns content + bytes + capped.
- `writeFile(serverId, path, content)` — chunked write, "w" truncation (same overwrite
  semantics as upload's Overwrite).
- Remote opencode files: same ops against the server profile that hosts the opencode
  service — the origin badge distinguishes them (v1: any server file is editable; the
  "opencode project" entry point from transcripts is I-b).

### IPC shape

- shared/fileio.ts channels + types; preload bridge; handlers never reject; renderer
  never sees credentials (it already only passes serverId).

## i18n

- Full en + zh for every string (editor.\*, fileio errors, dialogs).

## Tests

- Main: fileio read/write (caps, binary sniff, atomic rename semantics, path rules),
  sftp readFile/writeFile over the fake channel (chunking, truncation, cap), IPC wiring.
- Renderer (jsdom): tab identity/focus/dirty logic, mode toggle draft preservation,
  close-dirty confirm flow, capped read-only state — pure model extracted like sftp-model.

## Validation gates (all before commit)

pnpm typecheck · pnpm test · pnpm lint · pnpm format:check · pnpm dev boot check.

## Deferred to I-b (do NOT build)

PDF viewer (webview probe → pdfjs fallback), large-file pagination beyond the cap,
transcript file-link entry points, CodeMirror editor, mermaid, external-change watch.

---

# Pass I-b — binding scope (PDF + transcript links)

Two features, nothing else. CodeMirror, mermaid, external-change watch and pagination
beyond the 512KiB cap remain deferred (I-c candidates).

## 1. PDF viewer (read-only)

- Editor tab kind extends to binary-PDF: identity rules unchanged. Opening a .pdf
  (local dialog / drag / SFTP "Edit" on a .pdf row) opens a viewer tab, never the
  textarea (binary refusal no longer applies to .pdf specifically).
- Renderer approach, in order of preference (probe FIRST, commit to ONE):
  (a) Electron `<webview>` with `webviewTag: true` in the BrowserWindow webPreferences,
  `src="file://…"` for local files — zero new deps, Chromium's built-in pdfium UI
  (toolbar, paging, zoom all free). Requires careful lifecycle (destroy on tab close).
  (b) `pdfjs-dist` — only if (a) is unusable in this app's sandbox:false setup.
- Server PDFs: main-side downloads the file to a private temp dir
  (userData/cache/pdf/<hash>.pdf, filename derived from content hash; capped at 20MB
  with in-band refusal above), the webview points at the temp copy; the tab's origin
  badge stays the server's. Temp files are best-effort cleaned on app quit (register a
  will-quit sweep; missed files are reclaimed by the same sweep next launch).
- Ctrl+S on a PDF tab is a no-op (footer shows "read-only").

## 2. Transcript → editor entry points

- In the transcript view (and drill-in detail), file paths in tool parts become
  actionable: an "Open in Editor" affordance on the tool row's expanded state — pick
  whichever matches the existing tool-row affordance grammar with LESS new surface.
- Source resolution by agent + session:
  - claude/codex local sessions: the session's own directory (the provider knows it)
    → local:<path>.
  - opencode local: session directory → local:<path>.
  - opencode remote (srv-…): the file lives on the remote host → srv:<serverId>:<path>
    (SFTP readFile already handles it; the tab badge shows the server).
- Absolute paths only; anything that doesn't resolve to an absolute path under the
  session's directory is not offered (no heuristic searching).
- Nonexistent files open the tab with an in-band "not found" empty state (reuse
  errorKind "not-found" plumbing).

## Tests

- PDF: tab-kind routing (pdf → viewer, not textarea), temp-dir naming/cap/cleanup
  (fake fs), server-pdf open flow (fake SFTP download into the temp seam).
- Transcript links: source resolution per agent×location (pure function over the
  session row + tool input), "not offered" for non-absolute/foreign paths.
- No webview DOM tests (jsdom can't); the probe result and chosen path go in the report.

## Validation gates (all before commit)

pnpm typecheck · pnpm test · pnpm lint · pnpm format:check · pnpm dev boot check
(boot check MUST verify the webview toggle doesn't break the renderer if (a) is chosen).
