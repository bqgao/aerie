/**
 * Session → Markdown export contract (shared across processes).
 *
 * Mirrors @shared/diagnostic-report's save flow: the renderer serializes the
 * transcript (it already holds it via readTranscript) and asks main to run a
 * save dialog + write. Main never rejects; every failure rides the result.
 */

export const MAX_SESSION_EXPORT_BYTES = 10 * 1024 * 1024;

export interface SessionExportInput {
  /** Suggested file name in the save dialog (e.g. "session-ses_ABC.md"). */
  defaultName: string;
  /** Full Markdown document (UTF-8). Capped at MAX_SESSION_EXPORT_BYTES. */
  contents: string;
}

export type SaveSessionExportResult =
  | { kind: "saved"; path: string; bytes: number }
  | { kind: "canceled" }
  | { kind: "too-large" }
  | { kind: "write-failed"; message: string };
