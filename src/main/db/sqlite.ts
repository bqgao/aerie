import Database from "better-sqlite3";
import { wrap, type SqliteDb } from "./driver";

/** Open the on-disk index with better-sqlite3 (Electron main process) behind the SqliteDb seam. */
export function openDb(path: string): SqliteDb {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return wrap(db);
}

/**
 * Open another agent's store STRICTLY read-only (B1 opencode source): better-sqlite3's
 * `readonly` + `fileMustExist` — the handle can never create the file and never writes, which
 * keeps a foreign SQLite database's WAL untouched while we read it. No pragmas on this handle:
 * setting journal_mode on a readonly connection is both impossible and a write. Throws when the
 * path is missing or unreopenable — the caller (the scan engine) feature-detects and fails soft.
 */
export function openReadonlyDb(path: string): SqliteDb {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  return wrap(db);
}
