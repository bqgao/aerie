import { describe, expect, it } from "vitest";
import {
  autoSendable,
  canAutoSend,
  emptyQueue,
  queuedCount,
  queuedError,
  reducePrompts,
  queueOf,
  type PromptQueueEvent,
  type PromptQueues,
} from "../../src/renderer/src/shell/prompt-queue";
import type { Session } from "@shared/types";

const mkSession = (over: Partial<Session>): Session => ({
  id: "ses",
  title: "Session",
  project: "proj",
  state: "waiting",
  management: "managed",
  agent: "opencode",
  resumable: true,
  model: "opus",
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
  ...over,
});

const fire = (state: PromptQueues, events: PromptQueueEvent[]) =>
  events.reduce((s, e) => reducePrompts(s, e), state satisfies PromptQueues);

describe("prompt queue reducer (tier-1 Run 2 / A4)", () => {
  it("enqueues trimmed prompts behind existing ones", () => {
    const one = reducePrompts(
      {},
      {
        type: "enqueue",
        sessionId: "ses",
        id: "q1",
        text: "  ship it?  ",
      },
    );
    expect(queueOf(one, "ses").entries).toEqual([
      { id: "q1", text: "ship it?" },
    ]);
    const two = reducePrompts(one, {
      type: "enqueue",
      sessionId: "ses",
      id: "q2",
      text: "then document it",
    });
    expect(queuedCount(two, "ses")).toBe(2);
  });

  it("an empty (whitespace) prompt is a no-op, not an error", () => {
    const s = fire({}, [
      { type: "enqueue", sessionId: "ses", id: "q1", text: "   " },
    ]);
    expect(s).toEqual({});
  });

  it("queues are per-session", () => {
    const s = fire({}, [
      { type: "enqueue", sessionId: "a", id: "q1", text: "one" },
      { type: "enqueue", sessionId: "b", id: "q2", text: "two" },
    ]);
    expect(queuedCount(s, "a")).toBe(1);
    expect(queueOf(s, "b").entries[0]?.id).toBe("q2");
  });

  it("sendStart marks the head in flight and only once per session", () => {
    const queued = fire({}, [
      { type: "enqueue", sessionId: "ses", id: "q1", text: "one" },
      { type: "enqueue", sessionId: "ses", id: "q2", text: "two" },
    ]);
    const started = reducePrompts(queued, {
      type: "sendStart",
      sessionId: "ses",
      id: "q1",
    });
    expect(queueOf(started, "ses").sendingId).toBe("q1");
    // A second start (even for another head) is a no-op while one is in flight.
    expect(
      reducePrompts(started, { type: "sendStart", sessionId: "ses", id: "q2" }),
    ).toBe(started);
    // Only the actual head can start.
    expect(
      reducePrompts(queued, { type: "sendStart", sessionId: "ses", id: "q2" }),
    ).toBe(queued);
  });

  it("sendStart clears a previous failure's error marker (fresh retry)", () => {
    const s = fire({}, [
      { type: "enqueue", sessionId: "ses", id: "q1", text: "one" },
      { type: "sendStart", sessionId: "ses", id: "q1" },
      {
        type: "sendFailed",
        sessionId: "ses",
        id: "q1",
        error: "HTTP 400 invalid request",
      },
    ]);
    expect(queuedError(s, "ses")).toBe("HTTP 400 invalid request");
    const retry = reducePrompts(s, {
      type: "sendStart",
      sessionId: "ses",
      id: "q1",
    });
    expect(queuedError(retry, "ses")).toBeNull();
  });

  it("a success drops the head — the badge decrements", () => {
    const s = fire({}, [
      { type: "enqueue", sessionId: "ses", id: "q1", text: "one" },
      { type: "enqueue", sessionId: "ses", id: "q2", text: "two" },
      { type: "sendStart", sessionId: "ses", id: "q1" },
      { type: "sendDone", sessionId: "ses", id: "q1" },
    ]);
    expect(queuedCount(s, "ses")).toBe(1);
    expect(queueOf(s, "ses").sendingId).toBeUndefined();
    expect(queueOf(s, "ses").entries[0]?.id).toBe("q2");
  });

  it("a failure keeps the head with its in-band error — badge unchanged", () => {
    const s = fire({}, [
      { type: "enqueue", sessionId: "ses", id: "q1", text: "one" },
      { type: "sendStart", sessionId: "ses", id: "q1" },
      {
        type: "sendFailed",
        sessionId: "ses",
        id: "q1",
        error: "the service refused",
      },
    ]);
    expect(queuedCount(s, "ses")).toBe(1);
    expect(queueOf(s, "ses").entries[0]).toMatchObject({
      id: "q1",
      text: "one",
      error: "the service refused",
    });
    expect(queueOf(s, "ses").sendingId).toBeUndefined(); // re-armed for the next tick
  });

  it("a stale settle cannot drop another head", () => {
    const s = fire({}, [
      { type: "enqueue", sessionId: "ses", id: "q1", text: "one" },
      { type: "sendStart", sessionId: "ses", id: "q1" },
      { type: "sendDone", sessionId: "ses", id: "q1" },
      { type: "sendStart", sessionId: "ses", id: null as never }, // malformed head id ignored
    ]);
    expect(queuedCount(s, "ses")).toBe(0);
  });

  it("clear vacates the session's queue (and only that session's)", () => {
    const s = fire({}, [
      { type: "enqueue", sessionId: "a", id: "q1", text: "one" },
      { type: "enqueue", sessionId: "b", id: "q2", text: "two" },
      { type: "clear", sessionId: "a" },
    ]);
    expect(s["a"]).toBeUndefined();
    expect(queuedCount(s, "b")).toBe(1);
  });

  it("a success on the LAST prompt removes the queue entirely", () => {
    const s = fire({}, [
      { type: "enqueue", sessionId: "ses", id: "q1", text: "one" },
      { type: "sendStart", sessionId: "ses", id: "q1" },
      { type: "sendDone", sessionId: "ses", id: "q1" },
    ]);
    expect(s["ses"]).toBeUndefined();
  });
});

describe("auto-send gate (tier-1 Run 2 / A4)", () => {
  it("sends only a non-empty, idle-out, waiting-on-user opencode session", () => {
    const queues: PromptQueues = {};
    const queued = fire(queues, [
      { type: "enqueue", sessionId: "ses", id: "q1", text: "one" },
    ]);
    expect(
      canAutoSend(queued, mkSession({ id: "ses", state: "waiting" })),
    ).toBe(true);
    // Working again → park.
    expect(
      canAutoSend(queued, mkSession({ id: "ses", state: "working" })),
    ).toBe(false);
    // Ended sessions are history, not a dispatch target.
    expect(canAutoSend(queued, mkSession({ id: "ses", state: "ended" }))).toBe(
      false,
    );
    // Not a prompt-capable agent (flag semantics baked into the gate).
    expect(canAutoSend(queued, mkSession({ id: "ses", agent: "claude" }))).toBe(
      false,
    );
    // Empty queue / in-flight head → no.
    expect(canAutoSend(queued, undefined)).toBe(false);
    const empty = fire(queued, [{ type: "clear", sessionId: "ses" }]);
    expect(canAutoSend(empty, mkSession({ id: "ses" }))).toBe(false);
  });

  it("autoSendable picks ONE head per session per poll tick", () => {
    const queued = fire({}, [
      { type: "enqueue", sessionId: "a", id: "q1", text: "one" },
      { type: "enqueue", sessionId: "a", id: "q2", text: "two" },
      { type: "enqueue", sessionId: "b", id: "q3", text: "three" },
      { type: "enqueue", sessionId: "c", id: "q4", text: "no session" },
    ]);
    const due = autoSendable(queued, [
      mkSession({ id: "a", state: "waiting" }),
      mkSession({ id: "b", state: "waiting" }),
      mkSession({ id: "c", state: "working" }), // queue exists, parked
    ]);
    expect(due).toEqual([
      { sessionId: "a", id: "q1", text: "one" },
      { sessionId: "b", id: "q3", text: "three" },
    ]);
  });

  it("an in-flight send suppresses the auto-send for that session", () => {
    const mid = fire({}, [
      { type: "enqueue", sessionId: "a", id: "q1", text: "one" },
      { type: "sendStart", sessionId: "a", id: "q1" },
    ]);
    expect(
      autoSendable(mid, [mkSession({ id: "a", state: "waiting" })]),
    ).toEqual([]);
  });

  it("emptyQueue is the no-session baseline", () => {
    expect(emptyQueue.entries).toEqual([]);
    expect(queuedCount({}, "nowhere")).toBe(0);
    expect(queuedError({}, "nowhere")).toBeNull();
  });
});
