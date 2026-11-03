/**
 * Session -> Markdown export save flow (main process).
 *
 * Plain-function twin of ./diagnostic-save: renderer serializes the
 * transcript and main runs the save dialog + write. Never rejects; every
 * failure rides the SaveSessionExportResult union.
 */
import {
  MAX_SESSION_EXPORT_BYTES,
  type SaveSessionExportResult,
  type SessionExportInput,
} from "@shared/session-export";

export interface SaveSessionExportDeps {
  /** Electron save dialog (injected for tests). */
  readonly showSaveDialog: (options: {
    defaultPath?: string;
  }) => Promise<{ canceled: boolean; filePath?: string }>;
  /** File write seam (utf8 at the call site). */
  readonly write: (path: string, contents: string) => Promise<void>;
}

export async function saveSessionExport(
  input: SessionExportInput,
  deps: SaveSessionExportDeps,
): Promise<SaveSessionExportResult> {
  if (
    typeof input.defaultName !== "string" ||
    typeof input.contents !== "string"
  ) {
    return { kind: "write-failed", message: "Invalid export payload." };
  }
  if (input.contents.length > MAX_SESSION_EXPORT_BYTES) {
    return { kind: "too-large" };
  }
  const picked = await deps.showSaveDialog({ defaultPath: input.defaultName });
  if (picked.canceled || !picked.filePath) {
    return { kind: "canceled" };
  }
  try {
    await deps.write(picked.filePath, input.contents);
    return {
      kind: "saved",
      path: picked.filePath,
      bytes: Buffer.byteLength(input.contents, "utf8"),
    };
  } catch (error) {
    return {
      kind: "write-failed",
      message: error instanceof Error ? error.message : "Write failed.",
    };
  }
}
