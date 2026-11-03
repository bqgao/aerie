# DESIGN_NOTES.md — S2 (SSH terminal tabs) + F (SFTP file browser)

> **Status: conservative orchestrator draft.** The designer lane failed repeatedly on
> 2026-10-30 (5 dispatches, 2 models, silent empty completions); per the announced
> fallback these notes were written by the orchestrator as **pattern-mapping decisions
> only** — every surface below reuses an existing shell structure verbatim, no new
> visual language, no new tokens. Visual craft (spacing rhythm, motion, polish) is
> explicitly DEFERRED to a designer review pass when the lane recovers. Surfaces I
> (IDE tabs) and the tier-1 cockpit integrations (Inbox, hover previews, prompt
> queue, Fork placement) are OUT OF SCOPE here and still need a real designer pass —
> they touch the middle column, which is the most design-sensitive real estate.

## Ground truth: the shell as it exists (what we map onto)

Verified by reading the renderer on 2026-10-30 (feat/opencode-provider):

- **Three-column shell.** `App.tsx` composes `LeftSidebar` (sessions rail: project
  groups, pins, overview route) | middle column (`MiddleHeader` + `SessionPanel`,
  one SELECTED session at a time; special routes `OVERVIEW_ID` / `SETTINGS_ID` /
  `NEW_SESSION_ID`) | `RightSidebar` (telemetry panels: `ClaudePanels` /
  `CodexPanels` / `OpenCodePanels`).
- **There is no document-tab system.** "Tabs" exist only inside the terminal dock.
- **Terminal dock** = `src/renderer/src/shell-terminal/`: a rail of terminal tabs
  (`rail.tsx`), `PersistentTerminal` instances (xterm), per-tab cwd snapshotting,
  takeover/route plumbing (`router.ts`, `use-terminal-session.ts`). Managed agent
  sessions spawn into this rail today (pass 1: `opencode --session <id>`).
- **Docked panes** = `src/renderer/src/shell/panes.ts`: `$paneStates` registry,
  `ensurePaneRegistered(id, defaults)`, `togglePane`, width/height overrides,
  persisted in `localStorage` (`cbw.paneStates.v1`).
- **Settings cards** = `settings/cards/ServerCard.tsx`: rows with status lamps
  (3s poll), Test spinners + inline verdicts, `ConfirmDialog` deletes, write-only
  credential inputs with "saved" placeholders. This is the canonical server UX.
- **UI kit:** `CustomSelect`, `SegmentedSwitch`, `ModalShell`, `ConfirmDialog`,
  `MetricTip`. i18n: nested keys in `src/renderer/src/i18n/{en,zh}.ts`.

**Prime directive for both surfaces: ride these structures. Add zero new
container paradigms.**

---

## S2 — SSH terminal tabs

### Placement (decision)

An SSH session is **a new tab KIND in the existing terminal rail** — not a new tab
system, not a middle-column route, not a new pane. Rationale: the rail already
hosts "spawned things you watch in a terminal" (managed agent sessions); an SSH
terminal is the same mental object pointed at a remote host. The rail's chrome
(`chrome.tsx`), persistence, and keyboard plumbing are inherited for free.

### Where you connect from (flows)

1. **Settings → ServerCard row → "Open Terminal" (context menu / row action).**
   Primary path. Menu item is enabled when status ≠ connected; on click:
   connect (pool) → on ready, spawn rail tab.
2. **LeftSidebar "Servers" section (new, S2 scope).** A collapsible section at the
   TOP of the sessions rail, above project groups, mirroring `ProjectGroupRow`
   collapse mechanics. Rows: server name + group chip + status lamp (reuse
   ServerCard lamp semantics/colors verbatim). **Double-click = connect + open
   terminal tab** (the user's stated convention). Single click selects; context
   menu: Open Terminal, Edit in Settings…, Disconnect.
3. **Keyboard:** no new global shortcut in S2 (conservative). Terminal rail's
   existing next/prev-tab keys cover traversal once the tab exists.

### Tab identity

- Title: **server `name`** (fallback `user@host` when name empty — profiles require
  non-empty names, so fallback is defensive only).
- Icon/lamp on the tab: 3 states, same lamp vocabulary as ServerCard —
  `connecting` (pulsing dot) → `connected` (steady) → `dropped` (red + ⌘R-style
  Reconnect affordance on the tab's context menu).
- One tab per (server) is allowed to multiply: reconnects REUSE the dropped tab
  (revive in place, buffer preserved) instead of stacking new tabs. Multiple tabs
  to the same server are permitted (explicit "New Tab to This Server" menu item).

### Edge states

| State                          | UX                                                                                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth failure during connect    | No tab spawned; the rail row + ServerCard show the sticky `lastError` (S1 semantics).                                                                                                                                  |
| Host unreachable / timeout     | Same as auth failure — error stays on the row, not in a dead tab.                                                                                                                                                      |
| Drop mid-session (S1 `onDown`) | Tab stays, buffer becomes read-only behind a **lock overlay**: message line + `Reconnect` button (existing button styles). Reconnect = pool re-dial → new ssh2 shell stream into the SAME xterm instance, buffer kept. |
| Host key changed               | Row error verbatim from ssh2 message (never credentials).                                                                                                                                                              |

### Implementation notes for the fixer

1. `use-terminal-session.ts` assumes a local pty child. Introduce a terminal-kind
   seam: `local-pty` (existing) vs `ssh` (stream from the pooled ssh2 client's
   `shell()`). xterm write/resize map to stream data/`setWindow`; NO node-pty on
   the remote side — the remote pty is the sshd's.
2. Sizing: xterm `cols`/`rows` must flow through `shell({ term: {...} })` options
   and `setWindow` on resize; debounce like the existing local resize path.
3. Keepalive/teardown ride S1: the pool's `keepaliveInterval` covers liveness;
   terminal close = `stream.close()` + tab dispose (NOT pool disconnect — other
   surfaces share the connection). Pool `disconnect()` remains a Settings-level
   action.
4. IPC: `servers:shell:open` (returns a handle id), stream data over the existing
   renderer-poll? NO — terminals are the one exception in this polling app: they
   are already live evented (`shell-terminal` writes in real time). Follow the
   existing terminal data path shape exactly; the ssh variant is a different
   `spawn` target, not a new transport.

### i18n skeleton (en / zh)

```
shell.servers.sectionTitle        Servers            服务器
shell.servers.emptyState          No servers saved — add one in Settings   未保存服务器——在设置中添加
shell.servers.openTerminal        Open Terminal      打开终端
shell.servers.newTabToServer      New Tab to This Server    为此服务器新建标签
shell.servers.editInSettings      Edit in Settings…  在设置中编辑…
shell.servers.disconnect          Disconnect         断开连接
terminal.ssh.droppedOverlay       Connection lost    连接已断开
terminal.ssh.reconnect            Reconnect          重新连接
terminal.ssh.reconnecting         Reconnecting…      正在重连…
```

---

## F — SFTP file browser

### Placement (decision)

A **new docked pane** registered in `panes.ts` (id `"sftp"`), default closed,
opened from: (a) server row context menu → "Browse Files", (b) a toolbar toggle in
the pane strip once a server is connected. NOT a middle-column route (that column
is session-territory), NOT a tab kind (tabs are terminals). Width resizable via
the existing `widthOverride` machinery; persisted like every other pane.

### Layout (single server context, top→bottom inside the pane)

1. **Server selector** — `CustomSelect` listing saved servers (connected ones
   first, lamp dot inline). Switching server switches the whole pane's context.
2. **Breadcrumb / path bar** — segments `home / bqgao / Work`; click a segment to
   jump; an edit (pencil) affordance swaps the bar to a path input (Enter =
   navigate, Esc = cancel). Invalid path → inline error under the bar, list
   unchanged.
3. **Tree + list vertical split** (the user's stated requirement is both):
   - **Directory tree** (top, ~40% height, independently scrollable): lazy-expand
     on disclosure click, one level at a time; spinner per expanding node.
   - **File list** (bottom): the selected tree node's entries. Columns: name /
     size (humanized: `4.2 KB`) / mtime (locale short). Sort: name asc, folders
     first; click header cycles asc/desc (SFTP has no cheap "sort by size" — fetch
     stats are already in the list payload, so all three sorts are client-side).
4. **Transfers strip** (bottom of pane, above the pane footer, only when active):
   one row per transfer — direction icon, filename, progress bar, cancel (×);
   completed rows show ✓ and auto-dismiss after 3s; failed rows persist with the
   error and a Retry button; a header row with an overall spinner + "Clear
   finished".

**Chosen over alternatives:** per-tab transfer drawer (no tab system), global
bottom panel (fights the terminal dock), toasts (long-running ops need a
persistent, reviewable surface). One surface, one place.

### Selection & clipboard semantics

- ⌘click toggles, Shift-click range-selects (contiguous), ⌘A selects all files in
  the current list. Selection is list-scoped (tree nodes are navigation only).
- Right-click context menu (on selection): **Open** (I-pass preview; disabled
  until I lands), **Download…** (native save dialog, multi-select → choose
  folder), **Upload Here…** (native file picker), **New File…**, **New Folder…**,
  **Rename…**, **Delete** (ConfirmDialog listing count), **Copy**, **Cut**,
  **Paste** (paste into the CURRENT directory; name conflicts → conflict dialog
  below). Cut visual: 50% opacity rows.
- Internal clipboard is server-scoped and cleared on server switch.

### Drag semantics (macOS conventions)

- **Finder → pane:** drag-over highlights the target directory row (or the list
  background = current dir); drop = upload. Multiple files → one transfer row per
  file.
- **Pane → Finder:** v1 ships **Download… only** for drag-out. TRUE native
  drag-out (file:// promise) requires staging a temp local file first — an
  Electron-specific trap (stale temp on failed download); deferred, flagged, not
  silently half-built. (Deferred item for F.1.)
- **In-pane drag = move** within the same server (row → tree node or list folder).
  Cross-server drag is a no-op (cursor shows "not allowed"); the internal
  clipboard Copy/Paste path is the cross-server story for v1.

### Edge states

| State                             | UX                                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty dir                         | Centered empty-state text + "Upload Here…" / "New Folder" buttons.                                                                                                               |
| Permission denied (list/read)     | Inline banner under path bar: the server's message; tree/list show parent's last good state.                                                                                     |
| Name conflict (upload/paste/new)  | `ConfirmDialog`: Overwrite / Skip / Rename (`name-2` auto-suffix). Multi-file: apply-to-all checkbox.                                                                            |
| Connection drops mid-transfer     | Transfer rows → failed ("Connection lost"), Retry after reconnect; pane shows the S2-style lock overlay; tree/list stay (stale) with a "Reconnected — refresh" banner on resume. |
| File too large for inline preview | Out of F scope; Open is disabled (I pass owns limits/paging).                                                                                                                    |

### Implementation notes for the fixer

1. SFTP rides the **same pooled ssh2 client** (`client.sftp()` per op or one sftp
   channel per pane context — pick one channel per pane, it multiplexes); NO
   second TCP connection, NO bare `scp`/`sftp` CLI.
2. IPC family `servers:sftp:*` (list / tree-node / mkdir / rename / delete /
   upload-chunk / download-chunk / stat) — never-reject handlers, `{ok:false,error}`
   failures, unknown-input normalizers, same as S1's eight.
3. Uploads/downloads are **chunked streams** (64–256 KiB) with progress callbacks;
   a transfer registry in main with ids; renderer polls the pane's active
   transfers in the 3s pane poll (the one place the polling architecture bends —
   acceptable, it's progress metadata, not terminal data).
4. Path normalization is SERVER-side (posix join/split only; reject `\0`); the
   renderer never builds paths by string concat on its own.
5. `delete` of a non-empty directory: recursive with per-child errors collected —
   the ConfirmDialog must state "folder and all contents".

### i18n skeleton (en / zh)

```
sftp.pane.title              Files               文件
sftp.path.edit               Edit path           编辑路径
sftp.path.invalid            Path not found       路径不存在
sftp.tree.empty              No subfolders        无子文件夹
sftp.list.empty              Empty folder — drop files here to upload   空文件夹——拖入文件以上传
sftp.menu.open               Open                打开
sftp.menu.download           Download…           下载…
sftp.menu.uploadHere         Upload Here…        上传到此处…
sftp.menu.newFile            New File…           新建文件…
sftp.menu.newFolder          New Folder…         新建文件夹…
sftp.menu.rename             Rename…             重命名…
sftp.menu.delete             Delete              删除
sftp.menu.copy               Copy                拷贝
sftp.menu.cut                Cut                 剪切
sftp.menu.paste              Paste               粘贴
sftp.confirm.deleteTitle     Delete {count} item(s)?   删除 {count} 项？
sftp.confirm.deleteFolder    This deletes the folder and all its contents.   将删除文件夹及其全部内容。
sftp.conflict.title          "{name}" already exists   "{name}" 已存在
sftp.conflict.overwrite      Overwrite           覆盖
sftp.conflict.skip           Skip                跳过
sftp.conflict.rename         Rename              重命名
sftp.conflict.applyAll       Apply to all        应用到全部
sftp.transfers.title         Transfers           传输
sftp.transfers.retry         Retry               重试
sftp.transfers.clearFinished Clear finished      清除已完成
sftp.transfers.connectionLost Connection lost    连接已断开
sftp.lock.reconnectedBanner  Reconnected — refresh   已重连——刷新
```

---

## Out of scope / deferred to the designer pass

- **I (IDE tabs):** needs a real placement decision in the middle column (which is
  single-selected-session today). Options noted for the designer: file tabs as
  rail-adjacent chips vs. a session-route sub-view vs. an overlay workspace. Not
  decided here.
- **Tier-1 integrations** (Inbox mode, hover preview cards, prompt queue, Fork
  placement, Send to Chat): all touch the sessions rail / tab chrome — designer's
  call, deferred.
- **Visual polish of S2/F:** this draft fixes placement and flows only. A designer
  pass should tune density, spacing rhythm, and motion before S2/F ship beyond
  internal builds.
- **F.1 follow-ups:** native drag-out via temp staging; cross-server drag-move.
