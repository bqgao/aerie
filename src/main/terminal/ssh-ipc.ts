import { app, ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import {
  SSH_TERMINAL,
  type SshTerminalSpawnResult,
} from "@shared/ssh-terminal";
import type { SshClientRpc } from "../servers/connection-manager";
import type { DataBufferer } from "./data-bufferer";
import { createSshTerminalManager, type SshShellWindow } from "./ssh-session";

/** The slice of the connection pool the ssh terminals use. borrow-only: the pool stays the only
 *  owner of credentials and dial semantics (S1 pattern) — this layer never sees either. */
export interface SshTerminalConnectionPool {
  connect(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  withClient<T>(id: string, fn: (rpc: SshClientRpc) => T): T | null;
}

/** Normalize the remote pseudo-terminal request nothing gets to lie about. */
export function normalizeSshShellWindow(
  cols: unknown,
  rows: unknown,
): SshShellWindow {
  const clamp = (v: unknown, fallback: number): number => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : fallback;
  };
  return {
    term: "xterm-256color",
    cols: clamp(cols, 80),
    rows: clamp(rows, 24),
  };
}

/**
 * Register the ssh-terminal IPC against one window: the THIRD terminal manager, on its own
 * `shellterm:ssh:*` channels. never-rejects on the spawn handler — a refused pool dial (auth
 * failure, unreachable host, unknown profile) answers `{ ok: false, error }` BEFORE any session
 * exists, so no dead tab spawns and the reason stays the pool's sticky row lastError (S1).
 *
 * The pooled connection is APP-level, not window-level: closing the window closes the shell
 * channels (disposeAll) but NOT the connection, which other surfaces still share. `noteDown` is
 * handed to the pool's onDown at the composition root so a live drop ends every riding session
 * with the reason "dropped".
 */
export function registerSshTerminalIpc({
  window,
  connectionManager,
  createBufferer,
}: {
  window: BrowserWindow;
  connectionManager: SshTerminalConnectionPool;
  /** Injected in tests (synchronous passthrough); defaults to the 5ms coalescer (like every
   *  other terminal manager — ssh-ipc is the composition ROOT for this one, so tests inject here). */
  createBufferer?: (flush: (data: string) => void) => DataBufferer;
}): { noteDown: (serverId: string) => void } {
  const manager = createSshTerminalManager({
    createBufferer,
    send: (id, data, offset) => {
      if (!window.isDestroyed())
        window.webContents.send(SSH_TERMINAL.data, id, data, offset);
    },
    notifyExit: (id, exitCode, reason) => {
      if (!window.isDestroyed())
        window.webContents.send(SSH_TERMINAL.exit, id, exitCode, reason);
    },
    // Borrow the live pooled client and open the shell window on it. The optional `shell` member
    // only falsifies for a pool-level fake that can't open channels (the real factory always
    // provides it) — fail the open in-band like any other refused dial.
    openShell: (serverId, openWindow, cb) => {
      const borrowed = connectionManager.withClient(serverId, (rpc) => {
        if (!rpc.shell) {
          cb(
            new Error("The pooled connection cannot open shell channels."),
            null,
          );
          return;
        }
        rpc.shell(openWindow, (err, stream) =>
          cb(
            err === undefined || err === null
              ? null
              : err instanceof Error
                ? err
                : new Error(String(err)),
            stream ?? null,
          ),
        );
        return true;
      });
      if (!borrowed) cb(new Error("The server is not connected."), null);
    },
  });

  // Sessions to skip OPEN for because their renderer closed the tab while the pool dial was still
  // resolving (ipc events preserve order in each direction, but a spawn handler's await re-opens
  // the window the close listener already ran in): renderer-minted id → skip.
  const closedWhileConnecting = new Set<string>();

  ipcMain.handle(
    SSH_TERMINAL.spawn,
    async (_e, raw: unknown): Promise<SshTerminalSpawnResult> => {
      // Main re-shapes rather than trusting (same input discipline as the existing server calls).
      if (!raw || typeof raw !== "object") {
        return { ok: false, error: "Malformed ssh terminal request." };
      }
      const req = raw as {
        id?: unknown;
        serverId?: unknown;
        cols?: unknown;
        rows?: unknown;
      };
      if (
        typeof req.id !== "string" ||
        req.id.length === 0 ||
        typeof req.serverId !== "string" ||
        req.serverId.length === 0
      ) {
        return { ok: false, error: "Malformed ssh terminal request." };
      }
      const windowSpec = normalizeSshShellWindow(req.cols, req.rows);
      // Pool dial first: every refusal surfaces BEFORE any session exists, so the renderer spawns
      // no dead tab; the reason is already sticky on the server row (S1 semantics).
      const dialed = await connectionManager.connect(req.serverId);
      if (!dialed.ok) return dialed;
      if (closedWhileConnecting.has(req.id)) {
        // The tab died while the dial was resolving: the channel must never stand up.
        closedWhileConnecting.delete(req.id);
        return { ok: true };
      }
      manager.open({
        id: req.id,
        serverId: req.serverId,
        cols: windowSpec.cols ?? 80,
        rows: windowSpec.rows ?? 24,
      });
      return { ok: true };
    },
  );
  const onWrite = (_e: IpcMainEvent, id: string, data: string) =>
    manager.write(id, data);
  const onResize = (_e: IpcMainEvent, id: string, cols: number, rows: number) =>
    manager.resize(id, cols, rows);
  const onAck = (_e: IpcMainEvent, id: string, charCount: number) =>
    manager.ack(id, charCount);
  const onClose = (_e: IpcMainEvent, id: string) => {
    closedWhileConnecting.add(id);
    manager.close(id);
  };
  ipcMain.on(SSH_TERMINAL.write, onWrite);
  ipcMain.on(SSH_TERMINAL.resize, onResize);
  ipcMain.on(SSH_TERMINAL.ack, onAck);
  ipcMain.on(SSH_TERMINAL.close, onClose);

  // Channels die with the window; the POOLED CONNECTION does not (other surfaces share it — the
  // disconnect is a Settings-level action only).
  const onBeforeQuit = () => manager.disposeAll();
  app.on("before-quit", onBeforeQuit);

  window.on("closed", () => {
    manager.disposeAll();
    app.removeListener("before-quit", onBeforeQuit);
    ipcMain.removeHandler(SSH_TERMINAL.spawn);
    ipcMain.removeListener(SSH_TERMINAL.write, onWrite);
    ipcMain.removeListener(SSH_TERMINAL.resize, onResize);
    ipcMain.removeListener(SSH_TERMINAL.ack, onAck);
    ipcMain.removeListener(SSH_TERMINAL.close, onClose);
  });

  return { noteDown: (serverId) => manager.noteDown(serverId) };
}
