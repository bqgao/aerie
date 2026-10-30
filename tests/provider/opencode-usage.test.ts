import { describe, it, expect } from "vitest";
import {
  usageFromRow,
  ZERO_USAGE,
  speedFromMessages,
} from "../../src/main/provider/opencode/usage";
import { buildTranscriptDoc } from "../../src/main/provider/opencode/transcript-events";

const row = {
  input: 148103,
  output: 12485,
  reasoning: 38969,
  cache: { read: 1245440, write: 0 },
};

describe("usageFromRow", () => {
  it("maps the session row's token block onto the shared disjoint Usage shape", () => {
    // reasoning IS generated output under a different name — same quantity the transcript parser
    // would otherwise double-book. Not a prompt cost.
    expect(usageFromRow(row)).toEqual({
      inputTokens: 148103,
      outputTokens: 12485 + 38969,
      cacheReadTokens: 1245440,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0, // not broken out by the v2 API (documented in the module)
      cacheCreation1hTokens: 0,
    });
  });

  it("tolerates missing/absent token blocks to zero", () => {
    expect(usageFromRow(null)).toEqual(ZERO_USAGE);
    expect(usageFromRow({})).toEqual(ZERO_USAGE);
    expect(usageFromRow({ input: "NaN", output: 5 })).toEqual({
      ...ZERO_USAGE,
      outputTokens: 5,
    });
  });
});

describe("speedFromMessages", () => {
  it("reuses codex's interval arithmetic over synthesized per-message events", () => {
    const speed = speedFromMessages(
      [
        // newest-first input order (as the service serves it) — synthesized events sort.
        {
          type: "assistant",
          tokens: { input: 200, output: 30, reasoning: 10 },
          time: { created: 3000, completed: 4000 },
        },
        {
          type: "assistant",
          tokens: { input: 100, output: 20, reasoning: 0 },
          time: { created: 1000, completed: 2000 },
        },
        { type: "user", tokens: null }, // user rows never contribute
        { type: "idle" }, // control rows skipped
        { type: "assistant", tokens: null, time: { created: 5, completed: 5 } }, // usage-less
      ],
      10_000,
    );
    expect(speed).not.toBeNull();
    if (!speed) return;
    // Two accepted intervals: 2000→? the first event (ts 2000) has no interval; 2000→4000 carries
    // the second message's output (30+10=40). input 200.
    expect(speed.inputTps).toBeCloseTo(200 / 2, 5);
    expect(speed.outputTps).toBeCloseTo(40 / 2, 5);
    expect(speed.totalTps).toBeCloseTo(240 / 2, 5);
  });

  it("falls to null below two usable interval events", () => {
    expect(speedFromMessages([], 10_000)).toBeNull();
    expect(
      speedFromMessages(
        [{ type: "assistant", tokens: {}, time: { created: 1, completed: 2 } }],
        10_000,
      ),
    ).toBeNull();
    // Two events with zero duration between them → no interval → null.
    expect(
      speedFromMessages(
        [
          {
            type: "assistant",
            tokens: { output: 1 },
            time: { created: 5, completed: 6 },
          },
          {
            type: "assistant",
            tokens: { output: 1 },
            time: { created: 5, completed: 6 },
          },
        ],
        10_000,
      ),
    ).toBeNull();
  });

  it("agrees with the transcript parser's read of the same messages (split forwards)", () => {
    // The context split and the sidebar spend can never disagree — one usageFromRow under both.
    const messages = [
      {
        id: "a",
        type: "assistant",
        time: { created: 1, completed: 2 },
        content: [{ type: "text", text: "out" }],
        tokens: {
          input: 10,
          output: 2,
          reasoning: 1,
          cache: { read: 5, write: 1 },
        },
      },
      {
        id: "b",
        type: "assistant",
        time: { created: 10, completed: 12 },
        content: [{ type: "text", text: "out2" }],
        tokens: {
          input: 20,
          output: 3,
          reasoning: 0,
          cache: { read: 6, write: 0 },
        },
      },
    ];
    const doc = buildTranscriptDoc(messages);
    expect(doc.context).toEqual({ input: 20, cacheRead: 6, cacheCreation: 0 });
    expect(usageFromRow(row).cacheCreationTokens).toBe(0);
  });
});
