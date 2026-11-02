import { openSync, readSync, closeSync, statSync, type Stats } from "node:fs";
import type { AgentId } from "@shared/agents";
import type { SearchProgress, SearchSourceState } from "@shared/search";
import { MAX_TEXT_FILE_BYTES, isOversizedTextFile } from "../util/file-size";
import { logError } from "../log-buffer";
import type { SqliteDb } from "../db/driver";
import {
  dropSearchDocsByPrefix,
  dropSearchFile,
  insertSearchDocs,
  readOpencodeCursor,
  readSearchFiles,
  upsertOpencodeCursor,
  upsertSearchFile,
  type OpencodeCursor,
  type SearchDoc,
  type SearchFileCursor,
} from "../db/search";
import {
  extractClaudeLine,
  extractCodexLine,
  extractOpencodeBody,
} from "./transcript-extract";
import { readRolloutHead } from "../provider/codex/rollout";

/**
 * The bounded search-scan engine (B1): one `searchScanStep` call advances every source a little,
 * each bounded so a synchronous step never holds Electron's main thread for long (the same
 * discipline as the analytics scan). The renderer's search pump drives it for the app's lifetime,
 * exactly like the stats pump.
 *
 * Sources:
 * - claude/codex: the same discovery walks the analytics scanner uses (indexTranscripts /
 *   listRollouts, parent transcripts only — subagent files stay out of B1), but with their OWN
 *   cursor rows: a per-file mtime gate + a BYTE offset high-water mark, so a pass re-reads only
 *   the appended bytes (search reads FULL files, but never re-does work). A file whose readable
 *   size shrank below the stored offset is dropped and reindexed from zero. A file gone from the
 *   walk (Claude Code's cleanupPeriodDays reaps them) loses its rows in the same step's deletion
 *   sweep.
 * - opencode: the agent's own SQLite store (~/.local/share/opencode/opencode.db) opened STRICTLY
 *   readonly — never written, never pragma'd. Tables/columns are feature-detected; a drifted
 *   schema marks the source unavailable (fail soft, one log line, cursor state preserved). Rows
 *   chunk past the (time_updated, seq) cursor, ≤2000 per step.
 */

export interface SearchScanTarget {
  path: string;
  mtimeMs: number;
  sessionId: string;
}

/** Per-source tunables, all injected so tests drive them without fs gymnastics. */
export interface SearchScanOptions {
  claudeDir?: string;
  codexDir?: string;
  /** The opencode local store's path, to scan at all. */
  opencodeDbPath?: string;
  collectClaudeTargets: (dir: string) => SearchScanTarget[];
  collectCodexTargets: (dir: string) => SearchScanTarget[];
  /** The readonly opener for the opencode store (prod: better-sqlite3 `{readonly:true,
   *  fileMustExist:true}`; tests: the node:sqlite driver behind the same seam). Throws when the
   *  source is absent/unopenable — the engine catches and marks the source unavailable. */
  openReadonly: (path: string) => SqliteDb | null;
  /** File bytes the step may ingest across BOTH file sources. Cold backfills split across steps. */
  maxBytesPerStep?: number;
  /** opencode rows consumed per step (≤2000 per spec). */
  ocChunkSize?: number;
}

const DEFAULT_MAX_BYTES_PER_STEP = 2_000_000;
const DEFAULT_OC_CHUNK_SIZE = 2000;

/** A summary line caps the display name, same budget the rail rows show. */
const MAX_TITLE_CHARS = 120;

export function searchScanStep(
  searchDb: SqliteDb,
  options: SearchScanOptions,
): SearchProgress {
  const sources: SearchSourceState[] = [];
  let filesTotal = 0;
  let filesDone = 0;
  let wrote = false;
  let budget = options.maxBytesPerStep ?? DEFAULT_MAX_BYTES_PER_STEP;

  if (options.claudeDir !== undefined) {
    const r = scanFileAgent(
      searchDb,
      options.claudeDir,
      "claude",
      options.collectClaudeTargets,
      budget,
    );
    budget = r.remainingBudget;
    filesTotal += r.filesTotal;
    filesDone += r.filesDone;
    wrote ||= r.wrote;
    sources.push(r.source);
  }
  if (options.codexDir !== undefined) {
    const r = scanFileAgent(
      searchDb,
      options.codexDir,
      "codex",
      options.collectCodexTargets,
      budget, // the remainder after the claude leg
    );
    filesTotal += r.filesTotal;
    filesDone += r.filesDone;
    wrote ||= r.wrote;
    sources.push(r.source);
  }
  if (options.opencodeDbPath !== undefined) {
    const r = scanOpencodeSource(
      searchDb,
      options.opencodeDbPath,
      options.openReadonly,
      options.ocChunkSize ?? DEFAULT_OC_CHUNK_SIZE,
    );
    filesTotal += 1;
    if (r.caughtUp) filesDone += 1;
    wrote ||= r.wrote;
    sources.push(r.source);
  }

  return {
    filesTotal,
    filesDone,
    done: filesTotal === filesDone,
    wrote,
    sources,
  };
}

// ── claude / codex: file-sweep sources with byte-offset cursors ────────────────

interface FileAgentStepResult {
  source: SearchSourceState;
  filesTotal: number;
  filesDone: number;
  wrote: boolean;
  remainingBudget: number;
}

function scanFileAgent(
  searchDb: SqliteDb,
  dir: string,
  agent: AgentId,
  collect: (dir: string) => SearchScanTarget[],
  stepBudget: number,
): FileAgentStepResult {
  let targets: SearchScanTarget[] = [];
  let walkFailed = false;
  try {
    targets = collect(dir);
  } catch (err) {
    walkFailed = true;
    logSoft("search-scan-walk-failed", `${agent} transcript walk failed`, err);
  }
  const stored = readSearchFiles(searchDb);
  const mine = [...stored.values()].filter((f) => f.agent === agent);

  if (walkFailed) {
    // A walk that can't run (dir vanished under a temporarily misrouted home) must not touch
    // cursors — the next healthy step recovers. Report zero-progress, never "unavailable":
    // the walk failing is transient, not a schema drift.
    return {
      source: { agent, unavailable: false },
      filesTotal: 0,
      filesDone: 0,
      wrote: false,
      remainingBudget: stepBudget,
    };
  }

  const pending = targets
    .filter((t) => stored.get(t.path)?.mtime !== t.mtimeMs)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const filesTotal = targets.length;
  let filesDone = filesTotal - pending.length;
  let wrote = false;
  let remainingBudget = stepBudget;

  for (const t of pending) {
    if (remainingBudget <= 0) break;
    const r = consumeFile(
      searchDb,
      agent,
      t,
      stored.get(t.path),
      remainingBudget,
    );
    remainingBudget -= r.bytesIngested;
    filesDone += r.caughtUp ? 1 : 0;
    wrote ||= r.wrote;
  }

  // Deletion sweep: any stored file of this agent that left the walk lost its transcript
  // (Claude Code's cleanupPeriodDays). Drop its cursor and rows in the same step.
  const known = new Set(targets.map((t) => t.path));
  for (const f of mine) {
    if (!known.has(f.path)) {
      dropSearchFile(searchDb, f.path);
      wrote = true;
    }
  }

  return {
    source: { agent, unavailable: false },
    filesTotal,
    filesDone,
    wrote,
    remainingBudget,
  };
}

/** mtime stand-in for a file that's only mid-consumption (the byte budget split a big tail).
 *  A real mtimeMs is positive, so the sentinel never equals the walk's mtime — the file stays
 *  pending until a later step finishes it, then gets its real walk mtime. */
const PARTIAL_MTIME = -1;

interface ConsumeResult {
  /** Bytes advanced past their stored offset this pass (0 when nothing new was consumable). */
  bytesIngested: number;
  /** Whether at least one document landed in the index. */
  wrote: boolean;
  /** Whether the file is caught up at its current walk mtime (counts toward filesDone).
   *  A budget-clamped mid-file window is NOT caught up — it stays pending via PARTIAL_MTIME. */
  caughtUp: boolean;
}

/** Read `t`'s un-indexed bytes (up to `budget`), extract prose, advance the file's cursor.
 *  Every exit path pins the file's cursor at the WALK's mtime, so a pending file either moves
 *  the offset or stops blocking `done` — never half-way (the next step doesn't resume a file
 *  whose stored mtime already matches; its pinned offset holds the position). */
function consumeFile(
  searchDb: SqliteDb,
  agent: AgentId,
  t: SearchScanTarget,
  prev: SearchFileCursor | undefined,
  budget: number,
): ConsumeResult {
  let st: Stats;
  try {
    st = statSync(t.path);
  } catch {
    // Unreadable / vanished since the walk: pin at the walk mtime, keep the offset.
    stamp(searchDb, agent, t, prev, prev?.offset ?? 0);
    return { bytesIngested: 0, wrote: false, caughtUp: true };
  }
  if (isOversizedTextFile(t.path, MAX_TEXT_FILE_BYTES)) {
    stamp(searchDb, agent, t, prev, prev?.offset ?? 0);
    return { bytesIngested: 0, wrote: false, caughtUp: true };
  }
  // Shrink (truncate / rewrite in place): the old content's rows are invalid — drop them and
  // reindex from zero. A first-index file is a degenerate shrink (no stored offset to guard).
  const shrunk = (prev?.offset ?? 0) > st.size;
  const start = shrunk ? 0 : (prev?.offset ?? 0);
  if (start >= st.size) {
    if (shrunk) dropSearchFile(searchDb, t.path);
    stamp(searchDb, agent, t, prev, st.size);
    return { bytesIngested: 0, wrote: false, caughtUp: true };
  }
  if (shrunk) dropSearchFile(searchDb, t.path);

  let fd = 0;
  try {
    fd = openSync(t.path, "r");
    // Read only the window past the offset. The window STARTS at a previously consumed line's
    // newline (or 0) — always a UTF-8 boundary — so multi-byte characters can't split across
    // the resumption point.
    const len = Math.min(st.size - start, budget);
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, start);
    // Consume through the last newline BYTE (0x0A never appears inside a UTF-8 sequence, so a
    // byte scan is encoding-safe); the trailing partial line stays unread until its newline
    // lands — the offset only ever advances across complete lines.
    const nlByte = buf.lastIndexOf(0x0a, read - 1);
    if (nlByte === -1) {
      stamp(searchDb, agent, t, prev, start);
      return { bytesIngested: 0, wrote: false, caughtUp: true };
    }
    const jsonl = buf.subarray(0, nlByte + 1).toString("utf8");
    const newOffset = start + nlByte + 1;
    const cwdDefault =
      agent === "codex" ? (readRolloutHead(t.path)?.cwd ?? "") : "";
    const docs: SearchDoc[] = [];
    let title = prev?.title ?? "";
    const lines = jsonl.split("\n");
    lines.pop(); // the joiner after the final "\n" is "", never a record
    for (const line of lines) {
      if (!line.trim()) continue;
      const hit =
        agent === "claude" ? extractClaudeLine(line) : extractCodexLine(line);
      if (!hit) continue;
      if (!title && hit.title) title = hit.title.slice(0, MAX_TITLE_CHARS);
      if (!hit.text) continue;
      docs.push({
        path: t.path,
        agent,
        sessionId: t.sessionId,
        sessionTitle: title,
        directory: hit.cwd || cwdDefault,
        timeMs: hit.timeMs,
        body: hit.text,
      });
    }
    insertSearchDocs(searchDb, docs);
    // Caught up when the window reached EOF (or the remaining bytes are a not-yet-newline'd
    // trailing line): the walk's mtime marks the file current. A window the byte budget cut
    // mid-file keeps PARTIAL_MTIME so the next step resumes the remainder.
    const clamped = start + len < st.size;
    upsertSearchFile(searchDb, {
      path: t.path,
      agent,
      sessionId: t.sessionId,
      title,
      mtime: clamped ? PARTIAL_MTIME : t.mtimeMs,
      offset: newOffset,
    });
    return {
      bytesIngested: newOffset - start,
      wrote: docs.length > 0,
      caughtUp: !clamped,
    };
  } catch (err) {
    // The read raced a rotation/truncation: pin the file so it stops blocking convergence; the
    // next walk mtime change retries with the then-real size.
    stamp(searchDb, agent, t, prev, prev?.offset ?? 0);
    logSoft("search-scan-read-failed", `${agent} transcript read failed`, err);
    return { bytesIngested: 0, wrote: false, caughtUp: true };
  } finally {
    if (fd) closeSync(fd);
  }
}

/** Pin a file's cursor at the walk's mtime and `offset` (a no-op write when unchanged — cheap,
 *  keeps the scan stateless). sessionId/title follow the latest walk's target and the stored
 *  title; a shrinking reindex carries none of the old content forward but keeps a found title. */
function stamp(
  searchDb: SqliteDb,
  agent: AgentId,
  t: SearchScanTarget,
  prev: SearchFileCursor | undefined,
  offset: number,
): void {
  upsertSearchFile(searchDb, {
    path: t.path,
    agent,
    sessionId: t.sessionId,
    title: prev?.title ?? "",
    mtime: t.mtimeMs,
    offset,
  });
}

// ── opencode: the agent's own SQLite store, read strictly readonly ─────────────

const OC_REQUIRED = {
  session_v2: ["id", "title", "directory", "time_updated"],
  session_message: ["id", "session_id", "type", "seq", "time_updated", "data"],
} as const;

interface OpencodeStepResult {
  source: SearchSourceState;
  /** Whether this step consumed the outstanding chunk (drained) — the aggregate `done`. */
  caughtUp: boolean;
  wrote: boolean;
}

function scanOpencodeSource(
  searchDb: SqliteDb,
  dbPath: string,
  openReadonly: (path: string) => SqliteDb | null,
  chunkSize: number,
): OpencodeStepResult {
  const unavailable = (error: string, err?: unknown): OpencodeStepResult => {
    if (err) logSoft("search-opencode-source-unavailable", error, err);
    return {
      source: { agent: "opencode", unavailable: true, error },
      caughtUp: true,
      wrote: false,
    };
  };
  let oc: SqliteDb;
  try {
    const opened = openReadonly(dbPath);
    if (!opened) {
      const r = unavailable("OpenCode's local store could not be opened.");
      persistUnavailable(searchDb, r);
      return r;
    }
    oc = opened;
  } catch (err) {
    const r = unavailable("OpenCode's local store was not found.", err);
    persistUnavailable(searchDb, r);
    return r;
  }
  try {
    // Feature-detect before anything: a renamed/dropped table or a missing column is not a
    // contract — fail soft to "source unavailable", never into a throwing handler.
    for (const [table, columns] of Object.entries(OC_REQUIRED)) {
      const rows = oc
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .all(table) as { name: string }[];
      if (rows.length === 0) throw new Error(`table ${table} is missing`);
      const info = oc.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      const have = new Set(info.map((c) => c.name));
      for (const col of columns)
        if (!have.has(col))
          throw new Error(`column ${table}.${col} is missing`);
    }

    const before = readOpencodeCursor(searchDb);
    // A previously-drifted source that now feature-detects cleanly recovers: clear the flag and
    // reset the cursor BEFORE scanning, so a re-created store re-backfills from zero — and the
    // wipe never races this step's own inserts (the reset happens first).
    let cursor = before;
    if (before.unavailable) {
      dropSearchDocsByPrefix(searchDb, "opencode:");
      cursor = { unavailable: false, cursorTime: null, cursorSeq: 0 };
    }
    const whereSql =
      cursor.cursorTime !== null
        ? "WHERE (m.time_updated > ? OR (m.time_updated = ? AND m.seq > ?))"
        : "";
    const params: unknown[] =
      cursor.cursorTime !== null
        ? [cursor.cursorTime, cursor.cursorTime, cursor.cursorSeq]
        : [];
    const rows = oc
      .prepare(
        `SELECT m.id AS id, m.session_id AS sessionId, m.type AS type, m.seq AS seq,
                m.time_updated AS updated, m.data AS data, s.title AS title, s.directory AS directory
         FROM session_message m JOIN session_v2 s ON s.id = m.session_id
         ${whereSql}
         ORDER BY m.time_updated, m.seq
         LIMIT ?`,
      )
      .all(...params, chunkSize) as OcRow[];

    let wrote = false;
    const docs = rows
      .filter((r) => r.type === "user" || r.type === "assistant")
      .map((r) => {
        const body = extractOpencodeBody(r.data);
        if (!body) return null;
        return {
          path: `opencode:${r.id}`,
          agent: "opencode" as const,
          sessionId: r.sessionId,
          sessionTitle: r.title ?? "",
          directory: r.directory ?? "",
          timeMs: ocTimeMs(r.updated),
          body,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
    if (docs.length > 0) wrote = true;
    insertSearchDocs(searchDb, docs);

    const last = rows[rows.length - 1];
    const next: OpencodeCursor = {
      unavailable: false,
      cursorTime: cursorValueOf(last?.updated) ?? cursor.cursorTime ?? null,
      cursorSeq: last?.seq ?? cursor.cursorSeq,
    };
    upsertOpencodeCursor(searchDb, next);
    // Unavailable-again must not latch silently: a store that feature-detects here but then
    // throws mid-scan surfaces through the catch below, which stores the failure.
    return {
      source: { agent: "opencode", unavailable: false },
      caughtUp: rows.length < chunkSize,
      wrote: wrote || rows.length > 0,
    };
  } catch (err) {
    const before = readOpencodeCursor(searchDb);
    const message = "OpenCode transcript read failed.";
    upsertOpencodeCursor(searchDb, {
      ...before,
      unavailable: true,
      error: message,
    });
    return unavailable(message, err);
  }
}

/** The step's soft-failure verdict, mirrored into the search db's source row so a fresh
 *  readSearch snapshot and any UI served between steps see the same state the step returned. */
function persistUnavailable(
  searchDb: SqliteDb,
  result: OpencodeStepResult,
): void {
  upsertOpencodeCursor(searchDb, {
    ...readOpencodeCursor(searchDb),
    unavailable: result.source.unavailable,
    error: result.source.error,
  });
}

interface OcRow {
  id: string;
  sessionId: string;
  type: string;
  seq: number;
  updated: unknown;
  data: unknown;
  title: string | null;
  directory: string | null;
}

/** The opencode store may record time_updated as epoch-ms or an ISO string; normalize to ms for
 *  the indexed row (the cursor itself stores the raw value so comparisons stay like-for-like). */
function ocTimeMs(updated: unknown): number {
  if (typeof updated === "number" && Number.isFinite(updated)) return updated;
  if (typeof updated === "string") {
    const t = Date.parse(updated);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

type RawCursorTime = number | string | null;

/** The raw time_updated value as a cursor carrier: number or ISO string pass through; anything
 *  else is not a time this search db understands (typechecked, so the keeps-raw contract above
 *  can't drift). */
function cursorValueOf(updated: unknown): RawCursorTime {
  if (typeof updated === "number") return updated;
  if (typeof updated === "string") return updated;
  return null;
}

function logSoft(event: string, message: string, err?: unknown): void {
  logError(event, message, err);
}
