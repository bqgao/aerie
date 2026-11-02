import type { AgentId } from "@shared/agents";
import { transaction, type SqliteDb } from "./driver";

/**
 * The full-text search store's schema + row operations (B1, SEARCH_QUICKJUMP_SPEC). Lives in
 * `userData/search.db`, a rebuildable cache like the analytics store: a schema bump drops and
 * recreates, and the next scan re-backfills. Mirrors store.ts's PRAGMA user_version style.
 *
 * Layout:
 * - `fts` — the FTS5 virtual table (`tokenize='trigram'`: CJK content needs it — unicode61 is
 *   useless for Chinese). Columns follow the spec's DDL verbatim: body is the searchable text,
 *   agent/sessionTitle/directory are indexed alongside it (they make the query builder simple),
 *   sessionId/timeMs stay UNINDEXED carriers.
 * - `docs` — rowid → source path, so a file's rows can be deleted (shrink-reindex, cleanup
 *   sweep) without storing a path on every FTS row.
 * - `files` — the claude/codex append cursor per transcript file: stored mtime gates re-reads;
 *   `offset` is the byte high-water mark (the end of the last consumed line, so a partial trailing
 *   line is never indexed ahead of its newline and UTF-8 boundaries stay whole).
 * - `sources` — per-source small state: the opencode cursor (max time_updated + seq, stored raw
 *   under NUMERIC affinity so both numeric-ms and ISO-text timestamps round-trip) and the
 *   soft-failure verdict when a source's schema drifts.
 */

const SCHEMA_VERSION = 1;

function userVersion(db: SqliteDb): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
}

export function migrateSearch(db: SqliteDb): void {
  if (userVersion(db) < SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS docs;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS sources;
      DROP TABLE IF EXISTS fts;
      CREATE VIRTUAL TABLE fts USING fts5(
        body, agent, sessionId UNINDEXED, sessionTitle, directory, timeMs UNINDEXED,
        tokenize='trigram'
      );
      CREATE TABLE docs (docid INTEGER PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        mtime INTEGER NOT NULL,
        offset INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sources (
        source TEXT PRIMARY KEY,
        unavailable INTEGER NOT NULL DEFAULT 0,
        cursor_time NUM,
        cursor_seq INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }
}

/** A candidate document for the index: everything the fts row needs plus the source path the
 *  docid is registered under. `path` is the transcript file (claude/codex) or the unique
 *  `opencode:<messageId>` key (opencode) — deletion sweeps address rows through it. */
export interface SearchDoc {
  path: string;
  agent: AgentId;
  sessionId: string;
  sessionTitle: string;
  directory: string;
  timeMs: number;
  body: string;
}

const INSERT_FTS =
  "INSERT INTO fts (body, agent, sessionId, sessionTitle, directory, timeMs) VALUES (?,?,?,?,?,?)";
const INSERT_DOC = "INSERT INTO docs (docid, path) VALUES (?,?)";
const SELECT_LAST_DOCID = "SELECT last_insert_rowid() AS docid";

/** Insert documents and register their rowids under the source path, in ONE transaction so a
 *  mid-batch failure leaves the path wholly indexed or not at all. Docids are read back via
 *  SQLite's `last_insert_rowid()` (the seam exposes no driver-specific run() result). Empty
 *  batches are a cheap no-op. */
export function insertSearchDocs(
  db: SqliteDb,
  docs: readonly SearchDoc[],
): void {
  if (docs.length === 0) return;
  const insertFts = db.prepare(INSERT_FTS);
  const insertDoc = db.prepare(INSERT_DOC);
  const lastDocid = db.prepare(SELECT_LAST_DOCID);
  transaction(db, () => {
    for (const doc of docs) {
      insertFts.run(
        doc.body,
        doc.agent,
        doc.sessionId,
        doc.sessionTitle,
        doc.directory,
        doc.timeMs,
      );
      const docid = (lastDocid.get() as { docid: unknown }).docid;
      insertDoc.run(docid, doc.path);
    }
  });
}

/** Delete one source path's documents entirely (shrink-reindex, vanishing transcript sweep). */
export function deleteSearchDocsForPath(db: SqliteDb, path: string): void {
  transaction(db, () => {
    db.prepare(
      "DELETE FROM fts WHERE rowid IN (SELECT docid FROM docs WHERE path = ?)",
    ).run(path);
    db.prepare("DELETE FROM docs WHERE path = ?").run(path);
  });
}

/** Every source path whose rows must go (the opencode re-backfill on drift recovery clears the
 *  whole `opencode:` namespace) — one key prefix. */
export function dropSearchDocsByPrefix(db: SqliteDb, prefix: string): void {
  transaction(db, () => {
    db.prepare(
      "DELETE FROM fts WHERE rowid IN (SELECT docid FROM docs WHERE path LIKE ? || '%')",
    ).run(prefix);
    db.prepare("DELETE FROM docs WHERE path LIKE ? || '%'").run(prefix);
  });
}

/** A stored claude/codex append cursor: the file's last-seen mtime plus the byte offset past the
 *  last consumed complete line. */
export interface SearchFileCursor {
  path: string;
  agent: AgentId;
  sessionId: string;
  title: string;
  mtime: number;
  offset: number;
}

const SELECT_FILES = `
  SELECT path, agent, sessionId, title, mtime, offset FROM files ORDER BY path
`;

export function readSearchFiles(db: SqliteDb): Map<string, SearchFileCursor> {
  const rows = db.prepare(SELECT_FILES).all() as {
    path: string;
    agent: string;
    sessionId: string;
    title: string;
    mtime: number;
    offset: number;
  }[];
  const out = new Map<string, SearchFileCursor>();
  for (const r of rows) {
    out.set(r.path, {
      path: r.path,
      agent: r.agent as AgentId,
      sessionId: r.sessionId,
      title: r.title,
      mtime: r.mtime,
      offset: r.offset,
    });
  }
  return out;
}

/** Upsert one file's cursor (agent/sessionId/title/mtime/offset full-replace — values are only
 *  ever advanced by the scan, never merged). */
export function upsertSearchFile(db: SqliteDb, cursor: SearchFileCursor): void {
  db.prepare(
    `INSERT INTO files (path, agent, sessionId, title, mtime, offset)
     VALUES (@path, @agent, @sessionId, @title, @mtime, @offset)
     ON CONFLICT(path) DO UPDATE SET
       agent = excluded.agent,
       sessionId = excluded.sessionId,
       title = excluded.title,
       mtime = excluded.mtime,
       offset = excluded.offset`,
  ).run({
    path: cursor.path,
    agent: cursor.agent,
    sessionId: cursor.sessionId,
    title: cursor.title,
    mtime: cursor.mtime,
    offset: cursor.offset,
  });
}

/** Forget a file: drop its cursor and its indexed rows (the deletion sweep for transcripts that
 *  left the walk — Claude Code's cleanupPeriodDays). */
export function dropSearchFile(db: SqliteDb, path: string): void {
  deleteSearchDocsForPath(db, path);
  db.prepare("DELETE FROM files WHERE path = ?").run(path);
}

/** The opencode source's cursor + soft-failure state. Cursor values are stored raw (numeric ms
 *  or an ISO string) under the sources table's NUMERIC affinity, so the comparison the next step
 *  runs — `time_updated > cursor` — compares like with like. */
export interface OpencodeCursor {
  unavailable: boolean;
  /** Raw time_updated of the last consumed row, or null before the first pass. */
  cursorTime: number | string | null;
  cursorSeq: number;
  error?: string;
}

export function readOpencodeCursor(db: SqliteDb): OpencodeCursor {
  const row = db
    .prepare(
      "SELECT unavailable, cursor_time, cursor_seq, error FROM sources WHERE source = ?",
    )
    .get("opencode") as
    | {
        unavailable: number;
        cursor_time: number | string | null;
        cursor_seq: number;
        error: string | null;
      }
    | undefined;
  if (!row) {
    return { unavailable: false, cursorTime: null, cursorSeq: 0 };
  }
  return {
    unavailable: !!row.unavailable,
    cursorTime: row.cursor_time ?? null,
    cursorSeq: row.cursor_seq ?? 0,
    error: row.error ?? undefined,
  };
}

export function upsertOpencodeCursor(
  db: SqliteDb,
  cursor: OpencodeCursor,
): void {
  db.prepare(
    `INSERT INTO sources (source, unavailable, cursor_time, cursor_seq, error)
     VALUES ('opencode', @unavailable, @cursorTime, @cursorSeq, @error)
     ON CONFLICT(source) DO UPDATE SET
       unavailable = excluded.unavailable,
       cursor_time = excluded.cursor_time,
       cursor_seq = excluded.cursor_seq,
       error = excluded.error`,
  ).run({
    unavailable: cursor.unavailable ? 1 : 0,
    cursorTime: cursor.cursorTime ?? null,
    cursorSeq: cursor.cursorSeq,
    error: cursor.error ?? null,
  });
}
