# Otty-inspired tier-1 — Inbox, hover preview, fork, prompt queue

Four features in TWO implementation runs (scope discipline — no run may carry all four).

Verified API contracts (probed against the local v2 service, 2026-11-02):

- Fork: `POST /api/session/:id/fork` with body `{}` → 200; response `data` is the NEW
  session row (id, title, time, projectID, model, cost, tokens) carrying a `fork`
  field `{ sessionID, boundary: { type: "through", messageID } }`. Parent's messages
  are inherited through the boundary message.
- Prompt: `POST /api/session/:id/prompt` with body `{"text": "..."}` → 200; response
  `data` is the user message envelope `{ id, sessionID, time, type: "user",
payload: { text }, delivery }`. Errors: 400 `{_tag: "InvalidRequestError", …}`.
- Auth: HTTP Basic `opencode:<service password>` (local + remote transport alike).
- Cleanup note: DELETE `/api/session/:id` → 204 (used by the orchestrator's probe).

## Run 1 — A1 Inbox + A2 hover preview (renderer-only; the data is already polled)

### A1 Inbox mode

- The sessions rail header gains a segmented toggle: **All / Inbox** (persisted per
  renderer lifetime in a nanostore atom — NOT in app settings; default All).
- Inbox = sessions whose derived state is waiting-on-user (the summarize's
  waiting/idle signals; exclude busy/working and healthy ended sessions).
- Rows in Inbox mode show a reason chip (waitingReason already flows from the
  providers; map to short i18n strings; unknown reason → generic "waiting").
- Order: most recently waiting first. Empty state with a one-line explanation.
- The managed/agent rows and server rows keep their existing row grammar — the
  filter composes with the existing pinned/hidden logic, it must not fight it.

### A2 Hover preview card

- Hovering a rail row (300ms delay) shows a preview card near the row: title,
  state + waitingReason (same mapping as A1), directory, cost, and a 2-line
  snippet of the last assistant reply (the overview/summarize data the rail
  already polls — NO new IPC).
- Dismiss: mouse-leave (with a small grace so diagonal mouse travel doesn't kill
  it), Escape, scroll. Only one card at a time. Never on touch or while dragging.
- The card is read-only — no actions inside v1.

## Run 2 — A3 fork + A4 prompt queue + A5 waiting signals (client/ipc/provider extensions)

### A3 Fork (opencode)

- `client.ts` gains `forkSession(sessionId)` → POST fork, `{}` body (contract above);
  both the local service client and the remote transport path get the op.
- Provider composite gains a fork arm for opencode (currently claude-only); registry:
  `opencode.hasFork = true` (the flag already exists in AgentCapabilities).
- Rail row context menu (opencode sessions only, capability-gated): "Fork" → call →
  optimistic refresh → the new session appears (its row shows a small "fork" badge
  if the `fork` field is present) → focus it.
- No terminal spawn on fork v1 (the session exists; the user opens it like any
  managed session — spawn pins the minted id, which the fork already has).

### A4 Prompt queue

- `client.ts` gains `promptSession(sessionId, text)` (contract above); ipc channel +
  provider arm (local + remote sources; remote prompt rides the transport client —
  the main process resolves the URL/credentials, same as remote spawns).
- Renderer: per-session queue (nanostore, renderer lifetime only). Input affordance:
  the rail row's context menu → "Queue prompt…" (small modal: textarea + Enter to
  queue). While the session is working, prompts park in the queue (count badge on
  the row); when the poll sees the session return to waiting AND the queue is
  non-empty, auto-send the head (one per poll tick), badge decrements.
- Sending failure → the queue keeps the prompt, badge turns warning-color, a
  one-line error surfaces in the row (in-band error strings, never rejections).
- The queue is visible but NOT editable in v1 (no reordering; clear via menu).

### A5 opencode waiting signals + waitingReason threading (REQUIRED — Run 1 discovery)

- Run 1 shipped the Inbox, but its review found: `provider/opencode/state.ts`
  `signalsFor` NEVER reports `waiting`/`awaitingUser`, so opencode sessions can
  never enter the Inbox — and `Session.waitingReason` is declared renderer-side
  but never populated by the summarize/sync path for ANY agent (the Run 1 chips
  always fall back to the generic "waiting" label).
- Provider fix: an opencode session is WAITING when its last message is from the
  assistant (agent turn complete) AND the session is not in the `/active` map;
  waitingReason = "Turn complete" (generic; a permission-pending refinement is
  optional if the data is already in hand).
- Sync fix: thread the transcript-doc `waitingReason` (already computed by all
  three providers' transcript readers) into the session row payload the rail
  polls, so the Run 1 reason chips activate for claude/codex/opencode alike.
- Tests: signalsFor waiting derivation (fixture rows), waitingReason threading
  through the summarize/sync payload shape.

## Cross-cutting rules

- en + zh for every string; tests for: inbox filter reducer, reason mapping, hover
  card show/hide state machine, fork wiring (fake client), queue state machine
  (enqueue/send-on-idle/failure-keeps/badge) as pure reducers.
- Handlers never reject; remote ops resolve credentials main-side only.
- Validation gates per run: pnpm typecheck · pnpm test · pnpm lint
  (./node_modules/.bin/eslint .) · pnpm format:check · pnpm dev boot check.
