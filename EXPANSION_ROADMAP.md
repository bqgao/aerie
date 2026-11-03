# Expansion roadmap — Code-by-wire → full cockpit

The fork grows from "session cockpit" to a Folio-class workbench. Passes are sequenced by
dependency: connection core feeds everything; remote opencode rides the same tunnels; the
file browser and IDE build on the connection manager.

## Pass T — theme system upgrade (small)

Settings → Appearance already has App-theme Dark/Light + independent terminal theme
(appearance-store.ts, wired to `data-theme`/`colorScheme`). Upgrades:

- Add "system" third mode (follow OS via `nativeTheme`), keep Dark/Light.
- Accent color picker (CSS variable set).
- If the running instance's toggle misbehaves, that's a bug to fix here.

## Pass S1 — server profiles & SSH connection core (fixer, spec: SSH_CORE_SPEC.md)

- `ssh2` connection manager in main (pool, keepalive, auth: password/key/agent).
- Server profiles: name, group, host, port, user, auth — credentials encrypted with
  Electron `safeStorage`, stored on-device only (never in analytics DB, never synced).
- Settings → Servers card: CRUD + test-connection.
- No terminals/SFTP yet — later passes.

## Pass S2 — SSH terminal tabs

- Built-in SSH terminal: ssh2 shell channel ↔ existing xterm component (NOT `ssh` in a
  pty — we own auth, reconnect, and the credentials store).
- Servers sidebar section: grouped list, double-click connect, tab strip of open
  connections, status dots.

## Pass F — SFTP file manager

- Per-connection file browser: directory tree + list, path edit, refresh.
- Ops: new file/folder, rename, delete, download, upload; Ctrl/Shift multi-select;
  context menu with copy/cut/paste.
- Drag: local→server upload, server→local download, same-server move.
- SFTP/SCP transfers with progress; large-file guards.
- Git-status badges in the tree (read-only awareness) — stretch.

## Pass R — remote OpenCode servers (redesign of OPENCODE_REMOTE_DESIGN.md's transport)

- Remote opencode server = a server-profile extension (serve URL + password), tunnels
  auto-established through the Pass S1 connection manager (closes the "app doesn't
  manage tunnels" gap in the original design).
- Remote sessions in the rail with server badges; managed spawn via
  `opencode --server <url> --session <id>`; remote-AI-project files editable via the
  same SSH connection (feeds Pass I save-back).
- Wire contract unchanged: Basic auth `opencode:<password>`, `/api/info` health probe.

## Pass I — IDE workbench

- File tabs coexisting with session tabs in the workbench.
- Editors by type: Markdown (Preview/Edit toggle, draft preserved on switch), Python
  and text (CodeMirror 6 edit + save), PDF (pdfjs viewer: paging/zoom), others by
  encoding/size heuristics.
- Save-back routing: local → local fs; server file → SFTP write; remote AI project →
  host via its connection. Ctrl+S writes to origin.
- Large files: size-capped or paginated read-only.

## Suggested additions (candidates beyond the requested list)

**Signature — cockpit × IDE integration (only this fork can do them):**

1. Transcript → editor: click a file/diff in any AI session transcript → opens as an
   editor tab (local directly; remote-project file via its server connection).
2. Right-click any file (browser/editor) → "交给 OpenCode": attach as context to a
   running or new session.
3. Editor selection → "explain / fix with opencode" → comment/patch applied in place.

**Ops:** 4. Port-forward manager (visual -L/-R), auto-tunnel for remote `opencode serve`. 5. Remote search: server-side grep streaming into a results pane. 6. Deploy: one-click upload of changed files (mtime/diff-based, mini-rsync). 7. Broadcast: type into N SSH terminals simultaneously.

**Experience:** 8. Command palette + snippet library for terminals. 9. Terminal session recording/replay (asciinema-style audit). 10. VCS badges + dirty-file indicators across tree and editor tabs.

## Researched backlog — Otty reference + terminal/SSH landscape (2026-10-30)

Studied: Otty (otty.sh, github.com/otty-shell/otty — native GPU terminal with
first-class Claude Code/Codex/OpenCode affordances), plus Termius/Tabby/WindTerm/
MobaXterm/iTerm2 feature sets. Otty validates this fork's premise (agent coordination
is the product) and its coordination features transplant well — because we hold the
opencode service API, which is richer than Otty's hook/OSC channel.

**Adopt — tier 1 (high value, cockpit-native, cheap on our data):**

- A1 Inbox mode on the sessions rail: waiting-on-you sessions first, each with WHY it
  waits (approval/error/last step) — provider already surfaces waitingReason. Today /
  Yesterday / Earlier grouping beneath.
- A2 Tab hover preview cards: current step or waiting reason, folder, last reply line.
- A3 Fork/Branch an OpenCode session into a new one (service API `session.fork`; the
  CLI also has --fork) — flips the registry's gated canFork flag on.
- A4 Prompt Queue: stack prompts on a busy session; auto-send next when the turn ends.
  Ours can go through the service API (visible in transcript, no pty typing).
- A5 ssh_config import: read ~/.ssh/config hosts into server profiles (one click).
- A6 Notification polish: finish / needs-attention native notifications + keep-awake
  while sessions are busy (caffeinate exists — wire it to any-busy).

**Adopt — tier 2 (high value, medium cost):**

- B1 Full-text search across ALL agent conversations (claude/codex already in SQLite;
  needs an opencode backfill scan — also unlocks stats attribution later).
- B2 Open Quickly (⌘⇧O) fuzzy jump: sessions, projects, servers, files, commands —
  one picker over everything, distinct from the command palette.
- B3 Send to Chat: terminal selection / editor selection / tool output → attach as a
  user message to a running or new opencode session (API prompt).
- B4 Composer: multiline prompt drafting with undo + image/file attach, feeding A4.
- B5 Session restore: reopen session tabs (and managed terminals) after restart.
- B6 Ports panel: ports opened by a project's sessions (lsof), HTTP ones titled.
- B7 Mermaid rendering in the Pass I markdown preview (theme-colored, offline).
- B8 Changed-files panel: files touched in the focused session (from transcript docs),
  click → editor tab (pairs with roadmap item 1).

**Adopt — tier 3 (worth having, later):**

- C1 Recipes/layouts: saved workspace shapes (tabs + servers + commands).
- C2 Deep links (cbw://session/<id>) from notifications.
- C3 Inline images in terminal scrollback (xterm image addon).
- C4 OSC 9/9;4/7501 parsing in embedded terminals → badge fallback for NON-managed
  shells (managed agent sessions already have richer API state).
- C5 Settings import/export.

**Deliberately NOT adopting (terminal-emulator core — Otty/Ghostty/Kitty territory,
not a cockpit's moat):** GPU rendering, shell integration (OSC 133 outlines),
ghost-text autocomplete, vi mode, hint mode, Kitty graphics protocol as a feature,
window/split layout engine, BiDi. Our embedded terminals stay xterm.js; the product
is the coordination layer above them.

## Sequencing

T (quick) → S1 → S2 → R → F → I, with designer UX input landing between S1 and S2.
T can be pulled at any point; R can swap ahead of F if remote-opencode sessions matter
more to the user than the file browser.
