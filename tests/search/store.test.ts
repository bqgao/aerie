import { describe, expect, it } from "vitest";
import {
  deleteSearchDocsForPath,
  dropSearchFile,
  insertSearchDoc,
  migrateSearch,
  readOpencodeCursor,
  readSearchFiles,
  upsertOpencodeCursor,
  upsertSearchFile,
  type SearchDoc,
} from "../../src/main/db/search";
import { openTestDb } from "../helpers/sqlite";

const doc = (over: Partial<SearchDoc> = {}): SearchDoc => ({
  path: "/t/a.jsonl",
  agent: "claude",
  sessionId: "s1",
  sessionTitle: "T",
  directory: "/x",
  timeMs: 123,
  body: "hello jump",
  ...over,
});

function setup() {
  const db = openTestDb();
  migrateSearch(db);
  return db;
}

describe("search store", () => {
  it("creats the schema under the current user_version", () => {
    const db = setup();
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    // Re-migrating past the first launch is a no-op that keeps existing rows.
    insertSearchDoc(db, doc());
    migrateSearch(db);
    expect(
      (db.prepare("SELECT count(*) c FROM fts").all() as { c: number }[])[0].c,
    ).toBe(1);
  });

  it("round-trips documents and deletes by source path", () => {
    const db = setup();
    insertSearchDoc(db, doc());
    insertSearchDoc(db, doc({ path: "/t/b.jsonl", sessionId: "s2", body: "跳闸 测试" }));
    const rows = db
      .prepare("SELECT sessionId, agent, sessionTitle, directory, timeMs, body FROM fts ORDER BY rowid")
      .all() as Record<string, unknown>[];
    expect(rows).toMatchObject([
      { sessionId: "s1", agent: "claude", body: "hello jump" },
      { sessionId: "s2", body: "跳闸 测试" },
    ]);
    deleteSearchDocsForPath(db, "/t/a.jsonl");
    const left = db.prepare("SELECT sessionId FROM fts").all() as { sessionId: string }[];
    expect(left).toEqual([{ sessionId: "s2" }]);
    // The docid registry is swept alongside the fts rows.
    const docs = db.prepare("SELECT count(*) c FROM docs").all() as { c: number }[];
    expect(docs[0].c).toBe(1);
  });

  it("keeps an append cursor per file and forgets it on drop", () => {
    const db = setup();
    upsertSearchFile(db, {
      path: "/t/a.jsonl",
      agent: "claude",
      sessionId: "s1",
      title: "first",
      mtime: 5,
      offset: 10,
    });
    upsertSearchFile(db, {
      path: "/t/a.jsonl",
      agent: "claude",
      sessionId: "s1",
      title: "second",
      mtime: 9,
      offset: 20,
    });
    const stored = readSearchFiles(db);
    expect(stored.get("/t/a.jsonl")).toMatchObject({ mtime: 9, offset: 20, title: "second" });
    dropSearchFile(db, "/t/a.jsonl");
    expect(readSearchFiles(db).size).toBe(0);
  });

  it("round-trips the opencode cursor raw (numeric and text times) plus unavailability", () => {
    const db = setup();
    expect(readOpencodeCursor(db)).toEqual({
      unavailable: false,
      cursorTime: null,
      cursorSeq: 0,
    });
    upsertOpencodeCursor(db, { unavailable: false, cursorTime: 1727654321000, cursorSeq: 12 });
    expect(readOpencodeCursor(db)).toMatchObject({ cursorTime: 1727654321000, cursorSeq: 12 });
    upsertOpencodeCursor(db, {
      unavailable: true,
      cursorTime: "2026-01-02T03:04:05.000Z",
      cursorSeq: 40,
      error: "schema drifted",
    });
    const cur = readOpencodeCursor(db);
    // NUMERIC affinity must leave a non-numeric-looking ISO string untouched.
    expect(cur.cursorTime).toBe("2026-01-02T03:04:05.000Z");
    expect(cur.unavailable).toBe(true);
    expect(cur.error).toBe("schema drifted");
  });
});
