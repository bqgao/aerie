/**
 * The editor's local-disk IPC (pass I-a): the three `fileio:*` channels over the app-level
 * service. Same handler conventions as every family — never rejects, `{ok:false, errorKind,
 * message}` in-band, raw input re-shaped rather than trusted. The one Electron-native op is the
 * open-file dialog (`pick`), riding main like every other dialog; a UI cancel is a typed
 * `{ok:true, canceled:true}`.
 *
 * The window teardown mirrors sftp-ipc: on `closed` every handler is dropped so a re-registered
 * second window starts clean.
 */
import { dialog, ipcMain } from "electron";
import { FILEIO } from "@shared/fileio";
import type { FileIoService } from "./fileio-service";

export function registerFileIoIpc({
  window,
  service,
}: {
  window: Electron.BrowserWindow;
  service: FileIoService;
}): void {
  ipcMain.handle(FILEIO.read, (_e, rawPath: unknown) => {
    if (typeof rawPath !== "string") {
      return Promise.resolve({
        ok: false,
        errorKind: "invalid-path",
        message: "Invalid path.",
      });
    }
    return service.read(rawPath);
  });

  ipcMain.handle(FILEIO.write, (_e, rawPath: unknown, rawContent: unknown) => {
    if (typeof rawPath !== "string") {
      return Promise.resolve({
        ok: false,
        errorKind: "invalid-path",
        message: "Invalid path.",
      });
    }
    return service.write(
      rawPath,
      typeof rawContent === "string" ? rawContent : "",
    );
  });

  ipcMain.handle(FILEIO.pick, async () => {
    const open = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
    });
    if (open.canceled || open.filePaths.length === 0) {
      return { ok: true, canceled: true };
    }
    return { ok: true, path: open.filePaths[0] };
  });

  window.on("closed", () => {
    for (const channel of [FILEIO.read, FILEIO.write, FILEIO.pick] as const) {
      ipcMain.removeHandler(channel);
    }
  });
}
