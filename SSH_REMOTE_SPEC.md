# Pass R spec — remote OpenCode servers over the connection core

Roadmap: EXPANSION_ROADMAP.md Pass R. Depends ONLY on S1's connection manager — it can
start as soon as S1 lands; it does NOT wait for S2 (terminals) or F (file browser).

## Verified live contract (2026-10-30, opencode v2.0.28)

- Client auth to a serve instance: `Authorization: Basic base64("opencode:" + password)`
  on every request; password set server-side via `OPENCODE_PASSWORD` env.
- **Mint-and-pin works remotely**: `OPENCODE_PASSWORD=<pw> opencode run --server
http://host:port --session <minted-ses-id> "<prompt>"` CREATES the session server-side
  under the minted id (verified: GET /api/session/<id> returns the full row afterward;
  `outcome: "failed"` rows exist when the prompt itself fails — tolerate).
- `location.directory` on the row = the SERVER-side cwd; `projectID` derives from it, so
  remote sessions group under their remote project automatically.
- Serve flags: `opencode serve --hostname 127.0.0.1 --port <N>`. Real deployments must
  bind loopback and reach the API through an SSH tunnel (this spec) or Tailscale (direct
  mode). Never expose the port unauthenticated.

## Profile extension (S1's ServerProfile)

```ts
opencode?: {
  servePort: number;        // remote port `opencode serve` listens on
  directUrl?: string;       // optional: reach without a tunnel (Tailscale/LAN), e.g. http://tailnet-host:4096
  autoTunnel: boolean;      // connect tunnel on app start / on demand
}
```

- The serve password is a CREDENTIAL: lives in servers-credentials.json under key
  `opencodePassword` (same safeStorage pattern S1 built). Never in servers.json.
- Remote opencode status is part of the server's status record.

## Transport — `src/main/servers/remote-transport.ts`

- For a profile with `opencode`: ensure a LOCAL loopback listener that pipes through the
  S1 connection: `net.Server` on an ephemeral 127.0.0.1 port; per incoming socket,
  `client.forwardOut('127.0.0.1', 0, '127.0.0.1', servePort, ...)` and pipe both ways.
- One tunnel per profile id; map serverId → { localPort, netServer }; teardown on
  disconnect (evict with the pooled connection). `directUrl` profiles skip the tunnel and
  use the URL as base.
- `withTransport(serverId, fn)` — borrow pattern matching S1's `withClient`.
- Health probe: GET `<base>/api/info` with the Basic header, TTL-cached (~20s), surfaced
  in `servers.status()` as an opencode-health field per server.

## Provider multi-source refactor (the meaty part)

Pass 1's provider is single-source (local background service). Refactor
`createOpenCodeProvider` to take a LIST of sources:

- local source: today's service discovery + `~/.config/opencode/service.json` password;
- one source per profile with `opencode`: base URL (tunnel or direct) + serve password
  - serverId.

Mechanics:

- App-level session id for remote rows: `<serverId>:<raw-ses-id>` namespace (matches
  OPENCODE_REMOTE_DESIGN.md); the provider strips/reattaches the prefix per source. Local
  rows stay bare ids.
- Remote source: skip git/pr overlays (local git cannot see remote dirs); skip the local
  managed-registry cwd assumption; session state derivation, transcript, tool drill-in,
  usage, cost overlay all reuse pass-1 logic per source.
- overlaySessions merges cost per source as pass 1 does for local.
- Stats pump: unchanged — remote opencode has no translatable file source this pass.

## Managed spawn & resume for remote sessions

- Gate: tunnel must be up (or directUrl live) before spawning — ensure transport, then
  pty spawn `opencode --server http://127.0.0.1:<tunnelPort> --session <raw-ses-id>`
  with env `OPENCODE_PASSWORD=<serve password>`.
- Resume: identical command shape (`--session` continues-or-creates, verified live).
- The terminal spawn path needs per-spawn env injection (node-pty accepts env; check
  src/main/terminal/'s spawn options and thread one extra env field through) and needs
  to NOT inherit the parent process's OPENCODE\_\* vars.
- Minted ids for remote managed sessions: same `ses_`+24 base62 minting, namespaced
  `<serverId>:<minted>` at the app level.

## Renderer

- Sessions rail: remote opencode sessions appear inline with the sessions of their
  project groups, each row carrying a small server badge (server name, i18n'd tooltip
  with host). No separate "remote" section — a remote project IS a project.
- ServerCard edit form gains an "OpenCode" section: servePort, directUrl, autoTunnel,
  serve-password input (write-only, same placeholder pattern as SSH credentials).
- Health dots: server row shows SSH status + opencode status (two dots, labeled).

## Tests

- transport: stubbed ssh2 client + real net.Server loopback (forwardOut fake echoing a
  second loopback listener) — connection, reuse, teardown on disconnect.
- namespacing round-trip (strip/reattach), multi-source provider with stubbed fetchers:
  local + remote merge, parentID skip, outcome tolerance, git-overlay skip for remotes.
- spawn command shape for remote (server flag + env, no env leak), minting under
  namespace.
- health probe caching/TTL with a fake clock.

## Out of scope (later passes)

SFTP browsing of remote projects (F), SSE/live push, remote transcript backfill beyond
API rows, multi-hop/ProxyJump tunnels, server-side file editing save-back (I).
