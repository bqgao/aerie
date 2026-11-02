/**
 * The server-PDF temp-cache IPC (pass I-b): the one `pdfTemp:*` channel over the app-level
 * service. Handler conventions as in fileio-ipc — never rejects, re-shaped input; the
 * window teardown removes the handler on `closed`, mirroring every per-window family.
 */
import { ipcMain } from "electron";
import { PDFTEMP } from "@shared/pdftemp";
import type { PdfTempService } from "./pdftemp-service";

export function registerPdfTempIpc({
  window,
  service,
}: {
  window: Electron.BrowserWindow;
  service: PdfTempService;
}): void {
  ipcMain.handle(PDFTEMP.open, (_e, rawServerId: unknown, rawPath: unknown) =>
    service.open(rawServerId, rawPath),
  );

  window.on("closed", () => {
    ipcMain.removeHandler(PDFTEMP.open);
  });
}
