# OpenCode remote servers — Pass 2 design

Goal: sessions from remote machines (dev servers running `opencode serve`) appear in the
app alongside local ones — transcripts, telemetry, cost via the remote API; Managed
sessions drive the remote server from an embedded local TUI via `--server`. This is the
second half of the original requirement ("在本地和远程服务器使用的都是 opencode cli").

Depends on pass 1 (OPENCODE_PROVIDER_SPEC.md) landing first — it reuses the provider
module, the session-row mappings, and the registry wiring.

## Verified mechanics (live-tested against opencode v2.0.28 on this machine)

1. **Server side**: `opencode serve --hostname 127.0.0.1 --port 4096` (optional
   `--cors <origin>`, repeatable). Password auth = env `OPENCODE_PASSWORD=<pw>` set on
   the serve process. No password → the API answers unauthenticated (localhost bind).
2. **Auth wire contract** (captured with a header-logging socket): every request carries
   `Authorization: Basic base64("opencode:" + password)` — fixed username `opencode`,
   the password as Basic-auth password. Any request without it (or wrong pw) → 401 on
   every endpoint, including `/api/info`.
3. **Client side**: same resolver for TUI and API bridge —
   `OPENCODE_PASSWORD=<pw> opencode --server http://host:port [args]` and
   `opencode api --server <url> -H ...`. Missing password → immediate, clear error
   ("Server at … requires a password; set OPENCODE_PASSWORD").
4. **API parity**: remote serves the identical v2 API (`/api/info` as health probe,
   `/api/session`, `/api/session/active`, `/api/session/{id}/message`). The pass-1
   client layer works against a remote URL unchanged, plus the auth header.

## Deployment topology (recommendation, goes in user-facing docs)

- Bind `127.0.0.1` on the server; reach it through an SSH tunnel
  (`ssh -N -L 4100:127.0.0.1:4096 user@host`) or a Tailscale/VPN address (bind the
  tailnet IP + password). NEVER bind `0.0.0.0` without a password: the API can drive the
  agent to execute shell commands on that machine — remote code execution by design.
- The app does NOT manage SSH tunnels in pass 2 (code-by-wire has no SSH infra; scope
  discipline). Settings accept an already-reachable URL. Managed tunnels = pass 3.

## Data model

- New shared concept `OpenCodeServer { key, name, url, password?, enabled }`. The local
  background service is the implicit server `local` (no URL config, discovered as in
  pass 1). Remote servers are user-configured in Settings.
- **Id namespacing**: candidate/session ids from remote servers are stored as
  `<serverKey>:<ses_id>`; local stays bare. The provider strips the prefix before any
  API call; resume/spawn pass the raw id + server URL. This prevents cross-server id
  collisions in the sessions DB and the managed registry, and gives the renderer a
  stable identity without schema changes.
- Passwords: store via Electron `safeStorage` (OS keychain encryption) in the app's own
  settings store — never in the analytics DB, never in logs.

## Provider restructure (pass 1 → pass 2)

- `createOpenCodeProvider` holds one client per configured server: `{ key, name, url,
authHeader? }`. `listCandidates` merges all enabled servers' rows (each tagged with
  its serverKey); `readTranscript`/`getToolResult`/`readMetrics` route by id prefix.
- Per-server health: `GET /api/info` with a 2s timeout; status dot in the Servers
  settings card (reuse the CLI-status dot pattern). A server failing 3 consecutive
  polls is marked offline and skipped for 60s (same throttle shape as pass-1 service
  re-discovery).
- Remote sessions: `git`/`pr` metrics are skipped (paths are server-side; the app's
  git/gh reads are local-only) — `readMetrics` returns the token-speed arm only. Project
  labels come from the API's `location.directory` string verbatim.

## Managed sessions on a remote server

- Spawn: embedded terminal runs
  `OPENCODE_PASSWORD=<pw> opencode --server <url> --session <minted-id>`.
  The TUI process runs locally (its pty is ours); the agent executes on the server.
- Resume ended remote session: same command shape with the session's raw id.
- The registry entry carries the serverKey; `cwdOf` for remote entries must never be
  resolved as a local path (spawn cwd = the user's home or the last local cwd; the
  session's real directory lives server-side).

## Open questions to verify at pass-2 kickoff (live, ~15 min)

1. Does `--session <minted-id>` against a remote server create the session server-side
   under that id (deterministic claim still holds)?
2. Does the TUI's optional directory argument translate server-side, or is it ignored
   under `--server`? (Decides whether spawn needs a directory affordance.)
3. safeStorage round-trip under electron in dev (safeStorage needs app ready; check
   ordering vs settings load).

## Out of scope (pass 3+)

SSE live events (replaces polling for local + remote), managed SSH tunnels, fork,
subagent lanes, remote rate limits, cross-server session search.
