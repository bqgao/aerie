/**
 * The Editor pane's I/O actions (pass I-a): the open/save flows shared by the pane itself and
 * the SFTP pane's context menu ("Edit" → openServerInEditor). Module-level (outside React) so
 * non-component callers can use them without hooks; wording comes live from the locale atom.
 * Every failure is in-band — failed reads/saves still land in the tab model with a localized
 * message; nothing here rejects into the UI.
 */
import { $locale } from "../../i18n";
import { TRANSLATIONS } from "../../i18n/catalog";
import type { FileIoErrorKind } from "@shared/fileio";
import { $serverProfiles } from "../../shell-terminal/ssh-model";
import { setPaneOpen } from "../panes";
import {
  $editorActiveId,
  applyTabRead,
  applyTabSaved,
  editorTabOf,
  openEditorTab,
  EDITOR_PANE_ID,
} from "./editor-store";
import {
  isDirty,
  isPdfName,
  basenameEditorish,
  pdfLocalUrlOf,
  readOnlyReason,
  serverOriginOf,
  tabIdOf,
  type EditorOrigin,
  type EditorTab,
} from "./editor-model";

/** Live wording for the editor's in-band messages (the locale atom decides). */
export const editorErrors = () => TRANSLATIONS[$locale.get()].editor.errors;

/** The fileio errorKind → i18n mapping (the renderer never parses the raw message). */
function localizeFileIo(kind: FileIoErrorKind, message: string): string {
  const errors = editorErrors();
  switch (kind) {
    case "invalid-path":
      return errors.invalidPath;
    case "forbidden-path":
      return errors.forbiddenPath;
    case "not-found":
      return errors.notFound;
    case "binary":
      return errors.binary;
    default:
      return errors.readFailed(message);
  }
}

/** Server read failures: the binary/notFound crumbs map first, else the raw error. */
function localizeSftpRead(res: {
  binary?: boolean;
  notFound?: boolean;
  error: string;
}): string {
  const errors = editorErrors();
  if (res.binary) return errors.binary;
  if (res.notFound) return errors.notFound;
  return errors.readFailed(res.error);
}

/** Server-PDF pull failures: the temp-cache crumbs (not found / over the 20MiB cap) map to
 *  the dedicated wording, the raw message otherwise. */
function localizePdfTempOpen(res: {
  notFound?: boolean;
  tooLarge?: boolean;
  error: string;
}): string {
  const errors = editorErrors();
  if (res.notFound) return errors.notFound;
  if (res.tooLarge) return errors.pdfTooLarge;
  return errors.readFailed(res.error);
}

/** Open + load one LOCAL file (the pick dialog and the drop paths funnel here). In-band: a
 *  failed read still lands a tab carrying the mapped message. PDFs route to the READ-ONLY
 *  viewer tab — no text read, no binary refusal (the name decides the kind). */
export async function openLocalPath(path: string): Promise<void> {
  const origin: EditorOrigin = { kind: "local", path };
  setPaneOpen(EDITOR_PANE_ID, true);
  openEditorTab(origin);
  const id = tabIdOf(origin);
  if (isPdfName(origin.path)) {
    applyTabRead(id, {
      ok: true,
      kind: "pdf",
      url: pdfLocalUrlOf(path),
      bytes: 0,
    });
    return;
  }
  const res = await window.api.fileio.read(path);
  applyTabRead(
    id,
    res.ok
      ? {
          ok: true,
          kind: "text" as const,
          content: res.content,
          bytes: res.bytes,
          capped: res.capped,
        }
      : { ok: false, message: localizeFileIo(res.errorKind, res.message) },
  );
}

/** The Open picker's Local… entry: the native dialog rides main (fileio:pick); a UI cancel
 *  is a typed no-op. */
export async function openLocalPick(): Promise<void> {
  const res = await window.api.fileio.pick();
  if (res.ok && "path" in res) await openLocalPath(res.path);
}

/** Open + load one SERVER file (the SFTP pane's Edit item and the Server… picker). The badge
 *  rides the profile's own opencode field; in-band failures land the tab as above. PDFs on a
 *  server bypass SFTP readFile (it refuses binaries) and ride main's temp-cache pull instead
 *  — the temp copy serves the webview while the tab keeps the server origin badge. */
export async function openServerInEditor(
  serverId: string,
  path: string,
): Promise<void> {
  const profile = $serverProfiles.get().find((s) => s.id === serverId);
  const origin = profile
    ? serverOriginOf(profile, path)
    : {
        kind: "server" as const,
        serverId,
        serverName: serverId,
        path,
        opencode: false,
      };
  setPaneOpen(EDITOR_PANE_ID, true);
  openEditorTab(origin);
  const id = tabIdOf(origin);
  if (isPdfName(basenameEditorish(path))) {
    const res = await window.api.pdfTemp.openPdfServer(serverId, path);
    applyTabRead(
      id,
      res.ok
        ? {
            ok: true,
            kind: "pdf" as const,
            url: res.fileUrl,
            bytes: res.bytes,
          }
        : { ok: false, message: localizePdfTempOpen(res) },
    );
    return;
  }
  const res = await window.api.sftp.readFile(serverId, path);
  applyTabRead(
    id,
    res.ok
      ? {
          ok: true,
          kind: "text" as const,
          content: res.content,
          bytes: res.bytes,
          capped: res.capped,
        }
      : { ok: false, message: localizeSftpRead(res) },
  );
}

/** Save through the origin's channel; true = landed (snapshot re-based, dirty cleared). A
 *  capped tab isn't editable so it never saves. */
export async function saveActive(): Promise<boolean> {
  const tabId = $editorActiveId.get();
  if (!tabId) return false;
  const tab = editorTabOf(tabId);
  if (!tab || !isDirty(tab) || readOnlyReason(tab)) return false;
  if (tab.origin.kind === "server") {
    const res = await window.api.sftp.writeFile(
      tab.origin.serverId,
      tab.origin.path,
      tab.draft,
    );
    applyTabSaved(
      tabId,
      res.ok
        ? { ok: true }
        : { ok: false, message: editorErrors().saveFailed(res.error) },
    );
    return res.ok;
  }
  const res = await window.api.fileio.write(tab.origin.path, tab.draft);
  applyTabSaved(
    tabId,
    res.ok
      ? { ok: true }
      : { ok: false, message: localizeFileIo(res.errorKind, res.message) },
  );
  return res.ok;
}

export type { EditorTab };
