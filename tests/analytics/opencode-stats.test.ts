import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { wrap } from "../../src/main/db/driver";
import { migrateAnalytics, readTotals } from "../../src/main/db/analytics";
import { openTestDb } from "../helpers/sqlite";
import {
  openOpencodeStatsStore,
  readUsageRows,
  scanOpencodeStatsStep,
} from "../../src/main/analytics/opencode-stats";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

/** Build a fake opencode store: session_v2 + session_message with one assistant row. */
function makeStore(root: string, name = "opencode.db"): string {
  const path = join(root, name);
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT);" +
      "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_updated INTEGER, data TEXT);",
  );
  db.prepare("INSERT INTO session_v2 (id, directory) VALUES (?, ?)").run(
    "ses_x",
    "/work/app",
  );
  const data = JSON.stringify({
    cost: 0.5,
    tokens: { input: 100, output: 40, cache: { read: 10, write: 5 } },
    model: { modelID: "qwen-3.5" },
  });
  db.prepare(
    "INSERT INTO session_message (id, session_id, type, time_updated, data) VALUES (?, ?, 'assistant', ?, ?)",
  ).run("m1", "ses_x", 1730000000000, data);
  db.close();
  return path;
}

const openFile = (path: string) =>
  wrap(new DatabaseSync(path, { readOnly: true }));

describe("opencode analytics scan", () => {
  it("extracts usage rows: model, cost, tokens, cache split", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-stats-"));
    const path = makeStore(root);
    const store = openOpencodeStatsStore(openFile, path);
    expect(store).toBeDefined();
    const rows = readUsageRows(store!, 0, 0, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "ses_x",
      directory: "/work/app",
      modelId: "qwen-3.5",
      costUsd: 0.5,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
    });
  });

  it("step mirrors rows into turns and advances the cursor", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-stats-"));
    const path = makeStore(root);
    const analytics = openTestDb();
    migrateAnalytics(analytics);
    const first = scanOpencodeStatsStep(analytics, openFile, path);
    expect(first.done).toBe(true);
    const totals = readTotals(
      analytics,
      { sinceMs: null, untilMs: null },
      "opencode",
    );
    const t = totals as unknown as { turns: number };
    expect(t.turns).toBe(1);
    const second = scanOpencodeStatsStep(analytics, openFile, path);
    expect(second.done).toBe(true);
    const after = readTotals(
      analytics,
      { sinceMs: null, untilMs: null },
      "opencode",
    ) as unknown as {
      turns: number;
    };
    expect(after.turns).toBe(1);
  });

  it("soft-fails when the store is absent", () => {
    const analytics = openTestDb();
    migrateAnalytics(analytics);
    const res = scanOpencodeStatsStep(
      analytics,
      openFile,
      join(mkdtempSync(join(tmpdir(), "oc-stats-")), "nope.db"),
    );
    expect(res.done).toBe(true);
  });
});
