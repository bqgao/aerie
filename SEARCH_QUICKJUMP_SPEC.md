# B1 full-text search + B2 Quick palette — binding spec

Grounded in the 2026-11-02 recon (file anchors inline). Two features, TWO runs:
Run B1 (search index + query + UI), Run B2 (⌘⇧O palette). Sequential — never
parallel with tier-1 Run 1/Run 2 (i18n + rail overlap).

## Verified facts this spec builds on

- FTS5 with `tokenize='trigram'` works in BOTH drivers (better-sqlite3 12.10.0
  binary has ENABLE_FTS5; Electron 41 node:sqlite ran a trigram CJK match live).
  Chinese content needs trigram — unicode61 is useless for it.
- opencode local store: `~/.local/share/opencode/opencode.db` (WAL). Tables
  `session_v2` (id, directory, title, agent, model JSON, time_updated, …) and
  `session_message` (id, session_id FK, type, seq, time_updated, data JSON;
  `data.content[].text` holds text for `text`/`reasoning` parts). NOT a documented
  contract — feature-detect, degrade soft. Open STRICTLY
  `new Database(path, {readonly:true, fileMustExist:true})`; never write it.
- No fuzzy matcher exists in the repo. No ⌘K/⌘⇧O chord is bound anywhere.
- Channel recipe (4 files): IPC name (src/shared/ipc.ts) → IpcApi method →
  preload one-liner → handler in registerIpc (deps-injected).
- Scan pattern to copy: bounded steps + cursor rows + renderer pump
  (src/main/db/scan.ts, ipc.ts stats engine 1101–1269, use-stats-pump.ts
  40ms-backfill → 5min-idle, kickStatsPump).
- Modal chrome: src/renderer/src/ui/ModalShell.tsx (portal, Escape, focus trap).
- Sources renderer-resident: sessions/groups (session-list-model.ts:396–437),
  $serverProfiles (ssh-model.ts:59), $editorTabs (editor-store.ts:22).

## Run B1 — transcript full-text search

### Main: index + scan engine

- New `userData/search.db` (open like src/main/db/sqlite.ts openDb, WAL):
  - `fts` virtual table: `USING fts5(body, agent, sessionId UNINDEXED,
sessionTitle, directory, timeMs UNINDEXED, tokenize='trigram')`.
  - `sources` cursor table: per-agent high-water marks — claude/codex:
    path+mtime+byteOffset rows (search reads FULL files, not the stats 5000-line
    cap); opencode: max(time_updated, seq).
- `search-scan.ts`: bounded `searchScanStep(deps)` — claude/codex ride
  collectScanTargets/listRollouts discovery but with their own read cursors
  (re-read only appended bytes; on mtime shrink → delete + reindex that file).
  opencode: readonly DB, `SELECT m.id, m.session_id, m.type, m.seq, m.time_updated,
m.data, s.title, s.directory FROM session_message m JOIN session_v2 s ON
s.id = m.session_id WHERE m.time_updated > ? ORDER BY m.time_updated` in chunks
  (≤2000 rows/step); index type in ('user','assistant') parts where
  content[].type in ('text','reasoning'); skip empty bodies. Feature-detect
  tables (missing/renamed → mark source unavailable, fail soft, log line).
- IPC: `search:read` (progress snapshot + status per source, changed-token memo)
  and `search:pump` (one bounded step per call) and `search:query(q, limit)` —
  FTS prefix query (`"tok"*` per token, AND), rank `bm25()`, return grouped-by-
  session rows: sessionId, agent, sessionTitle, directory, snippet(fts, 0,
  '…', '»', '«', 24), timeMs, hitCount; LIMIT 50 sessions. Handlers never
  reject; query errors (bad FTS syntax) → in-band `{ok:false, error}`.
- Deletion sync: sessions whose transcript file vanished (claude cleanupPeriodDays)
  → drop their fts rows during the claude/codex sweep (the cursor walk knows).

### Renderer: search surface

- A "Search" docked pane (rides the panes registry like the Editor pane) OR a
  modal — pick the one matching the app's existing grammar with less new
  surface; the recon recommends a pane (results are a browsing surface).
- Debounced input (200ms) → `search:query`; results list: session rows (agent
  icon via AGENTS registry, title, directory, snippet with highlighted marks,
  hit count, time); click → navigate to that session in the rail (existing
  select action). Empty/degraded states per source.
- `useSearchPump` at App root (copy use-stats-pump's 40ms-backfill → idle
  schedule; kickSearchPump on pane open). en + zh throughout.

### Tests

search-scan step semantics (fake fs/DB seams: append-only re-read, shrink
reindex, deletion sweep, opencode chunking + feature-detect degradation), query
parser (tokens → FTS string, bad syntax), progress token. No real opencode.db
in tests — fixture DB via the node:sqlite driver.

## Run B2 — ⌘⇧O Quick palette

- `src/renderer/src/shell/quick-palette.ts` — PURE scorer + source aggregation
  (JSX-free, jsdom-testable): subsequence scorer (~60 lines, no new dep):
  case-fold; scores: consecutive-run bonus, word-boundary bonus, start-of-string
  bonus, prefix > substring > scattered; CJK falls back gracefully (subsequence
  over code points works; ALSO run the existing substring filter and merge
  results — literal CJK matching must not lose to fuzzy latin).
- `QuickPalette.tsx` on ModalShell: input, keyboard list nav (↑↓, Enter,
  Escape via ModalShell), grouped results (Sessions / Projects / Servers /
  Editor tabs), agent icons, max ~12 visible rows.
- Sources (read atoms directly): sessions list (top N by recency + title match),
  project groups, $serverProfiles (action: openServerTerminal), $editorTabs
  (action: activate tab). Session/project action = existing select.
- One extra row pinned when B1 is present: "Search transcripts for '…'" → opens
  the search pane with the query prefilled.
- Shortcut: window-level keydown in App.tsx, `(meta||ctrl)+shift+KeyO`,
  preventDefault + stopPropagation (capture phase, like shell-terminal
  keybinds). en + zh.

### Tests

scorer (latin subsequence, CJK substring merge, ordering guarantees), source
aggregation reducer, keyboard nav state machine (pure).

## Validation gates (both runs, before final commit)

pnpm typecheck (0) · pnpm test (all green; baseline = the run's start HEAD) ·
./node_modules/.bin/eslint . (exit 0) · pnpm format:check · pnpm dev boot check
(B1 must confirm no search.db lock contention at boot; B2 must confirm the
chord doesn't fire inside terminal focus).
