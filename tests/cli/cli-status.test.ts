import { describe, it, expect } from "vitest";
import {
  evaluateCliStatus,
  MIN_CLAUDE_VERSION,
  AGENT_PROBES,
  type CliProbeInput,
} from "../../src/main/cli-status";

const base: CliProbeInput = {
  version: { status: "ok", raw: "2.1.178 (Claude Code)" },
  auth: { status: "ok" },
  floor: MIN_CLAUDE_VERSION,
  productPattern: /claude/i,
  configDir: { active: "/Users/me/.claude" },
  now: 1_000,
};

describe("evaluateCliStatus", () => {
  it("ready when found, runs, >= floor, logged in", () => {
    expect(evaluateCliStatus(base).kind).toBe("ready");
  });
  it("notFound when the binary isn't there (spawn error)", () => {
    expect(
      evaluateCliStatus({ ...base, version: { status: "spawnError" } }).kind,
    ).toBe("notFound");
  });
  it("unknown when it ran but the version was unparsable", () => {
    expect(
      evaluateCliStatus({ ...base, version: { status: "ok", raw: "???" } })
        .kind,
    ).toBe("unknown");
  });
  it("unknown when the version run failed (non-zero / timeout)", () => {
    expect(
      evaluateCliStatus({ ...base, version: { status: "failed" } }).kind,
    ).toBe("unknown");
  });
  it("outdated when below the floor", () => {
    const r = evaluateCliStatus({
      ...base,
      version: { status: "ok", raw: "1.9.0 (Claude Code)" },
    });
    expect(r.kind).toBe("outdated");
    expect(r.detail).toContain(MIN_CLAUDE_VERSION);
  });
  it("unknown when a colliding `claude` prints a version but isn't Claude Code", () => {
    const r = evaluateCliStatus({
      ...base,
      version: { status: "ok", raw: "9.9.9 (SomeOtherTool)" },
    });
    expect(r.kind).toBe("unknown");
    expect(r.detail).toBe("not Claude Code");
  });
  it("stays ready on a bare version string with no marker (parseSemver allows bare output)", () => {
    expect(
      evaluateCliStatus({
        ...base,
        version: { status: "ok", raw: "2.1.178\n" },
      }).kind,
    ).toBe("ready");
  });
  it("treats a bare below-floor version as outdated, not 'not Claude Code'", () => {
    expect(
      evaluateCliStatus({ ...base, version: { status: "ok", raw: "1.9.0" } })
        .kind,
    ).toBe("outdated");
  });
  it("loggedOut when compatible but auth status exited 1", () => {
    expect(
      evaluateCliStatus({ ...base, auth: { status: "loggedOut" } }).kind,
    ).toBe("loggedOut");
  });
  it("does NOT cry logged-out when the auth probe itself failed", () => {
    expect(
      evaluateCliStatus({ ...base, auth: { status: "unknown" } }).kind,
    ).toBe("ready");
  });
  it("carries the active config dir straight through for display", () => {
    expect(evaluateCliStatus(base).configDir).toEqual({
      active: "/Users/me/.claude",
    });
  });
  it("null floor skips the outdated gate; null productPattern skips the tag check", () => {
    const s = evaluateCliStatus({
      ...base,
      auth: { status: "unknown" },
      version: { status: "ok", raw: "0.1.0 (SomeOtherTool)" },
      floor: null,
      productPattern: null,
    });
    expect(s.kind).toBe("ready");
  });
});

describe("AGENT_PROBES", () => {
  it("claude probe spec keeps the floor, tag pattern, and auth stage; codex disables all three", () => {
    expect(AGENT_PROBES.claude).toMatchObject({
      binary: "claude",
      checkAuth: true,
    });
    expect(AGENT_PROBES.claude.floor).not.toBeNull();
    expect(AGENT_PROBES.codex).toMatchObject({
      binary: "codex",
      floor: null,
      productPattern: null,
      checkAuth: false,
    });
  });
  // opencode: a version floor (the provider's v2 API contract) but the same no-auth posture as
  // codex — the service talks through opencode's own background service, no login gate to probe.
  it("opencode probe spec floors the v2 line and skips the auth stage", () => {
    expect(AGENT_PROBES.opencode).toMatchObject({
      binary: "opencode",
      floor: "2.0.0",
      checkAuth: false,
    });
  });
  it("an opencode --version output above the floor classifies ready", () => {
    // `--version` prints "opencode v2.0.28" — bare-text form; parseSemver scans inside.
    const s = evaluateCliStatus({
      version: { status: "ok", raw: "opencode v2.0.28" },
      auth: { status: "unknown" },
      floor: "2.0.0",
      productPattern: /opencode/i,
      configDir: { active: "~/.config/opencode" },
      now: 0,
    });
    expect(s.kind).toBe("ready");
    expect(s.version).toBe("2.0.28");
  });
});
