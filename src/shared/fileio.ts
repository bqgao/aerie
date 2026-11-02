/**
 * The editor's local-disk I/O IPC (pass I-a). Same cross-process discipline as @shared/sftp:
 * main owns every file operation through `src/main/fileio/`; the renderer sends only plain
 * `{ path }` shapes (never credentials, never results of its own checks) and reads typed
 * verdicts. Handlers never reject — every failure is in-band as
 * `{ ok:false, errorKind, message }` where `errorKind` is the STABLE key the renderer maps to
 * i18n and `message` is the raw detail (shown in the editor footer as the fallback).
 *
 * The "Open a file" Local… entry point needs ONE main-side artifact, the native open dialog
 * (dialogs always ride main in this app) — `pick` returns a typed cancel, not an error, mirroring
 * the SFTP upload dialog's convention.
 */

export const FILEIO = {
  read: "fileio:read",
  write: "fileio:write",
  pick: "fileio:pick",
} as const;

/** The text cap (I-a): reads return at most the first 512KiB with `capped:true`; a capped tab
 *  renders read-only. The >2MB off-hand wording in the spec folds into this one cap — anything
 *  beyond the cap simply comes back capped, which covers both the 512KB–2MB and >2MB cases. */
export const FILEIO_READ_CAP_BYTES = 512 * 1024;

/** The binary-sniff window: a NUL byte in the first 8KiB marks the file as binary and the tab
 *  shows the not-editable message view instead of a breakage-prone textarea. */
export const FILEIO_BINARY_SNIFF_BYTES = 8 * 1024;

/** The read verdict. `bytes` is the byte length of the returned slice (content may be shorter
 *  in characters — the read assumes UTF-8; torn multi-byte sequences decode to U+FFFD). */
export type FileIoReadResult =
  | { ok: true; content: string; bytes: number; capped: boolean }
  | { ok: false; errorKind: FileIoErrorKind; message: string };

export type FileIoWriteResult =
  | { ok: true; bytes: number }
  | { ok: false; errorKind: FileIoErrorKind; message: string };

/** The native open-file picker (the editor pane's Local… button). A UI cancel is a typed
 *  `{ ok:true, canceled:true }` — NOT an error; only a failed dialog itself is. */
export type FileIoPickResult =
  | { ok: true; path: string }
  | { ok: true; canceled: true }
  | { ok: false; errorKind: FileIoErrorKind; message: string };

/** The stable failure taxonomy: `invalid-path` (malformed/not absolute), `forbidden-path`
 *  (inside the app's own data dirs), `not-found`, `binary` (NUL sniff), and `io` (everything
 *  else, with the OS message carried verbatim). The renderer translates the kinds it knows and
 *  shows `message` for the rest — the in-band wording below is the en fallback. */
export type FileIoErrorKind =
  | "invalid-path"
  | "forbidden-path"
  | "not-found"
  | "binary"
  | "io";

/**
 * The `fileio:*` surface on `window.api` — all invokes are never-reject by contract (the bridge
 * still awaits, like every other family's).
 */
export interface FileIoApi {
  /** Read `path` as UTF-8 with the 512KiB cap + binary sniff; absolute-path and app-data
   *  refusals come back in-band. */
  read(path: string): Promise<FileIoReadResult>;
  /** Atomic write (temp file + rename) of `content` as UTF-8; the same path rules apply. */
  write(path: string, content: string): Promise<FileIoWriteResult>;
  /** The native open-file dialog (Local…). `canceled` reports a UI dismissal. */
  pick(): Promise<FileIoPickResult>;
}
