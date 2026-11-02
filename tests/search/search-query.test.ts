import { describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc";
import {
  buildSearchQuery,
  groupBySession,
  searchTranscripts,
} from "../../src/main/search/search-query";
import { insertSearchDocs, migrateSearch } from "../../src/main/db/search";
import type { SearchDoc } from "../../src/main/db/search";
import type { SqliteDb } from "../../src/main/db/driver";
import { openTestDb } from "../helpers/sqlite";

const doc = (over: Partial<SearchDoc>): SearchDoc => ({
  path: `/t/${over.sessionId ?? "s1"}.jsonl`,
  agent: "claude",
  sessionId: "s1",
  sessionTitle: "T",
  directory: "/x",
  timeMs: 100,
  body: "nothing",
  ...over,
});

// ── the parser ────────────────────────────────────────────────────────────────

describe("buildSearchQuery", () => {
  it("wraps every token in a body-scoped quoted prefix term, joined implicitly AND", () => {
    expect(buildSearchQuery("hello jump")).toEqual({
      match: '"hello"* "jump"*',
      likes: [],
      tokens: ["hello", "jump"],
    });
  });

  it("strips embedded double quotes so a token can't close its own quoted term", () => {
    expect(buildSearchQuery('we"ird')).toEqual({
      match: '"weird"*',
      likes: [],
      tokens: ['we"ird'],
    });
  });

  it("sends short tokens to the LIKE prefilter — the trigram index can't answer <3 chars", () => {
    expect(buildSearchQuery("ok jump")).toEqual({
      match: '"jump"*',
      likes: ["%ok%"],
      tokens: ["ok", "jump"],
    });
    // CJK: a 2-char word is a short token (code points, NOT bytes) — LIKE fallback branch.
    expect(buildSearchQuery("跳闸")).toEqual({
      match: null,
      likes: ["%跳闸%"],
      tokens: ["跳闸"],
    });
    // A 3+-code-point CJK query rides the trigram index normally.
    expect(buildSearchQuery("伟大的事件")).toEqual({
      match: '"伟大的事件"*',
      likes: [],
      tokens: ["伟大的事件"],
    });
  });

  it("is blank-safe", () => {
    expect(buildSearchQuery("   ")).toEqual({
      match: null,
      likes: [],
      tokens: [],
    });
  });
});

// ── the grouping reducer (pure) ──────────────────────────────────────────────

describe("groupBySession", () => {
  it("keeps the best-ranked snippet, sums hits, and takes the freshest time", () => {
    const groups = groupBySession(
      [
        {
          sessionId: "a",
          agent: "claude",
          sessionTitle: "A",
          directory: "/x",
          timeMs: 10,
          snippet: "first",
        },
        {
          sessionId: "b",
          agent: "codex",
          sessionTitle: "B",
          directory: "/y",
          timeMs: 20,
          snippet: "b's best",
        },
        {
          sessionId: "a",
          agent: "claude",
          sessionTitle: "A",
          directory: "/x",
          timeMs: 40,
          snippet: "ignored",
        },
      ],
      50,
      4000,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      sessionId: "a",
      hitCount: 2,
      snippet: "first",
      timeMs: 40,
    });
    expect(groups[1]).toMatchObject({ sessionId: "b", hitCount: 1 });
  });

  it("bounds both the session count and the rows visited", () => {
    const rows = [
      {
        sessionId: "s1",
        agent: "claude",
        sessionTitle: null,
        directory: null,
        timeMs: 1,
        snippet: "s",
      },
      {
        sessionId: "s2",
        agent: "claude",
        sessionTitle: null,
        directory: null,
        timeMs: 2,
        snippet: "s",
      },
      {
        sessionId: "s3",
        agent: "claude",
        sessionTitle: null,
        directory: null,
        timeMs: 3,
        snippet: "s",
      },
    ];
    expect(groupBySession(rows, 2, 4000)).toHaveLength(2);
    expect(groupBySession(rows, 50, 1)).toHaveLength(1);
  });
});

// ── the store-backed FTS query (node:sqlite trigram round-trip) ───────────────

function seededDb(): SqliteDb {
  const db = openTestDb();
  migrateSearch(db);
  insertSearchDocs(db, [
    doc({
      sessionId: "s1",
      agent: "claude",
      body: "the quick brown jump fits",
      timeMs: 100,
    }),
    doc({ sessionId: "s1", body: "another jump here", timeMs: 150 }),
    doc({
      sessionId: "s2",
      agent: "codex",
      body: "jumping beans only",
      timeMs: 200,
    }),
    doc({
      sessionId: "s3",
      agent: "opencode",
      body: "伟大的跳闸事件发生了",
      timeMs: 50,
    }),
  ]);
  return db;
}

describe("searchTranscripts (FTS round-trip)", () => {
  it("ranks best-first, groups by session with hit counts, and carries snippets", () => {
    const r = searchTranscripts(seededDb(), "jump", 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.groups.map((g) => g.sessionId);
    expect(ids).toEqual(expect.arrayContaining(["s1", "s2"]));
    const s1 = r.groups.find((g) => g.sessionId === "s1");
    expect(s1?.hitCount).toBe(2);
    expect(s1?.snippet).toContain("»"); // the highlight mark surrounds a hit
  });

  it("ANDs prefix tokens across the body column", () => {
    const r = searchTranscripts(seededDb(), "jump beans", 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.groups.map((g) => g.sessionId)).toEqual(["s2"]);
  });

  it("serves CJK via the trigram index and the LIKE fallback branch", () => {
    expect(searchTranscripts(seededDb(), "伟大的事件").ok).toBe(true);
    const long = searchTranscripts(seededDb(), "伟大的跳闸事件");
    expect(long.ok).toBe(true);
    if (long.ok) expect(long.groups.map((g) => g.sessionId)).toEqual(["s3"]);
    // 2-char CJK: LIKE fallback must still find it over the body column.
    const short = searchTranscripts(seededDb(), "跳闸");
    expect(short.ok).toBe(true);
    if (short.ok) expect(short.groups.map((g) => g.sessionId)).toEqual(["s3"]);
  });

  it("returns an empty group list for a blank or miss query", () => {
    expect(searchTranscripts(seededDb(), "  ")).toEqual({
      ok: true,
      groups: [],
    });
    const r = searchTranscripts(seededDb(), "zzzznothere");
    expect(r).toEqual({ ok: true, groups: [] });
  });

  it("degrades to an in-band failure (never throws) when the store is broken", () => {
    const broken = {
      exec: vi.fn(),
      prepare: vi.fn(() => {
        throw new Error("disk I/O error");
      }),
    } as unknown as SqliteDb;
    const r = searchTranscripts(broken, "jump");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("disk I/O error");
  });

  it("honors a caller-supplied session limit", () => {
    const r = searchTranscripts(seededDb(), "jump", 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.groups).toHaveLength(1);
  });
});

// ── the IPC surface: never-rejects, in-band failures ──────────────────────────

const handlers = new Map<string, (...a: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: { getVersion: () => "test-version", getAppMetrics: () => [] },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showSaveDialog: () => Promise.resolve({ canceled: true }) },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) =>
      handlers.set(channel, fn),
  },
  nativeTheme: { themeSource: "system" },
}));

// A minimal provider only for the never-rejects tests: registerIpc requires it but no method is
// reachable without a sync call — these tests never sync.
const inertProvider = {
  id: "inert",
  listCandidates: () => [],
} as unknown as Parameters<
  typeof import("../../src/main/ipc").registerIpc
>[0]["provider"];

describe("search IPC handlers", () => {
  it("serve well-formed empty states with no store wired (never reject)", async () => {
    const { registerIpc } = await import("../../src/main/ipc");
    registerIpc({ db: openTestDb(), provider: inertProvider });
    const pump = handlers.get(IPC.pumpSearch) as () => unknown;
    expect(pump()).toMatchObject({ filesTotal: 0, filesDone: 0, done: true });
    const read = handlers.get(IPC.searchRead) as (since?: string) => unknown;
    const first = read() as { status: string; token: string };
    expect(first).toMatchObject({
      status: "changed",
      token: expect.any(String),
    });
    const query = handlers.get(IPC.searchQuery) as (q?: unknown) => unknown;
    expect(query("anything")).toMatchObject({
      ok: false,
      error: expect.any(String),
    });
  });

  it("memoize on the token with the electron event arg shape", async () => {
    const { registerIpc } = await import("../../src/main/ipc");
    registerIpc({
      db: openTestDb(),
      searchDb: seededDb(),
      provider: inertProvider,
    });
    const read = handlers.get(IPC.searchRead) as (
      e: unknown,
      since?: string,
    ) => unknown;
    const first = read({}, undefined) as {
      status: string;
      token: string;
    };
    expect(first.status).toBe("changed");
    // Electron calls handler(event, since): a same-token poll reads unchanged.
    expect(read({}, first.token)).toMatchObject({
      status: "unchanged",
      token: first.token,
    });
    void first;
  });

  it("query a wired store end-to-end and memo on the token", async () => {
    const { registerIpc } = await import("../../src/main/ipc");
    registerIpc({
      db: openTestDb(),
      searchDb: seededDb(),
      provider: inertProvider,
    });
    const query = handlers.get(IPC.searchQuery) as (
      q?: unknown,
      limit?: unknown,
    ) => unknown;
    expect(query("jump")).toMatchObject({
      ok: true,
      groups: expect.anything(),
    });
    expect(query("jump", 1)).toMatchObject({ ok: true });
    // Non-string queries are a typed empty result, not an error.
    expect(query(42)).toEqual({ ok: true, groups: [] });
  });
});
