import { describe, it, expect } from "vitest";
import { createCompositeProvider } from "../../src/main/provider/composite";
import type { Provider } from "../../src/main/provider/types";
import type { SessionCandidate } from "@shared/types";

const cand = (
  id: string,
  agent: "claude" | "codex" | "opencode",
): SessionCandidate => ({
  id,
  agent,
  alive: false,
  cwd: "/w",
  transcriptMtimeMs: 1,
});
function fake(
  agent: "claude" | "codex" | "opencode",
  calls: string[],
): Provider {
  return {
    id: agent,
    listCandidates: () => [cand(`${agent}-1`, agent)],
    summarize: (c) => {
      calls.push(`summarize:${agent}:${c.id}`);
      return {} as never;
    },
    restate: (c, p) => {
      calls.push(`restate:${agent}:${c.id}`);
      return p;
    },
    readTranscript: (id) => {
      calls.push(`readTranscript:${agent}:${id}`);
      return { status: "absent" };
    },
    getToolResult: () => ({ found: false }),
    readSubagentTranscript: () => ({ status: "absent" }),
    readTasks: () => ({ status: "absent" }),
    readShells: () => ({ status: "absent" }),
    readShellOutput: () => ({ status: "absent" }),
    readMonitors: () => ({ status: "absent" }),
    readMonitorOutput: () => ({ status: "absent" }),
    readMetrics: () => ({ status: "absent" }),
    resolveResumeTarget: (id) => {
      calls.push(`resume:${agent}:${id}`);
      return null;
    },
    resolveSessionCwd: (id) => {
      calls.push(`cwd:${agent}:${id}`);
      return null;
    },
    resolveTranscriptPath: (id) => {
      calls.push(`path:${agent}:${id}`);
      return null;
    },
  };
}

describe("createCompositeProvider", () => {
  it("unions listCandidates and dispatches summarize/restate by candidate.agent", async () => {
    const calls: string[] = [];
    const p = createCompositeProvider(
      {
        claude: fake("claude", calls),
        codex: fake("codex", calls),
        opencode: fake("opencode", calls),
      },
      () => "claude",
    );
    const cands = await p.listCandidates();
    expect(cands.map((c) => c.id).sort()).toEqual([
      "claude-1",
      "codex-1",
      "opencode-1",
    ]);
    await p.summarize(cands.find((c) => c.agent === "codex")!);
    expect(calls).toContain("summarize:codex:codex-1");
  });
  it("routes per-id reads through the agent resolver", async () => {
    const calls: string[] = [];
    const p = createCompositeProvider(
      {
        claude: fake("claude", calls),
        codex: fake("codex", calls),
        opencode: fake("opencode", calls),
      },
      (id) =>
        id.startsWith("codex")
          ? "codex"
          : id.startsWith("opencode")
            ? "opencode"
            : "claude",
    );
    await p.readTranscript("codex-9");
    await p.readTranscript("opencode-9");
    p.resolveSessionCwd("someone");
    p.resolveTranscriptPath("codex-10");
    expect(calls).toContain("readTranscript:codex:codex-9");
    expect(calls).toContain("readTranscript:opencode:opencode-9");
    expect(calls).toContain("cwd:claude:someone");
    expect(calls).toContain("path:codex:codex-10");
  });

  it("routes the fork arm by agent and answers unsupported providers in band (tier-1 Run 2 / A3)", async () => {
    const calls: string[] = [];
    const opencode = fake("opencode", calls);
    opencode.forkSession = (id: string) => {
      calls.push(`fork:opencode:${id}`);
      return Promise.resolve({ ok: true, session: { id: "forked-1" } as never });
    };
    const p = createCompositeProvider(
      { claude: fake("claude", calls), codex: fake("codex", calls), opencode },
      (id) =>
        id.startsWith("opencode")
          ? "opencode"
          : id.startsWith("codex")
            ? "codex"
            : "claude",
    );
    const forked = await p.forkSession?.("opencode-9");
    expect(forked).toEqual({ ok: true, session: { id: "forked-1" } });
    expect(calls).toContain("fork:opencode:opencode-9");
    // A provider without the arm degrades in band — never a rejection.
    await expect(p.forkSession?.("codex-9")).resolves.toMatchObject({
      ok: false,
    });
  });
});
