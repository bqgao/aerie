import { describe, expect, it } from "vitest";
import {
  buildPaletteRows,
  scoreMatch,
  serverLampClass,
  PALETTE_ROW_CAP,
} from "../../src/renderer/src/shell/quick-palette-model";
import type { Session } from "@shared/types";
import type { ServerProfile } from "@shared/servers";
import type { EditorTab } from "../../src/renderer/src/shell/editor/editor-model";

/** Minimal session fixture — only the fields the palette reads. */
function session(partial: Partial<Session>): Session {
  return {
    id: "s",
    title: "",
    project: "",
    state: "ended",
    management: "managed",
    agent: "claude",
    resumable: true,
    model: "sonnet",
    contextPct: 0,
    contextWindow: 200000,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
    },
    createdMs: 0,
    lastActivityMs: 0,
    ...partial,
  };
}

function server(partial: Partial<ServerProfile>): ServerProfile {
  return {
    id: "srv",
    name: "",
    group: "",
    host: "",
    port: 22,
    username: "",
    authMode: "agent",
    createdAtMs: 0,
    ...partial,
  };
}

function tab(partial: Partial<EditorTab>): EditorTab {
  return {
    id: "tab",
    origin: { kind: "local", path: "/x/y.ts" },
    name: "",
    status: "ready",
    draft: "",
    snapshot: "",
    bytes: 0,
    capped: false,
    pdfUrl: null,
    mode: "edit",
    error: null,
    ...partial,
  };
}

describe("scoreMatch (B2 scorer)", () => {
  it("returns null for a blank query and a non-subsequence", () => {
    expect(scoreMatch("", "anything")).toBeNull();
    expect(scoreMatch("   ", "anything")).toBeNull();
    expect(scoreMatch("zz", "call")).toBeNull(); // no 'z'
  });

  it("case-folds both sides", () => {
    expect(scoreMatch("ABC", "aBcdef")).not.toBeNull();
    expect(scoreMatch("web", "Flask Web App")).not.toBeNull();
  });

  it("prefix outranks substring, which outranks scattered", () => {
    const prefix = scoreMatch("flas", "flask");
    const substring = scoreMatch("flas", "my flask app");
    const scattered = scoreMatch("flsq", "my flask quest");
    expect(prefix).not.toBeNull();
    expect(substring).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(prefix!).toBeGreaterThan(substring!);
    expect(substring!).toBeGreaterThan(scattered!);
  });

  it("rewards word boundaries over the same letters matched mid-word", () => {
    // Neither text contains the query contiguously; in one the second letter sits
    // after a word break, in the other mid-word.
    const boundary = scoreMatch("xz", "ax zebra");
    const midword = scoreMatch("xz", "examz");
    expect(boundary!).toBeGreaterThan(midword!);
  });

  it("rewards a consecutive run over the same letters spread out", () => {
    const run = scoreMatch("rd", "board");
    const spread = scoreMatch("rd", "roar down");
    expect(run!).toBeGreaterThan(spread!);
  });

  it("keeps a literal CJK query above a scattered latin match", () => {
    // 会话记录·推理 matches 推理 literally (the substring path), while "ra" only
    // scatters through a long latin title — the literal CJK hit must win.
    const cjk = scoreMatch("推理", "会话记录 推理申请书");
    const latin = scoreMatch("ra", "registry area integration report");
    expect(cjk!).toBeGreaterThan(latin!);
  });

  it("scores CJK via subsequence even when non-literal, in order only", () => {
    expect(scoreMatch("推书", "会话记录 推理申请书")).not.toBeNull();
    expect(scoreMatch("书推", "会话记录 推理申请书")).toBeNull();
  });

  it("matches astral-plane code points (emoji), not UTF-16 units", () => {
    expect(scoreMatch("🚀s", "Deploy 🚀 shipit")).not.toBeNull();
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(scoreMatch(" flas ", "flask")).toEqual(scoreMatch("flas", "flask"));
  });
});

describe("serverLampClass (ServerRailSection's hues, shared verbatim)", () => {
  it("maps the pool statuses onto the rail's lamp palette", () => {
    expect(serverLampClass("connected")).toContain("bg-working");
    expect(serverLampClass("connecting")).toContain("animate-pulse");
    expect(serverLampClass("error")).toContain("bg-danger");
    expect(serverLampClass("offline")).toContain("bg-ink-600");
  });
});

describe("buildPaletteRows (source aggregation)", () => {
  const sessions: Session[] = [
    session({
      id: "a",
      title: "fix crash",
      state: "working",
      repoRoot: "/home/web",
      repoLabel: "web",
      project: "web",
    }),
    session({ id: "b", title: "deploy pipeline" }),
    session({
      id: "c",
      title: "kafka consumer",
      repoRoot: "/home/kafka",
      repoLabel: "kafka",
      project: "kafka",
    }),
    session({
      id: "d",
      title: "kafka-producer",
      agent: "codex",
      repoRoot: "/home/kafka",
      repoLabel: "kafka",
      project: "kafka",
    }),
    session({
      id: "e",
      title: "kafka rebalancer",
      repoRoot: "/home/kafka",
      repoLabel: "kafka",
      project: "kafka",
    }),
  ];
  const servers: ServerProfile[] = [
    server({
      id: "srv1",
      name: "prod box",
      group: "ops",
      username: "bq",
      host: "prod.example",
    }),
    server({
      id: "srv2",
      name: "dev box",
      username: "bq",
      host: "dev.example",
    }),
  ];
  const tabs: EditorTab[] = [
    tab({ id: "local:/x/server.ts", name: "server.ts" }),
    tab({
      id: "local:/x/readme.md",
      name: "readme.md",
      draft: "typo fix",
      origin: { kind: "local", path: "/x/readme.md" },
    }),
  ];
  const base = {
    sessions,
    homeDir: "/home",
    servers,
    serverStatus: {},
    tabs,
  };

  it("blank query lists the recency defaults, grouped kind-first, per-kind capped", () => {
    const rows = buildPaletteRows({ ...base, query: "" });
    expect(rows.map((r) => r.source.kind)).toEqual([
      // 4 sessions (cap), 3 projects (cap), 2 servers (2 < cap), 2 tabs (2 < cap)
      "session",
      "session",
      "session",
      "session",
      "project",
      "project",
      "project",
      "server",
      "server",
      "tab",
      "tab",
    ]);
  });

  it("ranks matched sessions first within their kind block (cap is a ceiling, not a floor)", () => {
    const rows = buildPaletteRows({ ...base, query: "kafka" });
    const sessionRows = rows.filter((r) => r.source.kind === "session");
    // Only the 3 kafka-matching sessions match at all — no filler pad.
    expect(sessionRows).toHaveLength(3);
    // Equal alignment scores → stable input order inside the kind block.
    expect(sessionRows.map((r) => r.title)).toEqual([
      "kafka consumer",
      "kafka-producer",
      "kafka rebalancer",
    ]);
  });

  it("matches a session through its project-label half of the composite", () => {
    const rows = buildPaletteRows({
      ...base,
      query: "kafka",
      sessions: [sessions[2]],
    });
    expect(rows.some((r) => r.id === "session:c")).toBe(true);
  });

  it("groups duplicate-label projects apart only via the hint's own text", () => {
    const rows = buildPaletteRows({ ...base, query: "" });
    const projects = rows.filter((r) => r.source.kind === "project");
    // web / ungrouped / kafka — all three groups, the cap taking all of them.
    expect(projects.map((p) => p.title)).toEqual([
      "web",
      "(no project)",
      "kafka",
    ]);
  });

  it("carries the project row's most-recent session id and count badge", () => {
    const rows = buildPaletteRows({ ...base, query: "" });
    const kafka = rows.find(
      (r) => r.source.kind === "project" && r.title === "kafka",
    )!;
    expect(kafka.badge).toBe("3");
    expect(kafka.source.kind === "project" && kafka.source.sessionId).toBe("c");
  });

  it("carries server hints, group badges, and the tab dirty dot", () => {
    const rows = buildPaletteRows({ ...base, query: "" });
    const srv = rows.find((r) => r.id === "server:srv1")!;
    expect(srv.hint).toBe("bq@prod.example");
    expect(srv.badge).toBe("ops");
    const dirt = rows.find((r) => r.id === "tab:local:/x/readme.md")!;
    expect(dirt.dirty).toBe(true);
  });

  it("matches servers through name/group/host parts differently", () => {
    expect(
      buildPaletteRows({ ...base, query: "prod" }).map((r) => r.id),
    ).toContain("server:srv1");
    expect(
      buildPaletteRows({ ...base, query: "example" }).filter(
        (r) => r.source.kind === "server",
      ),
    ).toHaveLength(2);
  });

  it("scores tabs through name + path, non-matching tabs drop", () => {
    expect(
      buildPaletteRows({ ...base, query: "readme" }).map((r) => r.id),
    ).toEqual(["tab:local:/x/readme.md"]);
  });

  it("honors the total row cap across kinds", () => {
    const many: Session[] = Array.from({ length: 20 }, (_, i) =>
      session({ id: `m${i}`, title: `job ${i}` }),
    );
    const rows = buildPaletteRows({ ...base, sessions: many, query: "" });
    expect(rows.length).toBeLessThanOrEqual(PALETTE_ROW_CAP);
  });
});
