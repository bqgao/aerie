import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { wrap, type SqliteDb } from "../../src/main/db/driver";
import {
  migrateSearch,
  readOpencodeCursor,
  readSearchFiles,
} from "../../src/main/db/search";
import {
  searchScanStep,
  type SearchScanTarget,
} from "../../src/main/search/search-scan";
import { openTestDb } from "../helpers/sqlite";

// Vite can't resolve the newer `node:sqlite` builtin statically — same reach-around as the
// shared test helper, plus the strictly-readonly open the engine's opener seam expects.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => unknown;
};

const openReadonly = (path: string): SqliteDb | null => {
  try {
    return wrap(new DatabaseSync(path, { readOnly: true }) as never);
  } catch {
    return null;
  }
};

let dir = "";
const targetsOf = (files: [string, string][]): SearchScanTarget[] =>
  files.map(([name, seed], i) => {
    const path = join(dir, name);
    void seed;
    return { path, mtimeMs: 1000 + i, sessionId: `s-${name}` };
  });

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

function scratch(): void {
  dir = mkdtempSync(join(tmpdir(), "cbw-search-scan-"));
}

const claudeLine = (text: string, ts = "2026-01-01T00:00:00.000Z"): string =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    cwd: "/repo",
    timestamp: ts,
  });

const summaryLine = (title: string): string =>
  JSON.stringify({ type: "summary", summary: title });

const bodies = (db: SqliteDb): string[] =>
  (
    db.prepare("SELECT body FROM fts ORDER BY rowid").all() as {
      body: string;
    }[]
  ).map((r) => r.body);

const counts = (db: SqliteDb): number =>
  (db.prepare("SELECT count(*) c FROM fts").all() as { c: number }[])[0].c;

describe("search file scan (claude/codex, byte-offset cursors)", () => {
  it("indexes a cold file whole, then re-reads only appended bytes", () => {
    scratch();
    const file = join(dir, "a.jsonl");
    writeFileSync(
      file,
      `${claudeLine("hello one")}\n${claudeLine("hello two")}\n`,
    );
    const db = openTestDb();
    migrateSearch(db);
    const targets = targetsOf([["a.jsonl", "x"]]);
    const opts = {
      claudeDir: dir,
      collectClaudeTargets: () => targets,
      collectCodexTargets: () => [],
      openReadonly,
    };

    const p1 = searchScanStep(db, opts);
    expect(p1.filesTotal).toBe(1);
    expect(p1.filesDone).toBe(1);
    expect(p1.done).toBe(true);
    expect(p1.wrote).toBe(true);
    expect(bodies(db)).toContain("hello one");
    expect(readSearchFiles(db).get(file)).toMatchObject({
      offset: statSync(file).size, // both complete lines consumed
    });

    const p2 = searchScanStep(db, opts);
    expect(p2.done).toBe(true);
    expect(p2.wrote).toBe(false); // skip, not re-index
    expect(counts(db)).toBe(2);

    appendFileSync(file, `${claudeLine("hello three")}\n`);
    const appended = targetsOf([["a.jsonl", "x"]]).map((t) => ({
      ...t,
      mtimeMs: 1000 + 1, // the walk's mtime gate moves with the append
    }));
    const p3 = searchScanStep(db, {
      ...opts,
      collectClaudeTargets: () => appended,
    });
    expect(p3.wrote).toBe(true);
    expect(bodies(db).filter((b) => b === "hello three")).toHaveLength(1);
    expect(readSearchFiles(db).get(file)).toMatchObject({
      offset: statSync(file).size,
    });
  });

  it("does not converge a file whose appended bytes carry no complete line, then picks it up", () => {
    scratch();
    const file = join(dir, "b.jsonl");
    writeFileSync(file, `${claudeLine("seed")}\n`);
    const db = openTestDb();
    migrateSearch(db);
    const walk = targetsOf([["b.jsonl", "x"]]);
    const opts = {
      claudeDir: dir,
      collectClaudeTargets: () => walk,
      collectCodexTargets: () => [],
      openReadonly,
    };
    searchScanStep(db, opts);
    expect(counts(db)).toBe(1);

    // A half-written append: bytes grew, but no newline yet.
    appendFileSync(file, claudeLine("partial tail"));
    const grown = [{ path: file, mtimeMs: 5555, sessionId: "s-b.jsonl" }];
    const p = searchScanStep(db, {
      ...opts,
      collectClaudeTargets: () => grown,
    });
    expect(readSearchFiles(db).get(file)).toMatchObject({
      offset:
        statSync(file).size -
        Buffer.byteLength(claudeLine("partial tail"), "utf8"),
    });
    expect(counts(db)).toBe(1);
    expect(p.done).toBe(true); // pinned at the walk mtime: stops blocking convergence

    // The newline lands (the file now ends fully); the pinned offset holds and indexes it.
    appendFileSync(file, "\n");
    searchScanStep(db, {
      ...opts,
      collectClaudeTargets: () => [
        { path: file, mtimeMs: 6666, sessionId: "s-b.jsonl" },
      ],
    });
    expect(bodies(db)).toContain("partial tail");
    expect(readSearchFiles(db).get(file)).toMatchObject({
      offset: statSync(file).size,
    });
  });

  it("deletes and reindexes a shrunk file from zero", () => {
    scratch();
    const file = join(dir, "c.jsonl");
    writeFileSync(file, `${claudeLine("v1 one")}\n${claudeLine("v1 two")}\n`);
    const db = openTestDb();
    migrateSearch(db);
    const opts = {
      claudeDir: dir,
      collectClaudeTargets: () => [],
      collectCodexTargets: () => [],
      openReadonly,
    };
    searchScanStep(db, {
      ...opts,
      collectClaudeTargets: () => [
        { path: file, mtimeMs: 10, sessionId: "s-c" },
      ],
    });
    expect(counts(db)).toBe(2);

    // Rewritten in place, smaller: old rows must vanish, new content indexes whole.
    writeFileSync(file, `${claudeLine("v2 one")}\n`);
    searchScanStep(db, {
      ...opts,
      collectClaudeTargets: () => [
        { path: file, mtimeMs: 20, sessionId: "s-c" },
      ],
    });
    const stored = readSearchFiles(db).get(file);
    expect(counts(db)).toBe(1);
    expect(bodies(db)).toEqual(["v2 one"]);
    expect(stored).toMatchObject({ offset: statSync(file).size });
    expect(readOpencodeCursor(db).unavailable).toBe(false);
  });

  it("drops rows for files that left the walk (vanishing transcripts)", () => {
    scratch();
    const gone = join(dir, "gone.jsonl");
    const kept = join(dir, "kept.jsonl");
    writeFileSync(gone, `${claudeLine("g")}\n`);
    writeFileSync(kept, `${claudeLine("k")}\n`);
    const db = openTestDb();
    migrateSearch(db);
    const opts = {
      claudeDir: dir,
      collectClaudeTargets: () => [],
      collectCodexTargets: () => [],
      openReadonly,
    };
    searchScanStep(db, {
      ...opts,
      collectClaudeTargets: () => [
        { path: gone, mtimeMs: 1, sessionId: "s-gone" },
        { path: kept, mtimeMs: 1, sessionId: "s-kept" },
      ],
    });
    expect(counts(db)).toBe(2);

    rmSync(gone);
    searchScanStep(db, {
      ...opts,
      collectClaudeTargets: () => [
        { path: kept, mtimeMs: 1, sessionId: "s-kept" },
      ],
    });
    expect(counts(db)).toBe(1);
    expect(bodies(db)).toEqual(["k"]);
    expect(readSearchFiles(db).has(gone)).toBe(false);
  });

  it("budget-split backfill: a clamped mid-file window resumes in the next step", () => {
    scratch();
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    const first3 = [claudeLine("a 1"), claudeLine("a 2"), claudeLine("a 3")];
    const line4 = claudeLine("a 4");
    const contentA = [...first3, line4].map((l) => `${l}\n`).join("");
    writeFileSync(a, contentA);
    writeFileSync(b, `${claudeLine("b one")}\n`);
    const db = openTestDb();
    migrateSearch(db);
    const targets: SearchScanTarget[] = [
      { path: a, mtimeMs: 100, sessionId: "sa" },
      { path: b, mtimeMs: 100, sessionId: "sb" },
    ];
    const opts = {
      claudeDir: dir,
      collectClaudeTargets: () => targets,
      collectCodexTargets: () => [],
      openReadonly,
    };
    // Budget ends exactly at the third line's newline: the window clamps mid-file, so a stays
    // unsettled (PARTIAL_MTIME keeps it pending) and b is left for a later step.
    const budget = first3.reduce(
      (n, l) => n + Buffer.byteLength(l, "utf8") + 1,
      0,
    );
    const p1 = searchScanStep(db, { ...opts, maxBytesPerStep: budget });
    expect(p1.filesDone).toBe(0);
    expect(p1.filesTotal).toBe(2);
    expect(p1.done).toBe(false);
    expect(counts(db)).toBe(3);
    // The partial sentinel keeps `a` pending across a step whose budget fully drains at line 3.
    const p2 = searchScanStep(db, { ...opts, maxBytesPerStep: budget });
    expect(p2.done).toBe(true);
    expect(counts(db)).toBe(5); // a's last line + b's line
  });

  it("keeps a summary line as the session title and stamps it on indexed rows", () => {
    scratch();
    const file = join(dir, "d.jsonl");
    writeFileSync(
      file,
      `${summaryLine("Fix the deploy")}\n${claudeLine("hello")}\n`,
    );
    const db = openTestDb();
    migrateSearch(db);
    searchScanStep(db, {
      claudeDir: dir,
      collectClaudeTargets: () => [
        { path: file, mtimeMs: 100, sessionId: "s-d" },
      ],
      collectCodexTargets: () => [],
      openReadonly,
    });
    const rows = db
      .prepare("SELECT sessionTitle, directory, timeMs FROM fts")
      .all() as { sessionTitle: string; directory: string; timeMs: number }[];
    expect(rows).toMatchObject([
      { sessionTitle: "Fix the deploy", directory: "/repo" },
    ]);
    expect(rows[0].timeMs).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });
});

// ── opencode: fixture store over the readonly seam ─────────────────────────────

interface OcFixtureOptions {
  columns?: {
    session_v2?: string[];
    session_message?: string[];
  };
}

function makeOcFixture(path: string, opts: OcFixtureOptions = {}): void {
  const db = new DatabaseSync(path) as never as {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      run: (...p: unknown[]) => unknown;
    };
  };
  const s2 = opts.columns?.session_v2
    ? opts.columns.session_v2.join(", ")
    : "id TEXT PRIMARY KEY, title TEXT, directory TEXT, agent TEXT, model TEXT, time_updated NUM";
  const sm = opts.columns?.session_message
    ? opts.columns.session_message.join(", ")
    : "id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_updated NUM, data TEXT";
  db.exec(`CREATE TABLE session_v2 (${s2})`);
  db.exec(`CREATE TABLE session_message (${sm})`);
  try {
    db.prepare(
      "INSERT INTO session_v2 (id, title, directory, time_updated) VALUES (?,?,?,?)",
    ).run("oc1", "Wire session", "/home/x/repo", 1727654321000);
    const msg = db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_updated, data) VALUES (?,?,?,?,?,?)",
    );
    msg.run(
      "m1",
      "oc1",
      "user",
      1,
      1727654320000,
      JSON.stringify({
        content: [{ type: "text", text: "你好 世界" }],
      }),
    );
    msg.run(
      "m2",
      "oc1",
      "assistant",
      2,
      1727654321000,
      JSON.stringify({
        content: [
          { type: "reasoning", text: "thinking hard" },
          { type: "tool_use", input: {} },
          { type: "text", text: "all done" },
        ],
      }),
    );
    msg.run("m3", "oc1", "step-start", 3, 1727654321500, JSON.stringify({}));
  } catch {
    // A drifted fixture rejects the seeds intentionally — the engine's feature-detect is what's
    // under test there, before any row read.
  }
}

describe("search opencode source", () => {
  it("chunk-drains (time_updated, seq) past the cursor and indexes prose-only bodies", () => {
    scratch();
    const dbPath = join(dir, "opencode.db");
    makeOcFixture(dbPath);
    const db = openTestDb();
    migrateSearch(db);
    const opts = {
      claudeDir: undefined,
      codexDir: undefined,
      opencodeDbPath: dbPath,
      collectClaudeTargets: () => [],
      collectCodexTargets: () => [],
      openReadonly,
    };
    const p1 = searchScanStep(db, { ...opts, ocChunkSize: 1 });
    expect(p1.done).toBe(false); // three rows, chunk of one: two outstanding
    const p1bodies = p2bodiesOf(db);
    expect(p1bodies).toEqual(["你好 世界"]); // m1's text part only
    expect(readOpencodeCursor(db)).toMatchObject({
      cursorTime: 1727654320000,
      cursorSeq: 1,
    });

    const p2 = searchScanStep(db, { ...opts, ocChunkSize: 2 });
    expect(p2.done).toBe(false); // m3 is the third row: still outstanding
    const p3 = searchScanStep(db, { ...opts, ocChunkSize: 2 });
    expect(p3.done).toBe(true);
    // Every prose body indexed exactly once: m2's reasoning + text joined, m3 skipped by type.
    expect(p2bodiesOf(db)).toEqual(["你好 世界", "thinking hard\nall done"]);
    const rows = db
      .prepare("SELECT sessionId, agent, sessionTitle, directory FROM fts")
      .all() as Record<string, string>[];
    expect(rows[0]).toMatchObject({
      sessionId: "oc1",
      agent: "opencode",
      sessionTitle: "Wire session",
      directory: "/home/x/repo",
    });
    // Cursor never rewinds: a further step is a no-op.
    searchScanStep(db, { ...opts, ocChunkSize: 2 });
    expect(counts(db)).toBe(2);
  });

  it("marks a drifted schema unavailable instead of throwing, and recovers when it heals", () => {
    scratch();
    const dbPath = join(dir, "opencode.db");
    makeOcFixture(dbPath, { columns: { session_v2: ["id", "name", "dir"] } });
    const db = openTestDb();
    migrateSearch(db);
    const opts = {
      opencodeDbPath: dbPath,
      collectClaudeTargets: () => [],
      collectCodexTargets: () => [],
      openReadonly,
    };
    const p = searchScanStep(db, opts);
    expect(p.done).toBe(true);
    expect(p.wrote).toBe(false);
    const source = p.sources[0];
    expect(source.agent).toBe("opencode");
    expect(source.unavailable).toBe(true);
    expect(typeof source.error).toBe("string");
    expect(counts(db)).toBe(0);

    // Heal: recreate the schema (a re-created store), then a healthy pass clears the flag
    // and re-backfills from zero (no duplicate rows for the old content).
    rmSync(dbPath);
    makeOcFixture(dbPath);
    const healed = searchScanStep(db, opts);
    expect(healed.sources[0].unavailable).toBe(false);
    expect(counts(db)).toBe(2);
  });

  it("fails soft when the store file is absent", () => {
    scratch();
    const db = openTestDb();
    migrateSearch(db);
    const p = searchScanStep(db, {
      opencodeDbPath: join(dir, "missing.db"),
      collectClaudeTargets: () => [],
      collectCodexTargets: () => [],
      openReadonly,
    });
    expect(p.sources[0]).toMatchObject({
      agent: "opencode",
      unavailable: true,
    });
    expect(p.done).toBe(true);
    expect(readOpencodeCursor(db).unavailable).toBe(true);
  });
});

function p2bodiesOf(db: SqliteDb): string[] {
  return (
    db.prepare("SELECT body FROM fts ORDER BY rowid").all() as {
      body: string;
    }[]
  ).map((r) => r.body);
}
