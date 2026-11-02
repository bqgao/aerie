import { describe, it, expect } from "vitest";
import {
  createOpenCodeProvider,
  OPENCODE_FORK_UNAVAILABLE,
} from "../../src/main/provider/opencode";
import type { OpencodeSessionRow } from "../../src/main/provider/opencode/client";
import { fromTranscriptWire } from "../../src/shared/transcript";
import sessions from "../fixtures/opencode/sessions.json";
import messages from "../fixtures/opencode/messages.json";

/** The redacted live-shape fixtures (tests/fixtures/opencode) as the typed rows the client
 *  produces — one cast at the seams; the shapes below the cast are defended in the client. */
const rows = sessions.data as OpencodeSessionRow[];
const msgRows = messages.data as unknown[];

const ROOT = rows.find((r) => r.id === "ses_e791abb58ffeIDGs2u7KpqxUtv")!;

/** An offline fake service: answers with the given endpoint (null = no service) and counts
 *  resolves/invalidates so tests can see discovery behavior directly. */
function fakeService(
  endpoint: { baseUrl: string; password: string | null } | null,
) {
  return {
    resolves: 0,
    invalidates: 0,
    resolve: () => {
      fakeServiceCounter.resolves++;
      return Promise.resolve(endpoint);
    },
    invalidate: () => {
      fakeServiceCounter.invalidates++;
    },
  };
}
const fakeServiceCounter = { resolves: 0, invalidates: 0 };

/** A canned fetchFn: routes by path, tracks requests. */
function fakeFetch(routes: {
  session?: unknown;
  active?: unknown;
  messages?: unknown;
  /** Each fetch leg fails on its own side (connect failure). */
  refuse?: boolean;
  failMessages?: boolean;
}) {
  const requests: string[] = [];
  const fetchFn = (url: string): Promise<Response> => {
    requests.push(url);
    if (routes.refuse) return Promise.reject(new Error("ECONNREFUSED"));
    const path = url;
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200 });
    if (path.includes("/api/session/active")) {
      return Promise.resolve(json(routes.active));
    }
    if (path.includes("/message")) {
      if (routes.failMessages) return Promise.reject(new Error("ECONNREFUSED"));
      return Promise.resolve(json(routes.messages));
    }
    if (path.includes("/api/session")) {
      return Promise.resolve(json(routes.session));
    }
    return Promise.resolve(new Response("no route", { status: 404 }));
  };
  return { fetchFn, requests };
}

const BASE = { baseUrl: "http://127.0.0.1:49374", password: "pw" };

function makeProvider(opts: {
  session?: unknown;
  active?: unknown;
  messages?: unknown;
  refuse?: boolean;
  failMessages?: boolean;
  noService?: boolean;
  now?: () => number;
  recentWindowMs?: number;
  managed?: {
    has(id: string): boolean;
    cwdOf?(id: string): string | undefined;
  };
}) {
  const service = fakeService(opts.noService ? null : BASE);
  fakeServiceCounter.resolves = 0;
  fakeServiceCounter.invalidates = 0;
  const { fetchFn, requests } = fakeFetch({
    session: opts.session,
    active: opts.active,
    messages: opts.messages,
    refuse: opts.refuse,
    failMessages: opts.failMessages,
  });
  const p = createOpenCodeProvider({
    service,
    fetchFn,
    now: opts.now,
    recentWindowMs: opts.recentWindowMs,
    managed: opts.managed,
  });
  return { p, service, requests };
}

describe("createOpenCodeProvider", () => {
  it("is inert with no service: empty candidates, absent reads", async () => {
    const { p } = makeProvider({ noService: true });
    expect(await p.listCandidates()).toEqual([]);
    expect(await p.readTranscript("ses_x")).toEqual({ status: "absent" });
    expect(p.resolveSessionCwd("ses_x")).toBeNull();
    expect(p.resolveTranscriptPath("ses_x")).toBeNull();
  });

  it("maps a session row to a candidate: agent/id/cwd/freshness, token = time.updated", async () => {
    const nowMs = (ROOT.time?.updated ?? 0) + 5_000; // inside the 10s working window
    const { p } = makeProvider({
      session: { data: [ROOT], cursor: null },
      active: { data: {} },
      now: () => nowMs,
    });
    const [c] = await p.listCandidates();
    expect(c).toMatchObject({
      id: ROOT.id,
      agent: "opencode",
      cwd: "/Users/bqgao",
      status: "busy",
      alive: true,
    });
    // No codex-style relationship markers: opencode rows are flat sessions (child lanes skipped).
    expect(c.threadKind).toBeUndefined();
    expect(c.parentSessionId).toBeUndefined();
    expect(c.transcriptMtimeMs).toBe(ROOT.time?.updated);
    expect(c.transcriptPath).toBeUndefined();
  });

  it("stale rows are not alive (ended); /active membership overrides staleness", async () => {
    const staleUpdated = ROOT.time?.updated ?? 0;
    const nowMs = staleUpdated + 60_000 - 90;
    const { p } = makeProvider({
      session: { data: [ROOT], cursor: null },
      active: { data: { [ROOT.id]: { type: "running" } } },
      now: () => nowMs,
    });
    let [c] = await p.listCandidates();
    expect(c.alive).toBe(true);
    expect(c.status).toBeUndefined();

    const { p: p2 } = makeProvider({
      session: { data: [ROOT], cursor: null },
      active: { data: {} },
      now: () => nowMs,
    });
    [c] = await p2.listCandidates();
    expect(c.alive).toBe(false);
    expect((await p2.summarize(c)).state).toBe("ended");
  });

  it("skips parentID (subagent-lane) rows and stale rows outside the recent window", async () => {
    const child = { ...ROOT, id: "ses_child1", parentID: ROOT.id };
    const old = {
      ...ROOT,
      id: "ses_old",
      time: { created: 1793264534706, updated: 1000 }, // epoch 1s — ancient by construction
    };
    const nowMs = (ROOT.time?.updated ?? 0) + 1_000;
    const { p } = makeProvider({
      session: { data: [child, old, ROOT], cursor: null },
      active: { data: {} },
      now: () => nowMs,
      recentWindowMs: 30 * 24 * 60 * 60 * 1000,
    });
    const cands = await p.listCandidates();
    expect(cands.map((x) => x.id)).toEqual([ROOT.id]);
    // A managed id always surfaces, however stale.
    const { p: withManaged } = makeProvider({
      session: { data: [old], cursor: null },
      active: { data: {} },
      now: () => nowMs,
      managed: { has: (id) => id === "ses_old" },
    });
    expect((await withManaged.listCandidates()).map((x) => x.id)).toEqual([
      "ses_old",
    ]);
  });

  it("summarize carries title/cwd/usage/model from the row; restate re-derives state", async () => {
    const nowMs = (ROOT.time?.updated ?? 0) + 1_000;
    const { p } = makeProvider({
      session: { data: [ROOT], cursor: null },
      active: { data: {} },
      now: () => nowMs,
    });
    const cands = await p.listCandidates();
    const s = await p.summarize(cands[0]);
    expect(s.agent).toBe("opencode");
    expect(s.cwd).toBe(ROOT.location?.directory ?? "");
    expect(s.modelRaw).toBe(`${ROOT.model?.providerID}/${ROOT.model?.id}`);
    expect(s.title.length).toBeGreaterThan(0);
    // OpenCode's reasoning count is generated output — it folds into outputTokens (usage.ts).
    expect(s.usage.inputTokens).toBe(ROOT.tokens?.input);
    expect(s.usage.outputTokens).toBe(
      (ROOT.tokens?.output ?? 0) + (ROOT.tokens?.reasoning ?? 0),
    );
    expect(s.usage.cacheReadTokens).toBe(ROOT.tokens?.cache?.read);
    expect(s.usage.cacheCreationTokens).toBe(ROOT.tokens?.cache?.write);
    expect(s.usageByModel).toEqual([]);
    expect(s.lastActivityMs).toBe(ROOT.time?.updated);
    expect(s.createdMs).toBe(ROOT.time?.created);

    // restate: state rides the candidate's liveness, management re-checks the registry.
    const prev = await p.summarize(cands[0]);
    const staleCand = { ...cands[0], alive: false };
    expect(p.restate(staleCand, prev)).toMatchObject({
      state: "ended",
      management: "observed",
    });
  });

  it("readTranscript honors the row token: unchanged without a refetch, changed otherwise", async () => {
    const { p } = makeProvider({
      session: { data: [ROOT], cursor: null },
      active: { data: {} },
      messages: { data: msgRows, cursor: null },
      now: () => (ROOT.time?.updated ?? 0) + 1_000,
    });
    // Warm the row cache with a sweep, then read.
    await p.listCandidates();
    const unchanged = await p.readTranscript(ROOT.id, ROOT.time?.updated);
    expect(unchanged).toEqual({
      status: "unchanged",
      mtimeMs: ROOT.time?.updated,
    });
    const first = fromTranscriptWire(await p.readTranscript(ROOT.id));
    if (first.status !== "changed")
      throw new Error(`expected changed, got ${first.status}`);
    expect(first.mtimeMs).toBe(ROOT.time?.updated);
    expect(first.doc.events.length).toBeGreaterThan(0);
    expect(first.doc.subagents).toEqual([]);
    // Second read with the SAME token → unchanged (no re-fetch happened: the fixture would have
    // served changed again).
    expect(await p.readTranscript(ROOT.id, first.mtimeMs)).toEqual({
      status: "unchanged",
      mtimeMs: first.mtimeMs,
    });
  });

  it("readTranscript settles absent for an unknown id and error when messages fail", async () => {
    const { p } = makeProvider({
      session: { data: [ROOT], cursor: null },
      active: { data: {} },
      failMessages: true,
      now: () => (ROOT.time?.updated ?? 0) + 1_000,
    });
    // Unknown id → absent (never an error: a deleted session must empty out).
    expect(await p.readTranscript("ses_unknown")).toEqual({ status: "absent" });
    // A session whose message leg fails re-discovers (client retry), then settles error — the
    // transient contract (keep the last doc, retry).
    expect(await p.readTranscript(ROOT.id, 12345)).toEqual({ status: "error" });
    // The invalidation hook fired on the failing leg (the re-discovery trigger).
    expect(fakeServiceCounter.invalidates).toBeGreaterThan(0);
  });

  it("overlaySessions attaches the row's cost to opencode rows only", async () => {
    const { p } = makeProvider({
      session: { data: [ROOT], cursor: null },
      active: { data: {} },
      now: () => (ROOT.time?.updated ?? 0) + 1_000,
    });
    await p.listCandidates();
    const oc = { id: ROOT.id, agent: "opencode", costUsd: undefined } as never;
    const other = { id: "x", agent: "claude", costUsd: 99 } as never;
    const [ocOut, otherOut] = p.overlaySessions([oc, other]);
    expect((ocOut as unknown as Record<string, unknown>).costUsd).toBe(
      ROOT.cost,
    );
    expect(otherOut).toBe(other);
  });

  it("readMetrics: changed snapshot with the composite token, unchanged on repeat, absent unknown", async () => {
    const { p } = makeProvider({
      session: { data: [ROOT], cursor: null },
      active: { data: {} },
      messages: { data: msgRows, cursor: null },
      now: () => (ROOT.time?.updated ?? 0) + 1_000,
    });
    await p.listCandidates();
    // The fixture cwd isn't a repo → git/pr null; two assistant messages → speed may synthesize.
    const first = await p.readMetrics(ROOT.id);
    expect(first.status).toBe("changed");
    if (first.status !== "changed") return;
    expect(first.metrics.git).toBeNull();
    expect(first.metrics.voiceEnabled).toBeNull();
    expect(first.metrics.remoteControl).toBeNull();
    // The same token echoed back → unchanged (no message refetch).
    expect(await p.readMetrics(ROOT.id, first.mtimeMs)).toEqual({
      status: "unchanged",
      mtimeMs: first.mtimeMs,
    });
    expect(await p.readMetrics("ses_unknown")).toEqual({ status: "absent" });
  });

  it("a connection failure without a service is inert, and unimplemented arms settle absent", async () => {
    const { p } = makeProvider({ refuse: true, noService: true });
    expect(await p.listCandidates()).toEqual([]);
    expect(await p.readTasks("ses_x")).toEqual({ status: "absent" });
    expect(await p.readShells("ses_x")).toEqual({ status: "absent" });
    expect(await p.readMonitors("ses_x")).toEqual({ status: "absent" });
    expect(await p.readSubagentTranscript("ses_x", "a")).toEqual({
      status: "absent",
    });
    expect(await p.readShellOutput("ses_x", "s")).toEqual({ status: "absent" });
    expect(await p.readMonitorOutput("ses_x", "m")).toEqual({
      status: "absent",
    });
  });
});

describe("opencode waiting signals (tier-1 Run 2 / A5)", () => {
  // Stale relative to the 10s working window: the only shape the waiting probe decides for.
  const STALE_NOW = (ROOT.time?.updated ?? 0) + 60_000;
  const FRESH_NOW = (ROOT.time?.updated ?? 0) + 5_000;
  const managed = { has: () => true };

  it("a managed session past its freshness window whose last message is the assistant waits", async () => {
    const { p } = makeProvider({
      session: { data: [ROOT], cursor: null },
      active: { data: {} },
      messages: { data: [{ id: "m2", type: "assistant" }], cursor: null },
      now: () => STALE_NOW,
      managed,
    });
    const [c] = await p.listCandidates();
    expect(c.alive).toBe(true);
    expect(c.status).toBe("waiting");
    const s = await p.summarize(c);
    expect(s.state).toBe("waiting");
    expect(s.awaitingUser).toBe(true);
    expect(s.waitingReason).toBe("Turn complete");
  });

  it("a row the active map still owns is never waiting — /active wins over the tail", async () => {
    // Per the spec, WAITING requires NOT being in /active; an active-owned stale row (the app's
    // pre-existing alive-but-not-fresh shape) stays exactly what it was: alive, idle.
    const { p } = probeProvider(STALE_NOW, {
      last: [{ id: "m2", type: "assistant" }],
      activeOwning: true,
    });
    const [c] = await p.listCandidates();
    expect(c.alive).toBe(true);
    expect(c.status).toBeUndefined();
    const s = await p.summarize(c);
    expect(s.state).toBe("idle");
    expect(s.waitingReason).toBeUndefined();
  });

  it("a freshness-held row stays busy and is never probed", async () => {
    const { p, requests } = probeProvider(FRESH_NOW, {
      last: [{ id: "m2", type: "assistant" }],
    });
    const [c] = await p.listCandidates();
    expect(c.status).toBe("busy");
    expect(messageRequests(requests)).toHaveLength(0);
  });

  it("last message from the user means the ball is with the agent, not the user", async () => {
    const { p } = probeProvider(STALE_NOW, {
      last: [{ id: "m1", type: "user" }],
    });
    const [c] = await p.listCandidates();
    expect(c.status).toBeUndefined();
    const s = await p.summarize(c);
    expect(s.state).toBe("idle");
    expect(s.waitingReason).toBeUndefined();
  });

  it("a failed probe degrades to not-waiting and is retried on the next pass", async () => {
    const { p, requests } = probeProvider(STALE_NOW, {
      last: [],
      failMessages: true,
    });
    const [c] = await p.listCandidates();
    expect(c.status).toBeUndefined();
    // Not cached: the next pass re-probes.
    await p.listCandidates();
    expect(messageRequests(requests)).toHaveLength(2);
  });

  it("probes each row version once — the cache rides the row's change token", async () => {
    const { p, requests } = probeProvider(STALE_NOW, {
      last: [{ id: "m2", type: "assistant" }],
    });
    await p.listCandidates();
    await p.listCandidates();
    expect(messageRequests(requests)).toHaveLength(1);
    // An unchanged row keeps its waiting signal for free on the cached pass.
    const [c] = await p.listCandidates();
    expect(c.status).toBe("waiting");
  });

  it("unmanaged rows never wait — a gone process is ended, as before", async () => {
    const { p, requests } = probeProvider(STALE_NOW, {
      last: [{ id: "m2", type: "assistant" }],
      managed: false,
    });
    const [c] = await p.listCandidates();
    expect(c.alive).toBe(false);
    expect(c.status).toBeUndefined();
    expect(messageRequests(requests)).toHaveLength(0);
  });

  it("restate derives waiting from the candidate's carried status and keeps the reason", async () => {
    const { p } = probeProvider(STALE_NOW, {
      last: [{ id: "m2", type: "assistant" }],
    });
    const [c] = await p.listCandidates();
    const snap = await p.summarize(c);
    const restated = p.restate(c, snap);
    expect(restated.state).toBe("waiting");
    expect(restated.waitingReason).toBe("Turn complete");
  });
});
/** The waiting-probe tests' tighter harness: same single row, explicit last-message list, and
 *  the raw request log so the tests can count probes. */
function probeProvider(
  nowMs: number,
  opts: {
    last: unknown[];
    failMessages?: boolean;
    managed?: boolean;
    activeOwning?: boolean;
  },
) {
  const { p, requests } = makeProvider({
    session: { data: [ROOT], cursor: null },
    active: {
      data: opts.activeOwning ? { [ROOT.id]: { type: "running" } } : {},
    },
    messages: { data: opts.last, cursor: null },
    refuse: false,
    failMessages: opts.failMessages,
    now: () => nowMs,
    managed: { has: () => opts.managed ?? true },
  });
  return { p, requests };
}

function messageRequests(requests: string[]): string[] {
  return requests.filter(
    (url) => url.includes("/api/session/") && url.includes("/message"),
  );
}

describe("opencode prompt op (tier-1 Run 2 / A4)", () => {
  it("POSTs the text envelope and succeeds on the verified contract", async () => {
    const service = fakeService(BASE);
    const requests: string[] = [];
    let postBody: string | undefined;
    const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (typeof init?.body === "string") postBody = init.body;
      if (url.includes("/prompt"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "msg_u1",
                sessionID: ROOT.id,
                time: 1,
                type: "user",
                payload: { text: "ship it" },
              },
            }),
            { status: 200 },
          ),
        );
      return Promise.resolve(
        new Response(JSON.stringify({ data: [ROOT], cursor: null }), {
          status: 400,
        }),
      );
    };
    const p = createOpenCodeProvider({ service, fetchFn, now: () => 1 });
    const r = await p.promptSession(ROOT.id, "ship it");
    expect(r.ok).toBe(true);
    expect(postBody).toBe(JSON.stringify({ text: "ship it" }));
    expect(
      requests.some((x) => x.endsWith(`/api/session/${ROOT.id}/prompt`)),
    ).toBe(true);
  });

  it("a 400 → ok:false carrying the service's own reason (the queue keeps the prompt)", async () => {
    const service = fakeService(BASE);
    const fetchFn = (url: string): Promise<Response> =>
      url.includes("/prompt")
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                _tag: "InvalidRequestError",
                message: "reason text",
              }),
              { status: 400 },
            ),
          )
        : Promise.resolve(new Response("{}", { status: 200 }));
    const p = createOpenCodeProvider({ service, fetchFn, now: () => 1 });
    const r = await p.promptSession(ROOT.id, "ship it");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("reason text");
  });

  it("an unreachable service degrades to ok:false — never a rejection", async () => {
    const service = fakeService(null);
    const p = createOpenCodeProvider({
      service,
      fetchFn: () => Promise.resolve(new Response("", { status: 200 })),
      now: () => 1,
    });
    const r = await p.promptSession(ROOT.id, "ship it");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});

describe("opencode fork op (tier-1 Run 2 / A3)", () => {
  const FORK_ROW = {
    id: "ses_newfork",
    title: "Fork of checkout",
    location: { directory: "/Users/bqgao/work" },
    model: { id: "GLM-5.3", providerID: "nanhu" },
    tokens: { input: 5, output: 6 },
    time: { created: 1000, updated: 2000 },
    fork: {
      sessionID: "ses_source",
      boundary: { type: "through", messageID: "msg_boundary" },
    },
  };

  function forkProvider(opts: {
    now?: () => number;
    refuse?: boolean;
    forkStatus?: number;
    badBody?: boolean;
  }) {
    const service = fakeService(BASE);
    fakeServiceCounter.resolves = 0;
    const requests: string[] = [];
    let method: string | undefined;
    let body: string | undefined;
    const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") method = init.method;
      if (typeof init?.body === "string") body = init.body;
      if (opts.refuse) return Promise.reject(new Error("ECONNREFUSED"));
      if (url.includes("/fork")) {
        if (opts.forkStatus)
          return Promise.resolve(
            new Response("nope", { status: opts.forkStatus }),
          );
        if (opts.badBody)
          return Promise.resolve(new Response("<html>", { status: 200 }));
        return Promise.resolve(
          new Response(JSON.stringify({ data: FORK_ROW }), { status: 200 }),
        );
      }
      // Everything before the fork (the sweep/active/headers) doesn't matter to these tests.
      return Promise.resolve(
        new Response(JSON.stringify({ data: [ROOT], cursor: null }), {
          status: 200,
        }),
      );
    };
    const p = createOpenCodeProvider({
      service,
      fetchFn,
      now: opts.now ?? (() => (ROOT.time?.updated ?? 0) + 60_000),
      managed: { has: () => true },
    });
    return { p, requests, method: () => method, body: () => body };
  }

  it("POSTs an empty body to /api/session/:id/fork and drafts from the response row", async () => {
    const { p, requests, method, body } = forkProvider({});
    const r = await p.forkSession(ROOT.id);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.session) return; // narrowing
    expect(method()).toBe("POST");
    expect(body()).toBe("{}");
    expect(requests.some((x) => x.endsWith(`/fork`))).toBe(true);
    // The draft carries the service's own values, not the source session's.
    expect(r.session).toMatchObject({
      id: FORK_ROW.id,
      title: "Fork of checkout",
      agent: "opencode",
      management: "observed",
      state: "idle",
      cwd: "/Users/bqgao/work",
      forkSourceId: "ses_source",
      modelRaw: "nanhu/GLM-5.3",
    });
  });

  it("forks through the id's own remote source for namespaced ids", async () => {
    const service = fakeService(BASE);
    const remoteSources = [
      { serverId: "srv-1", baseUrl: "http://127.0.0.1:45678", password: "p2" },
    ];
    const requests: string[] = [];
    const fetchFn = (url: string): Promise<Response> => {
      requests.push(url);
      if (url.includes("/fork"))
        return Promise.resolve(
          new Response(JSON.stringify({ data: FORK_ROW }), { status: 200 }),
        );
      return Promise.resolve(
        new Response(JSON.stringify({ data: [ROOT], cursor: null }), {
          status: 200,
        }),
      );
    };
    const p = createOpenCodeProvider({
      service,
      fetchFn,
      now: () => (ROOT.time?.updated ?? 0) + 60_000,
      managed: { has: () => true },
      remote: {
        sources: () => Promise.resolve(remoteSources),
        homeDir: "/home/remote",
      },
    });
    await p.listCandidates(); // sweep fills remoteState with srv-1's source
    const r = await p.forkSession(`srv-1:${ROOT.id}`);
    expect(r.ok).toBe(true);
    expect(
      requests.some(
        (u) => u.startsWith("http://127.0.0.1:45678") && u.endsWith("/fork"),
      ),
    ).toBe(true);
  });

  it("a refused fork degrades in band — ok:false with a display reason", async () => {
    const { p } = forkProvider({ forkStatus: 500 });
    const r = await p.forkSession(ROOT.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it("no service at all → the same in-band failure, never a throw", async () => {
    const service = fakeService(null);
    const p = createOpenCodeProvider({
      service,
      fetchFn: () => Promise.resolve(new Response("", { status: 200 })),
      now: () => 0,
    });
    const r = await p.forkSession(ROOT.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(OPENCODE_FORK_UNAVAILABLE);
  });
});
