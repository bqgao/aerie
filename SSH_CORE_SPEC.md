# Pass S1 spec — server profiles & SSH connection core

Roadmap context: EXPANSION_ROADMAP.md (Pass S1). This pass is the FOUNDATION for SSH
terminals (S2), SFTP browsing (F), and remote opencode tunnels (R). It deliberately
ships NO terminal, NO SFTP, NO tunnels — only profiles, encrypted credentials, a
connection manager, IPC, and a Settings card.

Branch: stay on `feat/opencode-provider` (the fork accumulates there). Conventional
commits, no Co-Authored-By. pnpm only. All checks green before handoff:
`pnpm typecheck`, `pnpm test` (the 17 pre-existing jsdom/localStorage failures in
agent-preference/panes/session-list-preferences are environmental — verified identical
on clean main; anything else must be fixed), `pnpm lint`, `pnpm format:check`.

## New dependency

`ssh2` (pure JS; its optional native `cpu-features` dep is NOT needed — do not add
native modules beyond the existing two). One `pnpm add ssh2` and nothing else.

## Main process — `src/main/servers/`

### `profiles.ts` — the on-device server registry

- Storage: `servers.json` in `app.getPath("userData")`; schema-versioned object
  `{ version: 1, servers: ServerProfile[] }`. Tolerant read (missing/corrupt → empty,
  like app-settings' own resilient-read pattern).
- `ServerProfile` (shared type, lives in `src/shared/servers.ts` so the renderer gets
  it for free through the preload):
  ```ts
  interface ServerProfile {
    id: string; // nanoid-style, minted on create
    name: string; // required, non-empty
    group: string; // free text; "" = ungrouped
    host: string;
    port: number; // default 22
    username: string;
    authMode: "password" | "key" | "agent";
    keyPath?: string; // key mode: path to private key file
    createdAtMs: number;
    lastConnectedMs?: number;
  }
  ```
- Credentials NEVER live in servers.json and never in the analytics DB. Separate file
  `servers-credentials.json` mapping profile id → Electron `safeStorage.encryptString`
  blobs: password (password mode) and key passphrase (key mode). Corrupt/undecryptable
  entries read as absent (treat as "credential missing", not a crash). safeStorage is
  only touched after app ready — construct lazily, mirroring how other main services
  are wired inside `app.whenReady`.
- CRUD: `list()`, `save(profile)` (upsert, validates), `remove(id)` (also drops the
  credential entry). Pure, injectable fs for tests.

### `connection-manager.ts` — the ssh2 pool

- `createConnectionManager(deps)` — one instance at the composition root.
- `connect(profileId)`: resolves profile + credential, dials ssh2 with
  `readyTimeout: 10_000`, `keepaliveInterval: 15_000`, `keepaliveCountMax: 3`;
  auth per mode (password / key file + passphrase / agent via `agent: process.env.SSH_AUTH_SOCK`).
- Pool semantics: at most one live connection per profile id; a second `connect` for a
  live id returns the existing handle. `disconnect(profileId)` tears down gracefully.
  Dead connections are evicted on socket close/error.
- `status(): Record<profileId, "connecting" | "connected" | "error" | "offline">` —
  the renderer POLLS this (app rule: request/response, no main-side push timers).
  `lastError?: string` per profile surfaced for the settings row.
- `test(profile, credential?)`: dial with a 10s cap, `exec "echo ok"`, close. Resolves
  `{ ok: true } | { ok: false, error }`. Used by the Settings card's Test button —
  works on an UNSAVED form too (takes the raw values, doesn't touch storage).
- The manager owns NO knowledge of shells/SFTP/forwards; those arrive in S2/F/R and
  borrow the pooled `Client` via `withClient(profileId, fn)`.
- Injectable ssh2 factory + clock for tests; no real network in unit tests.

## IPC (`src/shared/ipc.ts` + `src/main/ipc.ts` + preload)

Follow the existing pattern exactly (channel names in the IPC record, handlers in
registerIpc, types through the preload bridge):

- `servers.list()` → `ServerProfile[]` (never credentials)
- `servers.save(profile)` → `ServerProfile`
- `servers.remove(id)` → void
- `servers.setCredential(id, { password?, passphrase? })` → void
- `servers.status()` → the status record + lastError map
- `servers.test(input: { profile fields, password?, passphrase? })` →
  `{ ok: true } | { ok: false; error: string }`

## Renderer — Settings → Servers card

- New card `ServerCard` in the System section (below the CLI cards), following
  AgentCliCard's visual pattern (Card, page-primitives, existing spacing tokens). NO
  new design language — designer polish comes later as its own pass.
- Rows: name, group chip, host:port, user, auth-mode badge, status dot, Test button
  (spinner while running, ok/error inline), edit, delete (confirm dialog pattern if
  one exists — else the app's standard destructive confirmation).
- Add/edit form: the ServerProfile fields; password/passphrase inputs write through
  `servers.setCredential` (never round-tripped — the form shows "saved" placeholder
  state, not the value).
- Group ordering: grouped rows (ungrouped last), alphabetical inside groups.
- i18n: en + zh for every new string (follow the i18n module's structure).

## Tests

`tests/servers/` mirroring source: profiles CRUD + credential encryption separation
(mocked safeStorage), connection-manager pool semantics + auth resolution with a
stubbed ssh2 Client (connect/ready/error/close transitions, keepalive config, test()
ok/error paths), and the IPC handler wiring (following how existing ipc handler tests
do it — if none exist, test the modules directly and note it).

## Out of scope (later passes — do NOT build)

SFTP, SSH terminals, port forwards, remote opencode transport, drag/drop UI,
command palette, anything in EXPANSION_ROADMAP.md beyond S1.
