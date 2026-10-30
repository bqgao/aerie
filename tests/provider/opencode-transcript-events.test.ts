import { describe, it, expect } from "vitest";
import {
  buildTranscriptDoc,
  oneLiner,
} from "../../src/main/provider/opencode/transcript-events";

/** Shapes copied from the redacted live fixtures (tests/fixtures/opencode/messages.json); built
 *  inline so each test names exactly one wire-shape decision. `completed` is only stamped when the
 *  message is final — a still-streaming assistant (its tool still `running`) carries none, which
 *  is exactly the distinction the waiting-reason verdict leans on. */
const textPart = (text: string) => ({ type: "text", text });

const toolPart = (
  name: string,
  id: string,
  status: string,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  type: "tool",
  id,
  name,
  executed: false,
  state: { status, input, ...extra },
});

const message = (
  type: "user" | "assistant",
  created: number,
  content: unknown[],
  opts: { tokens?: Record<string, unknown>; final?: boolean } = {},
) => ({
  id: `msg_${created}_${type}`,
  type,
  time:
    type === "assistant" && opts.final !== false
      ? { created, completed: created + 500 }
      : { created },
  content,
  ...(opts.tokens ? { tokens: opts.tokens } : {}),
});

describe("buildTranscriptDoc", () => {
  it("walks oldest-first into user/assistant/thinking events in part order", () => {
    // The caller (provider) sorts ascending before walking; array order is trusted order.
    const doc = buildTranscriptDoc([
      message("user", 100, [textPart("add dark mode")]),
      message("assistant", 200, [
        { type: "reasoning", text: "think" },
        textPart("done"),
      ]),
    ]);
    expect(doc.events).toEqual([
      { kind: "user", text: "add dark mode" },
      { kind: "thinking", text: "think" },
      { kind: "assistant", text: "done" },
    ]);
  });

  it("ignores control message types (idle/synthetic/model-switched) and unknown parts", () => {
    const doc = buildTranscriptDoc([
      {
        id: "msg_idle",
        type: "idle",
        time: { created: 1 },
        outcome: "succeeded",
      },
      message("user", 100, [{ ...textPart("not text"), type: "file-parts" }]),
      message("user", 120, [textPart("real prompt")]),
      message("assistant", 200, [{ type: "step-start" }, textPart("answer")]),
      { id: "msg_synth", type: "synthetic", time: { created: 300 } },
      { id: "msg_switch", type: "model-switched", time: { created: 310 } },
    ]);
    expect(doc.events).toEqual([
      { kind: "user", text: "real prompt" },
      { kind: "assistant", text: "answer" },
    ]);
    expect(doc.waitingReason).toBeNull();
  });

  it("empty-content users and blank texts produce nothing", () => {
    const doc = buildTranscriptDoc([
      message("user", 100, []),
      message("user", 110, [textPart("   ")]),
    ]);
    expect(doc.events).toEqual([]);
    expect(doc.turns).toEqual([]);
  });

  it("edit/write tools render as diff events with the real v2 input keys", () => {
    const doc = buildTranscriptDoc([
      message("assistant", 200, [
        toolPart("edit", "call_1", "completed", {
          path: "/w/a.ts",
          oldString: "a\nb",
          newString: "a\nc",
        }),
        toolPart("write", "call_2", "completed", {
          path: "/w/new.ts",
          content: "x\ny",
        }),
      ]),
    ]);
    expect(doc.events).toEqual([
      {
        kind: "diff",
        tool: "edit",
        file: "/w/a.ts",
        hunk: { removed: ["a", "b"], added: ["a", "c"] },
        status: "ok",
      },
      {
        kind: "diff",
        tool: "write",
        file: "/w/new.ts",
        hunk: { removed: [], added: ["x", "y"] }, // write has no old text — added-only hunk
        status: "ok",
      },
    ]);
  });

  it("tool rows: status mapping honours the live state union, outputLines from content", () => {
    const doc = buildTranscriptDoc([
      message("assistant", 200, [
        toolPart("shell", "call_run", "running", { command: "wait" }),
        toolPart(
          "shell",
          "call_done",
          "completed",
          { command: "pwd" },
          {
            content: [{ type: "text", text: "/w\n" }],
          },
        ),
        toolPart(
          "shell",
          "call_err",
          "error",
          {},
          {
            error: {
              type: "tool.input-incomplete",
              message: "arguments not completed",
            },
          },
        ),
        toolPart(
          "shell",
          "call_meta",
          "completed",
          { command: "meta" },
          {
            content: [{ type: "text", text: "x" }],
            metadata: { error: "boom" },
          },
        ),
      ]),
    ]);
    expect(doc.events[0]).toMatchObject({
      kind: "tool",
      name: "shell",
      input: "wait",
      toolUseId: "call_run",
      status: "pending", // running → pending (streaming would be too)
      outputLines: 0,
    });
    expect(doc.events[1]).toMatchObject({
      kind: "tool",
      toolUseId: "call_done",
      status: "ok",
      outputLines: 1, // trailing newline adds no phantom line
    });
    expect(doc.events[2]).toMatchObject({
      kind: "tool",
      toolUseId: "call_err",
      status: "error", // the state's error block → error
    });
    // A completed call whose metadata carries an error still reads error.
    expect(doc.events[3]).toMatchObject({
      toolUseId: "call_meta",
      status: "error",
    });
  });

  it("turns split at user messages with prompt/start/end/toolCount", () => {
    const doc = buildTranscriptDoc([
      message("user", 100, [textPart("first line\nsecond")]),
      message("assistant", 300, [
        toolPart("shell", "c1", "completed", { command: "ls" }),
        textPart("ok"),
      ]),
      message("user", 400, [textPart("again")]),
      message("assistant", 500, [textPart("done two")]),
    ]);
    expect(doc.turns).toHaveLength(2);
    // Turn 1 closes when the NEXT prompt arrives (endMs = last assistant completion ≥ start),
    // and the trailing-in-flight rule (durationMs 0 startMs==endMs) never appears here.
    expect(doc.turns[0]).toMatchObject({
      index: 1,
      prompt: "first line",
      startMs: 100,
      endMs: 800,
      durationMs: 700,
      toolCount: 1,
    });
    expect(doc.turns[1]).toMatchObject({
      index: 2,
      prompt: "again",
      startMs: 400,
      endMs: 1000,
      durationMs: 600,
      toolCount: 0,
    });
  });

  it("waitingReason: trailing unanswered prompt → first line; trailing pending tool → that tool", () => {
    const unanswered = buildTranscriptDoc([
      message("user", 100, [textPart("what about it?\nmore")]),
      { id: "msg_i", type: "idle", time: { created: 200 } }, // control rows don't answer
    ]);
    expect(unanswered.waitingReason).toBe("what about it?");

    // Still-streaming assistant (no time.completed), tool mid-run → waiting on that tool.
    const pendingTool = buildTranscriptDoc([
      message("user", 100, [textPart("prompt")]),
      message(
        "assistant",
        200,
        [toolPart("shell", "c1", "running", { command: "make -j4" })],
        { final: false },
      ),
    ]);
    expect(pendingTool.waitingReason).toBe("make -j4");

    const answered = buildTranscriptDoc([
      message("user", 100, [textPart("prompt")]),
      message("assistant", 200, [textPart("answer")]),
    ]);
    expect(answered.waitingReason).toBeNull();
  });

  it("context rides the LAST assistant message that reported tokens", () => {
    const doc = buildTranscriptDoc([
      message("assistant", 100, [textPart("a")], {
        tokens: {
          input: 100,
          output: 10,
          reasoning: 5,
          cache: { read: 800, write: 3 },
        },
      }),
      message("assistant", 200, [textPart("b")], {
        tokens: {
          input: 200,
          output: 20,
          reasoning: 0,
          cache: { read: 900, write: 0 },
        },
      }),
    ]);
    expect(doc.context).toEqual({
      input: 200,
      cacheRead: 900,
      cacheCreation: 0,
    });
  });
});

describe("oneLiner", () => {
  it("shell rows read the command; grep/glob the pattern; read the path; edit the file", () => {
    expect(oneLiner("shell", { command: "git status" })).toBe("git status");
    expect(oneLiner("read", { path: "/w/a.ts" })).toBe("/w/a.ts");
    expect(oneLiner("grep", { pattern: "foo", path: "/w" })).toBe("foo");
    expect(oneLiner("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(oneLiner("edit", { path: "/w/a.ts" })).toBe("/w/a.ts");
    expect(oneLiner("webfetch", { url: "https://x", prompt: "p" })).toBe(
      "https://x",
    );
    expect(oneLiner("websearch", { query: "q" })).toBe("q");
  });
  it("unknown tools fall back to compact JSON, truncated at 200", () => {
    expect(oneLiner("mystery", { a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(oneLiner("mystery", { blob: "x".repeat(500) })).toHaveLength(200);
  });
});
