import { describe, it, expect } from "vitest";
import {
  namespacedId,
  parseNamespacedId,
} from "../../src/main/provider/opencode/namespace";
import {
  buildSpawnCommand,
  buildResumeCommand,
} from "../../src/main/terminal/command";
import { newSessionId } from "../../src/shared/terminal";
import type { ServerProfile } from "../../src/shared/servers";
import { createOpenCodeProvider } from "../../src/main/provider/opencode";
import { fromTranscriptWire } from "../../src/shared/transcript";

export const profile: ServerProfile = {
  id: "srv-A",
  name: "remote-a",
  group: "prod",
  host: "a.home",
  port: 22,
  username: "deploy",
  authMode: "password",
  createdAtMs: 0,
  opencode: { servePort: 4096, autoTunnel: true },
};

describe("namespace round-trip", () => {
  it("an app id carries server + raw halves; bare ids are local", () => {
    const ns = namespacedId("srv-A", "ses_XXX");
    expect(ns).toBe("srv-A:ses_XXX");
    expect(parseNamespacedId(ns)).toEqual({
      serverId: "srv-A",
      raw: "ses_XXX",
    });
    expect(parseNamespacedId("ses_XXX")).toBeNull();
    expect(
      parseNamespacedId("00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
    // Degenerate shapes count as local — never a crash.
    expect(parseNamespacedId(":")).toBeNull();
    expect(parseNamespacedId(":tail")).toBeNull();
  });

  it("minting under a server namespace keeps the ses_ shape after the prefix", () => {
    const id = newSessionId("opencode", "srv-A");
    expect(id).toMatch(/^srv-A:ses_[A-Za-z0-9]{24}$/);
    expect(parseNamespacedId(id)).toEqual({
      serverId: "srv-A",
      raw: expect.stringMatching(/^ses_[A-Za-z0-9]{24}$/),
    });
    expect(newSessionId("opencode")).toMatch(/^ses_[A-Za-z0-9]{24}$/);
  });
});

describe("remote spawn/resume command shapes", () => {
  it("spawn pins --server base in front of the RAW session pin; local spawn unchanged", () => {
    expect(
      buildSpawnCommand({
        agent: "opencode",
        id: "ses_RAW",
        model: "default",
        remoteUrl: "http://127.0.0.1:4100",
      }),
    ).toEqual({
      file: "opencode",
      args: ["--server", "http://127.0.0.1:4100", "--session", "ses_RAW"],
    });
    expect(
      buildSpawnCommand({ agent: "opencode", id: "ses_RAW", model: "default" }),
    ).toEqual({ file: "opencode", args: ["--session", "ses_RAW"] });
    // The remote shape carries no OPENCODE_-prefixed token in argv — env is a separate channel.
    expect(
      buildSpawnCommand({
        agent: "opencode",
        id: "s",
        model: "default",
        remoteUrl: "http://h:1",
      }).args.some((a) => a.startsWith("OPENCODE_")),
    ).toBe(false);
  });

  it("resume: identical --server + --session shape", () => {
    expect(
      buildResumeCommand({
        agent: "opencode",
        id: "ses_RAW",
        remoteUrl: "http://127.0.0.1:4100",
      }),
    ).toEqual({
      file: "opencode",
      args: ["--server", "http://127.0.0.1:4100", "--session", "ses_RAW"],
    });
    expect(buildResumeCommand({ agent: "opencode", id: "ses_RAW" })).toEqual({
      file: "opencode",
      args: ["--session", "ses_RAW"],
    });
  });
});

/** Canned remote rows (redacted live shapes from pass 1's fixtures): a good row, a parentID lane
 *  that must be skipped, and an `outcome: "failed"` row that must be tolerated. */
const remoteRows = [
  {
    id: "ses_good",
    title: "remote one",
    model: { id: "GLM", providerID: "nanhu" },
    cost: 0.25,
    tokens: {
      input: 10,
      output: 2,
      reasoning: 0,
      cache: { read: 3, write: 0 },
    },
    time: { created: 900, updated: 1_000 },
    location: { directory: "/srv/there" },
  },
  {
    id: "ses_lane",
    parentID: "ses_good",
    time: { created: 900, updated: 1_100 },
    location: { directory: "/srv/there" },
  },
  {
    id: "ses_failed",
    outcome: "failed",
    time: { created: 900, updated: 1_200 },
    location: { directory: "/srv/there" },
  },
  {
    id: "ses_msgs",
    title: "transcript source",
    tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 800, updated: 1_300 },
    location: { directory: "/srv/there" },
  },
];

function makeProvider(sources: Array<{ serverId: string; baseUrl: string }>) {
  const requests: string[] = [];
  // A sync responder lifted to the fetch seam's Promise type — an await-free async
  // trips require-await. Its throws stay sync: every caller site sits inside try/catch.
  const respond = (url: string): Response => {
    requests.push(url);
    const source = sources.find((s) => url.startsWith(s.baseUrl));
    if (!source || source.serverId === "srv-B") throw new Error("ECONNREFUSED"); // unreachable source leg
    if (url.includes("/api/session/active"))
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    if (url.includes("/api/session?"))
      return new Response(JSON.stringify({ data: remoteRows, cursor: null }), {
        status: 200,
      });
    if (url.includes("/message"))
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "msg_1",
              type: "user",
              time: { created: 500 },
              content: [{ type: "text", text: "remote prompt" }],
            },
            {
              id: "msg_2",
              type: "assistant",
              time: { created: 600, completed: 700 },
              content: [{ type: "text", text: "remote answer" }],
            },
          ],
          cursor: null,
        }),
        { status: 200 },
      );
    return new Response("{}", { status: 200 });
  };
  const p = createOpenCodeProvider({
    // Local service inert (null endpoint) — only the remote arms speak.
    service: { resolve: () => null, invalidate: () => {} } as never,
    fetchFn: (url: string): Promise<Response> => Promise.resolve(respond(url)),
    now: () => 1_500,
    remote: {
      homeDir: "/home/deploy",
      sources: () =>
        Promise.resolve(
          sources.map((s) => ({
            serverId: s.serverId,
            baseUrl: s.baseUrl,
            password: "pw",
          })),
        ),
    },
  });
  return { p, requests };
}

describe("multi-source provider", () => {
  it("merges remote rows as namespaced candidates; parentID lanes skipped, failed outcome tolerated", async () => {
    const { p } = makeProvider([
      { serverId: "srv-A", baseUrl: "http://x" },
      { serverId: "srv-B", baseUrl: "http://b-up" },
    ]);
    const cands = await p.listCandidates();
    const ids = cands.map((c) => c.id).sort();
    expect(ids).toEqual([
      "srv-A:ses_failed", // outcome failed — still a session row
      "srv-A:ses_good",
      "srv-A:ses_msgs",
      // srv-B unreachable → contributes nothing; its failure doesn't sink the sweep.
    ]);
    const good = cands.find((c) => c.id === "srv-A:ses_good");
    expect(good).toMatchObject({
      agent: "opencode",
      cwd: "/srv/there",
      status: "busy", // updated=1000 vs now=1500 → inside the 10s working window
    });
    expect(good?.alive).toBe(true);
  });

  it("routes per-source reads: transcript walks messages with the RAW id", async () => {
    const { p, requests } = makeProvider([
      { serverId: "srv-A", baseUrl: "http://x" },
    ]);
    await p.listCandidates();
    const read = fromTranscriptWire(
      await p.readTranscript("srv-A:ses_good", 999), // stale token → changed path
    );
    if (read.status !== "changed") throw new Error(`got ${read.status}`);
    expect(read.doc.events).toEqual([
      { kind: "user", text: "remote prompt" },
      { kind: "assistant", text: "remote answer" },
    ]);
    expect(requests.some((r) => r.includes("ses_good/message"))).toBe(true);
    // The RAW id rode the wire (never the app-level namespace).
    expect(requests.some((r) => r.includes("srv-A%3A"))).toBe(false);
  });

  it("remote readMetrics carries no git/pr (server-side paths local git cannot see)", async () => {
    const { p } = makeProvider([{ serverId: "srv-A", baseUrl: "http://x" }]);
    await p.listCandidates();
    const m = await p.readMetrics("srv-A:ses_good");
    if (m.status !== "changed") throw new Error(`got ${m.status}`);
    expect(m.metrics.git).toBeNull();
    expect(m.metrics.pr).toBeNull();
    expect(m.metrics.voiceEnabled).toBeNull();
  });

  it("an unreachable source: reads settle absent (candidate path already skipped it)", async () => {
    const { p } = makeProvider([{ serverId: "srv-B", baseUrl: "http://b-up" }]);
    await p.listCandidates();
    expect(await p.readTranscript("srv-B:ses_good")).toEqual({
      status: "absent",
    });
  });

  it("resolveResumeTarget for a remote id returns HOME (never a remote path) once the server was swept", async () => {
    const { p } = makeProvider([{ serverId: "srv-A", baseUrl: "http://x" }]);
    await p.listCandidates();
    expect(p.resolveResumeTarget("srv-A:ses_good")).toEqual({
      alive: true,
      cwd: "/home/deploy",
    });
    // Unknown server → null (never resolvable as a local cwd).
    expect(p.resolveResumeTarget("srv-Z:ses_x")).toBeNull();
  });
});
