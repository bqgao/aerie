/**
 * The SFTP pane's live store (pass F): the pane's ONE server context (selected server, cwd per
 * server so switching back restores the place), the names cache per directory (the conflict
 * probe's fast path), the server-scoped clipboard, and theір transfer registry mirror (push-fed,
 * poll-fed on re-attach). Window-guarded like the other shell stores. Pure rules live in
 * sftp-model.ts; atoms + lifecycle live here.
 */
import { atom } from "nanostores";
import type { SftpEntry, SftpTransferSnapshot } from "@shared/sftp";
import type { SftpClipboard } from "./sftp-model";

/** The pane's working context keyed by serverId: cwd + a racy names cache per directory. */
export interface SftpServerContext {
  cwd: string;
  /** The CURRENT dir's entry names (the conflict probe's pull-warm answer; may be stale — the
   *  real arbiter is main's stat/rename response). */
  cwdNames: ReadonlySet<string>;
  /** The server's home (resolved once via realpath). */
  home: string | null;
}
export const $sftpServerId = atom<string | null>(null);
export const $sftpContext = atom<Record<string, SftpServerContext>>({});
export const $sftpClipboard = atom<SftpClipboard>(null);

/** Visible if the pane id registered in panes.ts turned open this session. */
export const SFTP_PANE_ID = "sftp";

export function setSftpServer(id: string | null): void {
  $sftpServerId.set(id);
  // Server scope change = the clipboard rule: cleared (cut/copied remote entries carry no
  // meaning across servers). Applied even when the NEW server is null (closing the pane).
  $sftpClipboard.set(null);
  if (!id) return;
  const contexts = $sftpContext.get();
  if (!contexts[id]) {
    $sftpContext.set({
      ...contexts,
      [id]: { cwd: "/", cwdNames: new Set(), home: null },
    });
  }
}

export function sftpContextOf(id: string): SftpServerContext {
  return $sftpContext.get()[id] ?? { cwd: "/", cwdNames: new Set(), home: null };
}

export function setSftpCwd(id: string, cwd: string, names: Iterable<string>): void {
  const contexts = $sftpContext.get();
  $sftpContext.set({
    ...contexts,
    [id]: {
      ...sftpContextOf(id),
      cwd,
      cwdNames: new Set(names),
    },
  });
}

export function setSftpHome(id: string, home: string): void {
  const contexts = $sftpContext.get();
  $sftpContext.set({
    ...contexts,
    [id]: { ...sftpContextOf(id), home },
  });
}

/** Keep the names cache honest after in-place mutations (mkdir/rename/delete/paste settle). */
export function refreshCwdNames(id: string, entries: readonly SftpEntry[]): void {
  const ctx = sftpContextOf(id);
  setSftpCwd(id, ctx.cwd, entries.map((e) => e.name));
}

/** The clipboard's write path (paste/cut/copy set it; a paste clears on success). */
export function setSftpClipboard(value: SftpClipboard): void {
  $sftpClipboard.set(value);
}

/** The push-fed transfer mirror (onEvent snapshot) — the strip reads live rows. */
export const $sftpTransfers = atom<SftpTransferSnapshot>([]);
export function setSftpTransfers(snapshot: SftpTransferSnapshot): void {
  $sftpTransfers.set([...snapshot]);
}
