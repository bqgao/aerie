/**
 * OpenCode analytics backfill (step-bounded, read-only).
 *
 * The opencode service persists every session message in its own SQLite store
 * (~/.local/share/opencode/opencode.db, WAL — safe to open readonly alongside a
 * live service). This scanner walks `session_message` rows for assistant
 * messages that carry usage data and mirrors them into the analytics `turns`
 * table, using a synthetic processed_files row as the high-water cursor:
 *   path = "opencode-stats:messages", mtime = max(time_updated), lines = max(rowid).
 * Like the codex scanner it processes a bounded number of rows per step and
 * soft-fails (source unavailable) when the store or its schema is absent.
 */
import {
  upsertTurns,
  readProcessedFiles,
  upsertProcessedFile,
} from "../db/analytics";
import type { SqliteDb } from "../db/driver";

/** Row shape extracted from one assistant message's `data` JSON. */
interface UsageRow {
  readonly sessionId: string;
  readonly directory: string;
  readonly messageTimeMs: number;
  readonly modelId: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/** Feature-detect the store; undefined = source unavailable (soft fail). */
export function openOpencodeStatsStore(
  openReadonly: (path: string) => SqliteDb,
  dbPath: string,
): SqliteDb | undefined {
  try {
    const db = openReadonly(dbPath);
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_message'",
      )
      .get();
    if (!table) return undefined;
    return db;
  } catch {
    return undefined;
  }
}

/** Read up to `limit` assistant usage rows past the (mtime, rowid) water mark. */
export function readUsageRows(
  db: SqliteDb,
  cursorMtime: number,
  cursorRowid: number,
  limit: number,
): UsageRow[] {
  const rows = db
    .prepare(
      `SELECT m.rowid AS rowid, m.session_id AS sessionId, m.time_updated AS timeUpdated,
              s.directory AS directory, m.data AS data
         FROM session_message m
         JOIN session_v2 s ON s.id = m.session_id
        WHERE m.type = 'assistant' AND m.rowid > ?
          AND (m.time_updated > ? OR (m.time_updated = ? AND m.rowid > ?))
        ORDER BY m.rowid
        LIMIT ?`,
    )
    .all(cursorRowid, cursorMtime, cursorMtime, cursorRowid, limit) as Array<{
    rowid: number;
    sessionId: string;
    timeUpdated: number;
    directory: string;
    data: string;
  }>;
  const out: UsageRow[] = [];
  for (const r of rows) {
    let data: unknown;
    try {
      data = JSON.parse(r.data);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    const d = data as Record<string, unknown>;
    const tokens = d.tokens as Record<string, unknown> | undefined;
    const model = d.model as Record<string, unknown> | undefined;
    if (!tokens || !model) continue;
    const modelId =
      typeof model.modelID === "string"
        ? model.modelID
        : typeof model.id === "string"
          ? model.id
          : "unknown";
    const cache = (tokens.cache ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    out.push({
      sessionId: r.sessionId,
      directory: r.directory,
      messageTimeMs: typeof r.timeUpdated === "number" ? r.timeUpdated : 0,
      modelId,
      costUsd: typeof d.cost === "number" ? d.cost : 0,
      inputTokens: num(tokens.input),
      outputTokens: num(tokens.output),
      cacheReadTokens: num(cache.read),
      cacheCreationTokens: num(cache.write),
    });
  }
  return out;
}

/** One step's outcome (filesTotal/filesDone are synthetic for this source). */
export interface OpenCodeStatsStepOutcome {
  readonly done: boolean;
  readonly filesTotal: number;
  readonly filesDone: number;
  readonly wrote: boolean;
}

/**
 * One bounded backfill step: rows past the water mark become analytics
 * turns, then the synthetic cursor row advances. Never throws; a store
 * that fails to open reads as an immediately-done scan (source missing).
 */
export function scanOpencodeStatsStep(
  analytics: SqliteDb,
  openReadonly: (path: string) => SqliteDb,
  dbPath: string,
): OpenCodeStatsStepOutcome {
  const CURSOR_PATH = "opencode-stats:messages";
  const ROWS_PER_STEP = 500;
  const cursors = readProcessedFiles(analytics);
  const prev = cursors.get(CURSOR_PATH);
  const cursorMtime = prev?.mtime ?? 0;
  const cursorRowid = prev?.lines ?? 0;
  const store = openOpencodeStatsStore(openReadonly, dbPath);
  if (!store) return { done: true, filesTotal: 1, filesDone: 1, wrote: false };
  const rows = readUsageRows(store, cursorMtime, cursorRowid, ROWS_PER_STEP);
  if (rows.length > 0) {
    const turns = rows.map((r) => ({
      messageId: r.sessionId + ":" + r.messageTimeMs,
      sessionId: r.sessionId,
      agent: "opencode" as const,
      ts: r.messageTimeMs,
      modelRaw: r.modelId,
      usage: {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        cacheCreation5mTokens: r.cacheCreationTokens,
        cacheCreation1hTokens: 0,
      },
      cwd: r.directory,
      project: r.directory,
    }));
    upsertTurns(analytics, turns);
    const maxRowid = store
      .prepare(
        "SELECT MAX(rowid) AS max FROM session_message WHERE type = 'assistant'",
      )
      .get() as { max: number | null };
    upsertProcessedFile(
      analytics,
      CURSOR_PATH,
      Math.max(cursorMtime, ...rows.map((r) => r.messageTimeMs)),
      maxRowid.max ?? cursorRowid,
    );
  }
  return {
    done: rows.length < ROWS_PER_STEP,
    filesTotal: 1,
    filesDone: rows.length < ROWS_PER_STEP ? 1 : 0,
    wrote: rows.length > 0,
  };
}
