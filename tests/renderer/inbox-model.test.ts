import { beforeEach, describe, expect, it } from "vitest";
import {
  $railListMode,
  inboxReason,
  inboxSessions,
  isInboxSession,
  setRailListMode,
  type RailListMode,
} from "../../src/renderer/src/shell/inbox-model";
import {
  filterGroups,
  groupSessionsByProject,
} from "../../src/renderer/src/shell/session-list-model";
import { DEFAULT_SESSIONS_LIST_PREFERENCES } from "../../src/renderer/src/shell/session-list-preferences";
import type { Session } from "@shared/types";

const mk = (o: Partial<Session>): Session => ({
  id: "s",
  title: "Session",
  project: "proj",
  state: "idle",
  management: "managed",
  agent: "claude",
  resumable: true,
  model: "sonnet",
  contextPct: 0,
  contextWindow: 200_000,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheCreation5mTokens: 0,
  },
  lastActivityMs: 0,
  createdMs: 0,
  ...o,
});

describe("inbox mode store", () => {
  beforeEach(() => {
    setRailListMode("all");
  });

  it("defaults to All, per renderer lifetime", () => {
    expect($railListMode.get()).toBe<RailListMode>("all");
  });

  it("switches modes in the store", () => {
    setRailListMode("inbox");
    expect($railListMode.get()).toBe("inbox");
  });
});

describe("inbox predicate", () => {
  it("keeps waiting and idle sessions, drops working and ended ones", () => {
    expect(isInboxSession(mk({ state: "waiting" }))).toBe(true);
    expect(isInboxSession(mk({ state: "idle" }))).toBe(true);
    expect(isInboxSession(mk({ state: "working" }))).toBe(false);
    expect(isInboxSession(mk({ state: "ended" }))).toBe(false);
  });
});

describe("inbox ordering", () => {
  it("filters and orders waiting first, then idle, each most recent first", () => {
    const oldWaiting = mk({ id: "ow", state: "waiting", lastActivityMs: 100 });
    const busy = mk({ id: "busy", state: "working", lastActivityMs: 999 });
    const ended = mk({ id: "ended", state: "ended", lastActivityMs: 900 });
    const newestWaiting = mk({
      id: "nw",
      state: "waiting",
      lastActivityMs: 500,
    });
    const oldIdle = mk({ id: "oi", state: "idle", lastActivityMs: 300 });
    const endedAlso = mk({ id: "ended2", state: "ended", lastActivityMs: 800 });
    expect(
      inboxSessions([
        oldWaiting,
        busy,
        ended,
        newestWaiting,
        oldIdle,
        endedAlso,
      ]).map((s) => s.id),
    ).toEqual(["nw", "ow", "oi"]);
  });

  it("does not mutate its input", () => {
    const a = mk({ id: "a", state: "idle", lastActivityMs: 1 });
    const b = mk({ id: "b", state: "waiting", lastActivityMs: 2 });
    const input = [a, b];
    inboxSessions(input);
    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("composes with the pinned chain: pinned inbox sessions in inbox order", () => {
    // The pinned rail pipes filterSessions-output into pinnedSessions; the composition under
    // test is "apply the inbox set first, preserving this module's order".
    const waiting = mk({
      id: "w",
      state: "waiting",
      lastActivityMs: 10,
      pinnedAtMs: 1,
    });
    const idle = mk({
      id: "i",
      state: "idle",
      lastActivityMs: 20,
      pinnedAtMs: 2,
    });
    const working = mk({
      id: "b",
      state: "working",
      lastActivityMs: 30,
      pinnedAtMs: 3,
    });
    // (pinnedSessions itself is covered by session-list-model.test.ts.)
    const flagged = inboxSessions([working, idle, waiting]).filter(
      (s) => s.pinnedAtMs !== undefined,
    );
    expect(flagged.map((s) => s.id)).toEqual(["w", "i"]);
  });
});

describe("inbox mode inside the group machinery", () => {
  it("composes with search and the agent preference, dropping non-inbox rows", () => {
    const groups = groupSessionsByProject(
      [
        mk({ id: "a", state: "waiting", lastActivityMs: 30 }),
        mk({ id: "b", state: "working", lastActivityMs: 20 }),
        mk({ id: "c", state: "idle", lastActivityMs: 10 }),
      ],
      "",
    );
    const [group] = filterGroups(
      groups,
      DEFAULT_SESSIONS_LIST_PREFERENCES,
      "",
      isInboxSession,
    );
    expect(group?.sessions.map((s) => s.id)).toEqual(["a", "c"]);
    // The agent preference, like search, is per-session narrowing: the group shell stays (a folder
    // keeps its row for quick-add), but everything inside is filtered.
    const filtered = filterGroups(
      groups,
      { ...DEFAULT_SESSIONS_LIST_PREFERENCES, agent: "codex" },
      "",
      isInboxSession,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessions).toEqual([]);
  });

  it("retains non-inbox ancestors of an inbox session (family context)", () => {
    // A waiting subagent keeps its (ended) parent root so the family shape survives the filter —
    // the same relationship retention the search filters already exercise.
    const parent = mk({
      id: "p",
      state: "ended",
      cwd: "/x/repo",
      repoRoot: "/x/repo",
      repoLabel: "repo",
      lastActivityMs: 5,
    });
    const child = mk({
      id: "c",
      state: "waiting",
      parentSessionId: "p",
      cwd: "/x/repo",
      lastActivityMs: 50,
    });
    const [group] = filterGroups(
      groupSessionsByProject([parent, child], ""),
      DEFAULT_SESSIONS_LIST_PREFERENCES,
      "",
      isInboxSession,
    );
    expect(group?.sessions.map((s) => s.id).sort()).toEqual(["c", "p"]);
  });
});

describe("inbox reason mapping", () => {
  it("idle sessions get their own label, not a waiting one", () => {
    expect(inboxReason(mk({ state: "idle" }))).toEqual({ kind: "idle" });
  });

  it("a waiting session with no known reason degrades to generic waiting", () => {
    expect(inboxReason(mk({ state: "waiting" }))).toEqual({ kind: "generic" });
    expect(
      inboxReason(mk({ state: "waiting", waitingReason: undefined })),
    ).toEqual({ kind: "generic" });
    expect(inboxReason(mk({ state: "waiting", waitingReason: "  " }))).toEqual({
      kind: "generic",
    });
  });

  it("free-form provider reasons (questions) stay generic — unknown, per the spec", () => {
    expect(
      inboxReason(mk({ state: "waiting", waitingReason: "A or B?" })),
    ).toEqual({ kind: "generic" });
  });

  it("maps the permission prefix to a permission chip naming the tool", () => {
    expect(
      inboxReason(mk({ state: "waiting", waitingReason: "Permission: Bash" })),
    ).toEqual({ kind: "permission", tool: "Bash" });
    // Case-insensitive prefix, whitespace-tolerant remainder.
    expect(
      inboxReason(mk({ state: "waiting", waitingReason: "permission: Read" })),
    ).toEqual({ kind: "permission", tool: "Read" });
    // A bare "Permission:" with nothing after it is not a usable mapping.
    expect(
      inboxReason(mk({ state: "waiting", waitingReason: "Permission:" })),
    ).toEqual({ kind: "generic" });
  });
});
