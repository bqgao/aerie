/** SSH-terminal IPC channels — a THIRD terminal namespace, sibling of `terminal:*` (Managed) and
 *  `shellterm:*` (local footer shells). Separate channels for the same reasons the shell surface
 *  got its own (shell-terminal.ts): sharing would double-ack chunks between independent flow-control
 *  ledgers. `data` and `exit` are PUSH channels (main → renderer via webContents.send); the rest are
 *  renderer-initiated. Natural extension of the family: channels stay `shellterm:ssh:*` so the
 *  streaming semantics and kill/ack rules stay visibly shared with the shell surface. */
export const SSH_TERMINAL = {
  spawn: "shellterm:ssh:spawn",
  write: "shellterm:ssh:write",
  resize: "shellterm:ssh:resize",
  ack: "shellterm:ssh:ack",
  close: "shellterm:ssh:close",
  data: "shellterm:ssh:data",
  exit: "shellterm:ssh:exit",
} as const;

/** Spawn one remote shell channel on a saved server's pooled ssh2 client. The renderer mints `id`
 *  (unique per tab+attempt) and registers its router handler BEFORE invoking, so the very first
 *  channel bytes land on a live handler — the same race-free ordering every terminal spawn uses.
 *  Never rejects: a refused pool dial (auth failure, unreachable host, unknown profile) comes back
 *  as `{ ok: false, error }` BEFORE any session exists, so the renderer spawns no dead tab — the
 *  reason is already the pool's sticky row lastError (S1 semantics). */
export interface SshTerminalSpawnRequest {
  id: string;
  /** The saved server profile id. The renderer never sees credentials or a client — main resolves
   *  the pooled connection itself (the S1 auth pattern). */
  serverId: string;
  cols: number;
  rows: number;
}

export type SshTerminalSpawnResult = { ok: true } | { ok: false; error: string };

/** Why an ssh terminal session ended. `dropped` = the pooled connection died mid-session — the
 *  tab survives behind a lock overlay (buffer preserved) until Reconnect re-dials. `ended` = the
 *  remote shell exited (or the channel never opened) — the tab closes like a local shell's exit. */
export type SshTerminalExitReason = "dropped" | "ended";

/** The ssh-terminal surface on `window.api.terminalSsh`. Same wire conventions as the Managed and
 *  shell surfaces: write/resize/ack/close are fire-and-forget sends; onData carries the cumulative
 *  output offset; the on* subscriptions return unsubscribe functions. */
export interface SshTerminalApi {
  spawn(req: SshTerminalSpawnRequest): Promise<SshTerminalSpawnResult>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  ack(id: string, charCount: number): void;
  /** Tear one session down main-side (tab closed / superseded): closes the shell channel, NOT the
   *  pooled connection (other surfaces share it). */
  close(id: string): void;
  onData(cb: (id: string, data: string, offset: number) => void): () => void;
  onExit(
    cb: (id: string, exitCode: number, reason: SshTerminalExitReason) => void,
  ): () => void;
}
