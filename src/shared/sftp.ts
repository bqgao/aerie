/**
 * The SFTP file manager's cross-process types (pass F). Lives in @shared so the renderer gets
 * the shapes through the preload bridge like every other IPC payload. NOTE: no credential
 * material ever appears here — SFTP operations ride the pooled ssh2 client resolved MAIN-side;
 * the renderer sends only { serverId, path } shapes.
 */

/** The `servers:sftp:*` channel family (DESIGN_NOTES §F note 2). `list/stat/mkdir/rename/
 *  delete/home/cancel/transfers/pickLocations` are renderer-initiated (invoke, all never-reject);
 *  `event` is the ONE push channel (main → renderer via webContents.send): chunked-transfer
 *  progress rides it so the transfers strip updates without a dedicated poll burst — the app's
 *  "renderer polls" rule bends only for terminal data (S2), and per DESIGN_NOTES F, transfer
 *  metadata is the second (and last) sanctioned bend. A full registry snapshot for initial fill
 *  rides `transfers` (the pane's regular poll), so a push missed while the pane was closed is
 *  harmless. */
export const SFTP = {
  list: "servers:sftp:list",
  stat: "servers:sftp:stat",
  mkdir: "servers:sftp:mkdir",
  createFile: "servers:sftp:createFile",
  rename: "servers:sftp:rename",
  deleteFn: "servers:sftp:delete",
  home: "servers:sftp:home",
  download: "servers:sftp:download",
  upload: "servers:sftp:upload",
  copy: "servers:sftp:copy",
  cancel: "servers:sftp:cancel",
  transfers: "servers:sftp:transfers",
  event: "servers:sftp:event",
  /** Pass I-a: the editor pane's in-place server reads/writes (same channel cache). */
  readFile: "servers:sftp:readFile",
  writeFile: "servers:sftp:writeFile",
} as const;

/** One directory entry, normalized main-side from an sftp readdir + attrs. */
export interface SftpEntry {
  /** The bare child name (never a path). */
  name: string;
  size: number;
  /** Seconds-since-epoch mtime, client-locale-formatted in the renderer. */
  mtimeMs: number;
  kind: "file" | "dir" | "symlink";
}

export type SftpListResult =
  | { ok: true; entries: SftpEntry[]; path: string }
  | {
      ok: false;
      error: string;
      /** ssh2 answered "no such path" — the NOT_FOUND breadcrumb case. */ notFound?: boolean;
    };

export type SftpStatResult =
  | { ok: true; entry: SftpEntry }
  | { ok: false; error: string; notFound?: boolean };

/** Pass I-a: the editor's server-file read — UTF-8, capped at the first 512KiB (the sniff +
 *  cap both run SERVER-side of the IPC boundary, so binary payloads never cross). Bytes = the
 *  slice's byte length. Failures carry the usual `notFound` crumb plus `binary` when the NUL
 *  sniff fired, so the renderer can key its message view from either. */
export const SFTP_FILE_CAP_BYTES = 512 * 1024;

export type SftpFileReadResult =
  | { ok: true; content: string; bytes: number; capped: boolean }
  | { ok: false; error: string; notFound?: boolean; binary?: boolean };

export type SftpFailure = { ok: false; error: string };
export type SftpOk = { ok: true } | SftpFailure;

/** Delete: directories are recursive with per-child errors COLLECTED (DESIGN_NOTES F note 5) —
 *  a partial delete still answers ok, carrying what failed under `warnings`. */
export type SftpDeleteResult = { ok: true; warnings: string[] } | SftpFailure;

/** The queued-transfer ops (download/upload): `skippedLocal` counts in-band skips (vanished/
 *  unreadable local file, a directory in a files-only pass, a non-overwrite collision); a UI
 *  cancel of the NATIVE picker is NOT an error — `canceled` says so and nothing was queued. */
export type SftpQueuedResult =
  | { ok: true; skippedLocal: number; canceled?: boolean }
  | SftpFailure;

/** The transfer registry row (mirrored to the renderer via poll + push). */
export type SftpTransferStatus = "active" | "done" | "failed" | "canceled";

export interface SftpTransfer {
  id: string;
  direction: "upload" | "download" | "copy";
  serverId: string;
  /** The REMOTE path (the local path for an upload is kept in fromLocalPath). */
  remotePath: string;
  /** Uploads: the local source (also carried for context on downloads' destination dir). */
  fromLocalPath?: string;
  /** Downloads: where the file lands (chosen in main's native dialog). */
  localPath?: string;
  name: string;
  bytesDone: number;
  /** null when the size can't be known up front (rare; the bar goes indeterminate). */
  bytesTotal: number | null;
  status: SftpTransferStatus;
  /** A transfer dropped mid-flight because the pooled connection died. */
  dropped?: boolean;
  error?: string;
}

export type SftpTransferSnapshot = SftpTransfer[];

/** The progress-bar fraction for one transfer row (0 when the total is unknown → the bar goes
 *  indeterminate instead of lying at 0). Pure too, so main and renderer share the math. */
export function sftpTransferFraction(
  bytesDone: number,
  bytesTotal: number | null,
): number {
  if (bytesTotal === null || bytesTotal <= 0) return 0;
  return Math.max(0, Math.min(1, bytesDone / bytesTotal));
}

/**
 * The sftp surface on `window.api.sftp` — all invokes are never-reject by contract (the bridge
 * still awaits). There is no explicit open/close of an "sftp session": main keeps ONE sftp
 * channel per server, opened lazily on the first op, evicted on any channel-level failure, and
 * killed with the pooled connection (other ops on a dead channel answer in-band until it opens).
 */
export interface SftpApi {
  list(serverId: string, dir: string): Promise<SftpListResult>;
  stat(serverId: string, path: string): Promise<SftpStatResult>;
  /** Pass I-a (the editor pane): read one remote text file — stat-guarded, chunked over the
   *  channel cache, 512KiB cap + NUL sniff server-side. Never rejects. */
  readFile(serverId: string, path: string): Promise<SftpFileReadResult>;
  /** Write one remote text file with SFTP "w" truncation (the upload's overwrite semantics);
   *  a partial write answers a failure like an upload row does. Never rejects. */
  writeFile(serverId: string, path: string, content: string): Promise<SftpOk>;
  /** Resolve the server's home directory (SFTPv3 realpath ".") — the pane's first context. */
  home(serverId: string): Promise<{ ok: true; path: string } | SftpFailure>;
  mkdir(serverId: string, path: string): Promise<SftpOk>;
  /** Create an empty remote file (New File…). */
  createFile(serverId: string, path: string): Promise<SftpOk>;
  rename(serverId: string, from: string, to: string): Promise<SftpOk>;
  delete(serverId: string, paths: string[]): Promise<SftpDeleteResult>;
  /** Download `remotePaths` — main shows the native save dialog (single) or folder-picker
   *  (multi), then registers + starts chunked transfers. Progress arrives via SFTP.event. */
  download(serverId: string, remotePaths: string[]): Promise<SftpQueuedResult>;
  /** Upload local paths into remote `dir`. The renderer resolves conflict policy FIRST (stat
   *  probes or the cached list) and passes `overwrite` for confirmed collisions + `renameAs`
   *  (localPath → remote name) for the Rename choice. Empty `localPaths` opens the native
   *  multi-file picker in main instead (the Upload Here… menu). */
  upload(
    serverId: string,
    dir: string,
    localPaths: string[],
    opts?: { overwrite?: boolean; renameAs?: Record<string, string> },
  ): Promise<SftpQueuedResult>;
  /** Server-side copy (the remote Paste): per-item `from`→`to` pairs with conflicts PRE-solved
   *  by the renderer (rename-suffix already applied). SFTPv3 has no server-side copy op, so
   *  main streams each pair through the one channel — rows appear in the transfers strip. */
  copy(
    serverId: string,
    items: Array<{ from: string; to: string }>,
  ): Promise<SftpQueuedResult>;
  cancel(transferId: string): void;
  /** The full registry snapshot (the pane's poll for initial fill + missed pushes). */
  transfers(): Promise<SftpTransferSnapshot>;
  /** Subscribe to transfer-progress pushes (a throttled snapshot of the registry). Returns
   *  unsubscribe, like every push subscription. */
  onEvent(cb: (snapshot: SftpTransferSnapshot) => void): () => void;
}
