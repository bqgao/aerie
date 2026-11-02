/**
 * The editor's server-PDF temp-cache IPC (pass I-b). A PDF tab for a file on a remote
 * server is served from a main-side downloaded copy: main pulls the file over the pooled
 * SFTP connection (never a second connection) into `userData/cache/pdf/<content-hash>.pdf`
 * and hands the renderer a `file://` URL for the webview's src. The remote original is the
 * source of truth; the tab keeps the server origin badge; the temp dir is swept on quit
 * (best-effort — files missed this run are reclaimed by the same sweep next launch) so the
 * cache never outlives the app that minted it.
 *
 * Same cross-process discipline as @shared/fileio: handlers never reject; every failure is
 * in-band with the raw message plus typed crumbs (`notFound`, `tooLarge`) — crumbs map to
 * localized wording, everything else falls back to the raw message in the editor footer.
 */

export const PDFTEMP = {
  /** One server PDF → a `file://` URL of the main-side temp copy (downloading if needed). */
  open: "pdfTemp:open",
} as const;

/** The transfer cap for the temp pull: anything larger is refused IN BAND (the download
 *  never starts, so the cap is checked against the remote stat before any chunk moves). */
export const PDFTEMP_MAX_BYTES = 20 * 1024 * 1024;

/** The read page for the chunked pull (same page size the SFTP transfers use — SFTPv3
 *  packets are ≤32KiB; 256KiB amortizes round trips). */
export const PDFTEMP_CHUNK_BYTES = 256 * 1024;

/** The open verdict. `fileUrl` is `file://…` pointing at the content-hash-named temp copy;
 *  `bytes` is the remote size (the temp copy matches it). `cached` is true when the copy
 *  was already on disk (the remote is expected to match — the key IS the content's hash). */
export type PdfTempOpenResult =
  | { ok: true; fileUrl: string; bytes: number; cached: boolean }
  | { ok: false; error: string; notFound?: boolean; tooLarge?: boolean };

/**
 * The `pdfTemp:*` surface on `window.api` — never-reject by contract. `serverId`/`path`
 * are re-shaped main-side (the only remote path builder runs there).
 */
export interface PdfTempApi {
  openPdfServer(serverId: string, path: string): Promise<PdfTempOpenResult>;
}

/** The narrow slice of the ssh2 pooled client the temp pull rides (what {@link SftpChannel}
 *  borrows through). Declared here so this shared module stays main-agnostic; `sftp` is
 *  optional to keep the pooled `SshClientRpc` (whose sftp is optional) structurally
 *  assignable to every fake/real fn passed through withClient-mediated seams (the observable slice narrows, not widens).. */
export interface PdfTempClientRpc {
  /** Open the connection's SFTP subsystem (the temp pull's only channel need). */
  sftp?(cb: (err: Error | undefined, sftp: unknown) => void): void;
}

export type PdfTempManager = {
  /** The reserved pool seam: run fn against the live handle (null = not connected). */
  withClient<T>(id: string, fn: (rpc: PdfTempClientRpc) => T): T | null;
};
