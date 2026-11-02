/**
 * The SFTP file manager's IPC (pass F): the `servers:sftp:*` family over the app-level
 * `sftp-service.ts`. Same conventions as every servers handler — never rejects, `{ok:false,
 * error}` in-band, raw input re-shaped rather than trusted, and the renderer never sees
 * credentials or an ssh2 object (only serverId/path shapes).
 *
 * The two cross-boundary ops consult the NATIVE dialogs here (main-side, like every other
 * Electron dialog call in this app): download → save (single) / directory (multi); upload with
 * an empty localPaths array → the multi-file open picker (the drag-drop path passes concrete
 * paths instead). A UI cancel is a typed `{ok:true, canceled:true}` — not an error.
 *
 * The transfer-progress push attaches here (this window's renderer) and detaches on window
 * close; the service itself is app-level so onDown kills transfers even while no window shows
 * them. Everything else is a straight service delegation.
 */
import {
  app,
  dialog,
  ipcMain,
  BrowserWindow,
} from "electron";
import { SFTP, type SftpTransferSnapshot } from "@shared/sftp";
import { remoteBasename } from "./sftp-paths";
import type { SftpService } from "./sftp-service";

/** The never-hallucinate path: a string array from an unknown sender becomes only its string
 *  members (empty NUL payloads filtered out — the paths module rejects them anyway). */
const stringArrayOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];

const joinDirname = (path: string): string => {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? "/" : path.slice(0, cut);
};

export function registerSftpIpc({
  window,
  service,
}: {
  window: BrowserWindow;
  service: SftpService;
}): { noteDown: (serverId: string) => void } {
  service.setPush((snapshot: SftpTransferSnapshot) => {
    if (!window.isDestroyed()) {
      window.webContents.send(SFTP.event, snapshot);
    }
  });

  const requireServer = (raw: unknown): string | null =>
    typeof raw === "string" && raw.length > 0 ? raw : null;

  ipcMain.handle(SFTP.list, (_e, rawServerId: unknown, rawDir: unknown) => {
    const serverId = requireServer(rawServerId);
    if (!serverId || typeof rawDir !== "string") {
      return Promise.resolve({ ok: false, error: "Invalid request." });
    }
    return service.list(serverId, rawDir);
  });

  ipcMain.handle(SFTP.stat, (_e, rawServerId: unknown, rawPath: unknown) => {
    const serverId = requireServer(rawServerId);
    if (!serverId || typeof rawPath !== "string") {
      return Promise.resolve({ ok: false, error: "Invalid request." });
    }
    return service.stat(serverId, rawPath);
  });

  ipcMain.handle(SFTP.home, (_e, rawServerId: unknown) => {
    const serverId = requireServer(rawServerId);
    if (!serverId) {
      return Promise.resolve({ ok: false, error: "Invalid request." });
    }
    return service.home(serverId);
  });

  ipcMain.handle(SFTP.mkdir, (_e, rawServerId: unknown, rawPath: unknown) => {
    const serverId = requireServer(rawServerId);
    if (!serverId || typeof rawPath !== "string") {
      return Promise.resolve({ ok: false, error: "Invalid request." });
    }
    return service.mkdir(serverId, rawPath);
  });

  ipcMain.handle(
    SFTP.rename,
    (_e, rawServerId: unknown, rawFrom: unknown, rawTo: unknown) => {
      const serverId = requireServer(rawServerId);
      if (!serverId || typeof rawFrom !== "string" || typeof rawTo !== "string") {
        return Promise.resolve({ ok: false, error: "Invalid request." });
      }
      return service.rename(serverId, rawFrom, rawTo);
    },
  );

  ipcMain.handle(
    SFTP.deleteFn,
    async (_e, rawServerId: unknown, rawPaths: unknown) => {
      const serverId = requireServer(rawServerId);
      if (!serverId) {
        return { ok: false, error: "Invalid request." };
      }
      return service.delete(serverId, stringArrayOf(rawPaths));
    },
  );

  ipcMain.handle(
    SFTP.download,
    async (_e, rawServerId: unknown, rawPaths: unknown): Promise<unknown> => {
      const serverId = requireServer(rawServerId);
      const paths = stringArrayOf(rawPaths);
      if (!serverId || !paths.length) {
        return { ok: false, error: "Nothing selected to download." };
      }
      // The native dialogs ride main (single → save with the remote name; multi → folder).
      if (paths.length === 1) {
        const save = await dialog.showSaveDialog(window, {
          defaultPath: remoteBasename(paths[0]),
        });
        if (save.canceled || !save.filePath) {
          return { ok: true, skippedLocal: 0, canceled: true };
        }
        return service.download(
          serverId,
          paths,
          joinDirname(save.filePath),
          save.filePath,
        );
      }
      const open = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
      });
      if (open.canceled || open.filePaths.length === 0) {
        return { ok: true, skippedLocal: 0, canceled: true };
      }
      return service.download(serverId, paths, open.filePaths[0]);
    },
  );

  ipcMain.handle(
    SFTP.upload,
    async (
      _e,
      rawServerId: unknown,
      rawDir: unknown,
      rawPaths: unknown,
      rawOpts: unknown,
    ): Promise<unknown> => {
      const serverId = requireServer(rawServerId);
      if (!serverId || typeof rawDir !== "string") {
        return { ok: false, error: "Invalid request." };
      }
      let localPaths = stringArrayOf(rawPaths);
      if (localPaths.length === 0) {
        // The Upload Here… menu path: the native multi-file picker resolves the sources.
        const open = await dialog.showOpenDialog(window, {
          properties: ["openFile", "multiSelections"],
        });
        if (open.canceled || open.filePaths.length === 0) {
          return { ok: true, skippedLocal: 0, canceled: true };
        }
        localPaths = open.filePaths;
      }
      const opts = { overwrite: rawOpts === true || (rawOpts as { overwrite?: unknown } | null | undefined)?.overwrite === true };
      return service.upload(
        serverId,
        rawDir,
        localPaths,
        opts.overwrite ? opts : undefined,
      );
    },
  );

  ipcMain.handle(
    SFTP.copy,
    async (
      _e,
      rawServerId: unknown,
      rawItems: unknown,
    ): Promise<unknown> => {
      const serverId = requireServer(rawServerId);
      if (!serverId || !Array.isArray(rawItems)) {
        return { ok: false, error: "Nothing to paste." };
      }
      const items = rawItems
        .map((value) => {
          if (!value || typeof value !== "object") return null;
          const r = value as { from?: unknown; to?: unknown };
          return typeof r.from === "string" && typeof r.to === "string"
            ? { from: r.from, to: r.to }
            : null;
        })
        .filter((v): v is { from: string; to: string } => v !== null);
      return service.copy(serverId, items);
    },
  );

  ipcMain.on(SFTP.cancel, (_e, rawTransferId: unknown) => {
    if (typeof rawTransferId === "string" && rawTransferId.length > 0) {
      service.cancel(rawTransferId);
    }
  });

  ipcMain.handle(SFTP.transfers, () => service.transfers());

  const onBeforeQuit = (): void => service.disposeAll();
  app.on("before-quit", onBeforeQuit);

  window.on("closed", () => {
    service.setPush(null);
    if (BrowserWindow.getAllWindows().length === 0) {
      // No window left to receive pushes and no pane to poll — tear the transfer state down
      // (macOS keeps the app; only a REAL quit reaches here through before-quit instead).
      service.disposeAll();
    }
    app.removeListener("before-quit", onBeforeQuit);
    for (const channel of [
      SFTP.list,
      SFTP.stat,
      SFTP.home,
      SFTP.mkdir,
      SFTP.rename,
      SFTP.deleteFn,
      SFTP.download,
      SFTP.upload,
      SFTP.copy,
      SFTP.transfers,
    ] as const) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.removeAllListeners(SFTP.cancel);
  });

  return { noteDown: (serverId) => service.noteDown(serverId) };
}
