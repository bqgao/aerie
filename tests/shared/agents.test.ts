import { describe, it, expect } from "vitest";
import {
  AGENT_IDS,
  AGENTS,
  isAgentId,
  agentOrDefault,
} from "../../src/shared/agents";

describe("AGENTS registry", () => {
  it("has one descriptor per id, self-keyed", () => {
    for (const id of AGENT_IDS) {
      expect(AGENTS[id].id).toBe(id);
      expect(AGENTS[id].label.length).toBeGreaterThan(0);
      expect(AGENTS[id].binary.length).toBeGreaterThan(0);
    }
  });
  it("claude has every capability except the service-API prompt op; codex has transcript + telemetry + rate limits + resume", () => {
    // canPrompt is the one deliberate exception: it denotes the v2 service API's POST prompt op
    // (tier-1 Run 2 / A4), which no CLI carries — the opencode descriptor declares it instead.
    const { canPrompt, ...claudeCaps } = AGENTS.claude.capabilities;
    expect(canPrompt).toBe(false);
    expect(Object.values(claudeCaps).every(Boolean)).toBe(true);
    const {
      hasTranscript,
      hasTelemetry,
      hasRateLimits,
      canResume,
      hasStats,
      ...rest
    } = AGENTS.codex.capabilities;
    expect(hasTranscript).toBe(true);
    expect(hasTelemetry).toBe(true);
    expect(hasRateLimits).toBe(true);
    expect(canResume).toBe(true);
    expect(hasStats).toBe(true);
    expect(Object.values(rest).some(Boolean)).toBe(false);
  });
  it("both agents have Stats; only Claude has project/session breakdowns", () => {
    expect(AGENTS.claude.capabilities.hasStats).toBe(true);
    expect(AGENTS.codex.capabilities.hasStats).toBe(true);
    expect(AGENTS.claude.capabilities.hasStatsBreakdowns).toBe(true);
    expect(AGENTS.codex.capabilities.hasStatsBreakdowns).toBe(false);
  });
  it("labels and binaries are the branded/spawnable names", () => {
    expect(AGENTS.claude).toMatchObject({
      label: "Claude Code",
      binary: "claude",
    });
    expect(AGENTS.codex).toMatchObject({ label: "Codex", binary: "codex" });
  });
});

describe("isAgentId / agentOrDefault", () => {
  it("recognizes exactly the registered ids", () => {
    expect(isAgentId("claude")).toBe(true);
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("copilot")).toBe(false);
    expect(isAgentId(undefined)).toBe(false);
  });
  it("defaults anything unrecognized to claude (legacy rows)", () => {
    expect(agentOrDefault("codex")).toBe("codex");
    expect(agentOrDefault("garbage")).toBe("claude");
    expect(agentOrDefault(null)).toBe("claude");
  });
});
