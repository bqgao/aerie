import { describe, it, expect } from "vitest";
import { extractToolResult } from "../../src/main/provider/opencode/tool-result";
import messageRows from "../fixtures/opencode/messages.json";

const messages = messageRows.data as unknown[];

describe("extractToolResult", () => {
  it("pulls the full friendly command and output from the ONE tool part (no call/output pairing)", () => {
    // Find a completed tool part in the redacted live-shape fixture to assert the shape end-to-end.
    const part = messages
      .flatMap((m) => (m as { content?: unknown[] }).content ?? [])
      .find(
        (p) =>
          (p as { type?: string }).type === "tool" &&
          (p as { state?: { status?: string } }).state?.status === "completed",
      );
    expect(part).toBeDefined();
    const tool = part as {
      id: string;
      name: string;
      state: { input: unknown; content?: unknown[] };
    };
    const r = extractToolResult(messages as never[], tool.id);
    expect(r).toMatchObject({ found: true, status: "ok" });
    if (!r.found) return;
    expect(typeof r.command).toBe("string");
    expect(typeof r.output).toBe("string");
  });

  it("an errored state surfaces the state.error diagnosis (input may be empty)", () => {
    const messages = [
      {
        id: "msg_1",
        type: "assistant",
        time: { created: 100 },
        content: [
          {
            type: "tool",
            id: "call_x",
            name: "write",
            state: {
              status: "error",
              input: {},
              error: {
                type: "tool.input-incomplete",
                message:
                  "Tool call arguments were not completed and were not executed.",
              },
            },
          },
        ],
      },
    ];
    expect(extractToolResult(messages, "call_x")).toEqual({
      found: true,
      command: "write",
      output: "Tool call arguments were not completed and were not executed.",
      status: "error",
    });
  });

  it("a running/pending tool opens empty; metadata-error completed reads error; found:false otherwise", () => {
    const messages = [
      {
        id: "msg_1",
        type: "assistant",
        time: { created: 100 },
        content: [
          {
            type: "tool",
            id: "call_run",
            name: "shell",
            state: { status: "running", input: { command: "tail -f" } },
          },
          {
            type: "tool",
            id: "call_meta",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "ok" },
              content: [{ type: "text", text: "out" }],
              metadata: { error: { message: "boom" } },
            },
          },
        ],
      },
    ];
    expect(extractToolResult(messages, "call_run")).toEqual({
      found: true,
      command: "tail -f",
      output: "",
      status: "pending",
    });
    expect(extractToolResult(messages, "call_meta")).toEqual({
      found: true,
      command: "ok",
      output: "out",
      status: "error",
    });
    expect(extractToolResult(messages, "call_missing")).toEqual({
      found: false,
    });
    expect(extractToolResult(messages, "")).toEqual({ found: false });
  });

  it("caps the modal's output at ~100k chars", () => {
    const messages = [
      {
        id: "msg_1",
        type: "assistant",
        time: { created: 100 },
        content: [
          {
            type: "tool",
            id: "call_big",
            name: "read",
            state: {
              status: "completed",
              input: { path: "/big" },
              content: [{ type: "text", text: "x".repeat(150_000) }],
            },
          },
        ],
      },
    ];
    const result = extractToolResult(messages, "call_big");
    expect(result.found).toBe(true);
    if (result.found) expect(result.output.length).toBe(100_000);
  });
});
