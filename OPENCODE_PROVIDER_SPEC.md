# OpenCode v2 provider — Pass 1 implementation spec

Goal: add `opencode` as a third tracked agent (alongside claude, codex), backed by the
OpenCode v2 local background service HTTP API instead of on-disk transcript files.

Verified facts (all confirmed live on this machine, opencode v2.0.28):

- The CLI pins/continues sessions: `opencode --session <id>` — "Session ID to continue, or
  to create if it does not exist". Managed spawns can therefore pin a minted id up front
  (claude-style deterministic claim; no codex-style claim scan needed).
- The Provider interface (`src/main/provider/types.ts`) is already async-tolerant:
  `listCandidates`/`readTranscript`/`getToolResult`/`readMetrics` all accept
  `Promise<T> | T`. No interface change needed for an HTTP-backed provider.
- `ReadSettled`'s change token is explicitly opaque ("a non-file-backed provider is free
  to mint its own token") — use the session's `time.updated` epoch-ms as the token.
- Background service: `opencode service status` prints the base URL (e.g.
  `http://127.0.0.1:49374`). Official SDK `@opencode/client@2.2.2` exposes a service
  module for discovery/auth. Endpoints used here answer unauthenticated on localhost via
  the CLI (`opencode api get ...`) — verify raw fetch works; if auth is required, use
  `@opencode/client/service` (add the dep; pure JS, no native code).

## Data source contract (live shapes)

`GET /api/session?limit=100&order=desc` → `{ data: SessionRow[], cursor }` (cursor-paginated):

```json
{
  "id": "ses_e791abb58ffeIDGs2u7KpqxUtv",
  "projectID": "61d7010bfa95b76c2ce7561b93d9e19fd63801af",
  "agent": "orchestrator",
  "model": { "id": "GLM-5.3", "providerID": "nanhu", "variant": "high" },
  "cost": 0,
  "tokens": {
    "input": 136635,
    "output": 6615,
    "reasoning": 30746,
    "cache": { "read": 825472, "write": 0 }
  },
  "outcome": "succeeded",
  "time": {
    "created": 1793264534706,
    "updated": 1793343085784,
    "idle": 1793265102274,
    "viewed": 1793265102274
  },
  "title": "Qwen3 27B推理模型CPT转base再后训练可行性",
  "location": { "directory": "/Users/bqgao" }
}
```

`GET /api/session/active` → `{ "data": { "<ses_id>": { "type": "running" } } }` (a map).

`GET /api/session/{id}/message?limit=100` → `{ data: Message[], cursor: { previous, next } }`
(paginate via `cursor.next` until a page is short or a 3000-message cap):

```json
{
  "id": "msg_...",
  "type": "user" | "assistant",
  "time": { "created": 1793342646413, "streamed": 1793342695611, "completed": 1793342646359 },
  "content": [
    { "type": "text", "text": "..." },
    { "type": "reasoning", "text": "...", "state": "...", "time": { ... } },
    { "type": "tool", "id": "call_...", "name": "ctx_reduce", "executed": false,
      "state": { "status": "completed", "input": { "drop": "..." },
                 "content": [ { "type": "text", "text": "..." } ],
                 "metadata": { "truncated": false } },
      "time": { "created": 1793342736391, "ran": 1793342742067, "completed": 1793342742083 } }
  ],
  "tokens": { "input": 4901, "output": 99, "reasoning": 1954,
              "cache": { "read": 67904, "write": 0 } },
  "cost": 0.01
}
```

Full API reference saved locally: `~/.local/share/opencode/tool-output/tool_18b8734f6001RCTBOa4YsS6ekt`
(grep it for the exact tool `state.status` union and any fields not shown above).
Record additional live fixtures with `opencode api get ...` — REDACT conversation text in
committed fixtures (replace with placeholder prose, keep the structural shape).

## Files to touch

1. `src/shared/agents.ts` — add `"opencode"` to `AGENT_IDS`; descriptor:
   `{ id, label: "OpenCode", binary: "opencode", capabilities: { ...NONE, hasTranscript: true, hasTelemetry: true, canResume: true, hasStats: true } }`.
   Note: `hasStatsBreakdowns` stays false pass 1 unless the stats pump needs no extra work.
2. `src/main/provider/opencode/` — new module (mirror `provider/codex/` structure):
   - `service.ts` — base-URL discovery: spawn `opencode service status` once (login-shell
     form like other CLI spawns), parse the URL, cache; re-discover (throttled, e.g. once
     per 60s) when a fetch fails with a connection error. If the CLI is missing or no
     service is running, try `opencode service start` (check `opencode service --help`
     for the exact subcommand) once; otherwise the provider is inert (empty candidates).
   - `client.ts` — typed thin fetch layer: `listSessions(limit, cursor)`, `listActive()`,
     `listMessages(sessionId, limit, cursor)`. `fetchFn` injectable (composition root
     passes `net.fetch.bind(net)`). 2s timeout per request; failures throw a typed error.
   - `index.ts` — `createOpenCodeProvider(deps)` implementing `Provider` (see mappings
     below) + `overlaySessions(sessions)` attaching `costUsd` from the cached session row
     (mirror `CodexProvider.overlaySessions`).
   - `transcript-events.ts` — `messages[] → TranscriptDoc`.
   - `tool-result.ts` — toolUseId → `ToolResultDetail` from cached messages.
   - `usage.ts` — session-row tokens → `Usage`; token-speed synthesis.
3. `src/main/terminal/command.ts` —
   - `buildSpawnCommand`: opencode branch → `{ file: "opencode", args: ["--session", id, ...(extraArgs ?? [])] }`.
   - `buildResumeCommand`: opencode branch → `{ file: "opencode", args: ["--session", id, ...(extraArgs ?? [])] }`.
   - `buildForkCommand` stays claude-only (`canFork: false`).
4. `src/main/cli-status.ts` — `AGENT_PROBES.opencode`: binary `"opencode"`, minimum
   version floor `"2.0.0"` (`--version` prints `opencode v2.0.28`), product pattern
   matching "opencode", no auth stage (mirror the codex spec's exact field shapes).
5. `src/main/index.ts` — instantiate the provider (deps: `managed: { has, cwdOf }`,
   `recentWindowMs`, `fetchFn: net.fetch.bind(net)`), add to `createCompositeProvider`
   record, add the `cliStatus` configDirs entry (check the type — probe needs no config
   dir if checkAuth is false), wire `overlaySessions` at the same call site codex uses.
   No reconcile/claims step is needed (pinned ids).
6. Renderer:
   - `src/renderer/src/ui/agent-icons.tsx` — one glyph component + `AGENT_GLYPHS` entry.
     Vendor the OpenCode mark: check lobe-icons first (same MIT source as the others);
     otherwise vendor the SVG from opencode's own branding. Follow the file's conventions.
   - `src/renderer/src/settings/SettingsView.tsx` — CLI card mirroring the codex card
     (docs link `https://opencode.ai/v2/docs`).
   - i18n `en.ts` + `zh.ts` — `opencodeCli` section mirroring `codexCli`; update
     `agentCounts` to include OpenCode (all call sites); `infoOpenCode` string (OpenCode
     DOES report cost and tokens, unlike codex — write the info text accordingly).
7. Tests (mirror codex naming under `tests/`):
   - `tests/provider/opencode-provider.test.ts` — fake client (injected canned JSON):
     candidate mapping, summarize fields, restate, change-token contract
     (unchanged/absent/error), empty-when-no-service.
   - `tests/provider/opencode-transcript-events.test.ts` — message fixtures →
     events/turns/context/waitingReason/diff hunks.
   - `tests/provider/opencode-tool-result.test.ts`, `tests/provider/opencode-usage.test.ts`.
   - Extend every test that enumerates agents — the failing suite names them:
     `tests/shared/agents.test.ts`, `tests/ui/meta.test.ts` (i18n parity),
     `tests/cli/cli-status.test.ts`, `tests/terminal/command.test.ts`,
     `command-extra-args.test.ts`, `resume-gate.test.ts`, `manager.test.ts`,
     `tests/provider/composite.test.ts`, `tests/managed/registry.test.ts`,
     `tests/renderer/agent-preference.test.ts`, `cli-gating.test.ts`,
     `session-list-preferences.test.ts`, `session-list-model.test.ts`,
     `tests/db/analytics.test.ts`, `store.test.ts`, `tests/stats-*.test.ts`,
     `tests/ipc.test.ts`, `tests/main/diagnostic-report.test.ts`. Fix each the way its
     neighboring codex entry does.

## Mappings

### SessionCandidate (from listSessions)

- `id`: row.id · `agent`: "opencode" · `threadKind`: "session" · `parentSessionId`: undefined
- `alive`: active map has id OR `now() - time.updated < WORKING_WINDOW` (10s, codex parity)
- `status`: fresh ? "busy" : undefined
- `cwd`: `row.location?.directory ?? ""`
- `transcriptPath`: undefined · `transcriptMtimeMs`: `time.updated` (the change token)
- `updatedAt`: `time.updated`
- Filter: skip rows older than `recentWindowMs` unless `managed.has(id)`.

### PersistedSession (summarize)

- `title`: `row.title?.trim()` (truncate `MAX_SESSION_TITLE_LEN`) else `projectFromCwd(cwd)`
- `project`/`cwd`/`originCwd`: from directory · `branch`: undefined (codex parity)
- `state`: `deriveSessionState({ alive, status, awaitingUser: false })`
- `management`: `managed.has(id) ? "managed" : "observed"`
- `model`: `normalizeModelId(\`${providerID}/${model.id}\`)`(likely undefined family);`modelRaw`: `\`${providerID}/${model.id}\`` (renderer prefers modelRaw)
- `lastActivityMs`: `time.updated` · `createdMs`: `time.created` · `awaitingUser`: false
- `usage`: `{ inputTokens: input, outputTokens: output + reasoning (reasoning IS
generated output — document this), cacheReadTokens: cache.read, cacheCreationTokens:
cache.write, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 }`
- `usageByModel`: [] · `contextTokens`: 0 · `effortLevel`/`compaction*`: undefined

### TranscriptDoc (transcript-events.ts)

Walk messages oldest-first; within a message walk `content` in order:

- user message, `text` part → `{ kind: "user", text }`
- assistant message: `reasoning` → `{ kind: "thinking", text }`; `text` →
  `{ kind: "assistant", text }`; `tool` →
  - edit-shaped tools (name lowercase in: edit, write, apply_patch, str_replace_editor…):
    `{ kind: "diff", tool: name, file: input.file_path ?? input.path ?? input.filePath,
hunk: { removed: (input.old_string ?? input.oldString ?? "").split("\n"),
added: (input.new_string ?? input.newString ?? input.content ?? "").split("\n") },
status }` — verify the real edit-tool input keys from a live fixture first.
  - otherwise `{ kind: "tool", name, input: oneLiner(name, input) }` — oneLiner: bash →
    `input.command`; read/grep/glob → `input.path ?? input.pattern`; default → compact
    JSON, truncated. `toolUseId`: part.id. `status`: `state.status === "completed"` →
    "ok" (unless `state.metadata?.error` → "error"); "running"/"pending" → "pending";
    anything else → "error". `outputLines`: line count of the joined `state.content`
    text parts.
  - Ignore unknown part types (e.g. `step-start`) — forward-compatible.
- `waitingReason`: mirror `src/main/provider/claude/transcript-tail.ts` logic — trailing
  user text with no assistant after → that text (truncated); trailing pending tool → the
  tool; else null.
- `turns`: split at user messages; `prompt` = first line of the user text (truncated like
  codex's preview); `startMs` = user `time.created`; `endMs` = last assistant
  `time.completed ?? time.streamed` in the span; `toolCount` = tool parts in the span.
- `context`: from the LAST assistant message with tokens →
  `{ input, cacheRead: cache.read, cacheCreation: cache.write }`, else null.
- `subagents`: [].

### Provider read arms

- `readTranscript(id, since)`: token = cached session-row `time.updated` (from the last
  sweep; on cache miss, re-list sessions to find the row — absent → `{status:"absent"}`).
  `since === token` → `{status:"unchanged", mtimeMs: token}`. Else fetch all messages
  (paginated, cap 3000), build the doc, cache `{token, messages, wire}`, return the wire.
  Fetch/parse failure → `{status:"error"}` (transient contract).
- `getToolResult(id, toolUseId)`: from the cached messages; `{found:true, command:
friendlyCommand(name, input), output: joined state.content text (cap ~100k chars),
status}` else `{found:false}`.
- `readMetrics(id, since)`: token via `metricsToken(mtimeMs, sources)` (codex parity);
  `tokenSpeed` = reuse `speedFromTokenEvents` from codex/usage.ts, synthesizing events
  `[{ms: msg.time.completed, outputTokens: output + reasoning}]` for assistant messages
  inside `SPEED_WINDOW_MS`; `git`/`pr` via `readGit`/`readPr` on the session cwd;
  `voiceEnabled`/`remoteControl`: null.
- `resolveResumeTarget(id)`: `{ alive: active.has(id) || fresh, cwd: row.directory,
rolloutPath: … }` — check `resume-gate.ts` for what it consumes; codex passes a real
  path, use the session id string or whatever satisfies the gate's contract honestly.
- `resolveSessionCwd`: from the cached row / managed registry (`managed.cwdOf`).
- `resolveTranscriptPath`: null (no file).
- `readSubagentTranscript`/`readTasks`/`readShells`/`readShellOutput`/`readMonitors`/
  `readMonitorOutput`: settle `absent` (capabilities off — codex stub parity).
- `overlaySessions`: attach `costUsd: row.cost` to opencode rows (Session type field
  check first; skip silently if the field differs).

### Managed sessions

- Spawn mints `ses_` + 24 base62 chars, spawns `opencode --session <minted>`, registers
  in the managed registry with `agent: "opencode"` (registry is agent-generic; check
  `managed-registry.ts` for any per-agent enumeration and mirror codex's entry).
- No rotation/claim sweeps.

## Verification (all must pass)

```
pnpm install && pnpm rebuild:native
pnpm typecheck     # both tsconfig passes
pnpm test          # full suite
pnpm lint && pnpm format:check
```

Then manual `pnpm dev`: Settings shows an OpenCode CLI card; the sessions rail lists
real opencode sessions from this machine's service (several exist); a Managed spawn pins
its id; Resume on an ended session relaunches `opencode --session <id>` in its cwd;
transcript + tool drill-in render for an OpenCode session.

## Repo rules (from CLAUDE.md)

- pnpm only; `pnpm rebuild:native` after install; tests under `tests/` mirroring source
  tree, `.ts` only; run `pnpm format` + `pnpm lint` before done; conventional commits
  (`feat(provider): …`), NO Co-Authored-By trailer; don't "fix" `no-unsafe-*` warnings;
  don't touch `website/`.
- Match the codebase's documentation style: the repo explains WHY in dense block
  comments — write the same quality for the new module.

## Out of scope (pass 2+, do not build)

Remote servers (`--server <url>` + password), SSE event subscription, fork
(`POST /api/session/{id}/fork`), subagent lanes (parentID), rate limits/usage limits,
context-window overlay, stats backfill scan, model picker, compaction tracking.
