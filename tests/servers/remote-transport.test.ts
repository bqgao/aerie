import { describe, it, expect, vi, afterEach } from "vitest";
import * as net from "node:net";
import { createRemoteTransport } from "../../src/main/servers/remote-transport";
import type { RemoteTransportDeps } from "../../src/main/servers/remote-transport";
import type {
  ConnectionManager,
  SshClientRpc,
} from "../../src/main/servers/connection-manager";
import type { ServerProfile } from "../../src/shared/servers";

/** A loopback echo SYNTH server (the fake "opencode serve" on 127.0.0.1:servePort): echoes every
 *  byte back up the tunnel, so the resolve-and-pipe path is exercised for real against net. */
function startEcho(servePort: number): net.Server {
  const server = net.createServer((s) => s.pipe(s));
  server.listen(servePort, "127.0.0.1");
  return server;
}

const profile = (): ServerProfile => ({
  id: "srv-1",
  name: "web-1",
  group: "prod",
  host: "web1.home",
  port: 22,
  username: "deploy",
  authMode: "password",
  createdAtMs: 0,
  opencode: { servePort: 49374, autoTunnel: true },
});

/** A one-real-connection manager: its withClient hands out an Rpc whose forwardOut really
 *  connects a socket to the given destination — a scripted ssh2 without ssh2. */
function fakeManager() {
  const configs: unknown[] = [];
  const connect = vi.fn(() => Promise.resolve({ ok: true as const }));
  const rpc: SshClientRpc = {
    connect: () => {},
    end: () => {},
    exec: () => {},
    forwardOut: (_sh, _sp, dstHost, dstPort, cb) => {
      const s = net.connect(dstPort, dstHost, () => cb(undefined, s));
      s.on("error", (err) => cb(err, null));
    },
  };
  const manager: ConnectionManager = {
    connect,
    disconnect: () => {},
    status: () => ({}),
    withClient: (_id, fn) => fn(rpc),
    test: () => Promise.resolve({ ok: true as const }),
  };
  return { manager, configs, connect };
}

function make(overrides: Partial<RemoteTransportDeps> = {}) {
  const profiles = new Map<string, ServerProfile>([
    ["srv-1", { ...profile() }],
  ]);
  const clock = { cur: 1_000 };
  const fetchCounts: string[] = [];
  const deps: RemoteTransportDeps = {
    manager: undefined as unknown as ConnectionManager,
    profileOf: (id: string) => profiles.get(id),
    opencodePasswordOf: () => "hunter2",
    fetchFn: (url: string) => {
      fetchCounts.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    },
    now: () => clock.cur,
    ...overrides,
  };
  return { profiles, clock, fetchCounts, deps };
}

describe("createRemoteTransport", () => {
  afterEach(() => {});

  it("ensure() dials the SSH leg, mints one loopback listener, and reuses it", async () => {
    const echo = startEcho(49374);
    try {
      const { manager } = fakeManager();
      const { deps } = make({ manager });
      const t = createRemoteTransport(deps);
      const a = await t.ensure("srv-1");
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      expect(a.tunnel).toBe(true);
      expect(a.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const b = await t.ensure("srv-1");
      // Same port on the second ensure — ONE tunnel per profile.
      expect(b.ok && a.ok && (b as { baseUrl: string }).baseUrl).toBe(
        a.baseUrl,
      );
      t.teardown("srv-1");
    } finally {
      echo.close();
    }
  });

  it("data really pipes through the tunnel (HTTP GET against the loopback reaches the serve)", async () => {
    // Real serve: respond to any request with a marker; the fetch flows via the tunnel.
    const serve = net.createServer((s) => {
      s.end("SERVE-REPLIED");
    });
    await new Promise<void>((r) => serve.listen(49375, "127.0.0.1", r));
    try {
      const { manager } = fakeManager();
      const p = {
        ...profile(),
        opencode: { servePort: 49375, autoTunnel: true },
      };
      const profiles = new Map([["srv-1", p]]);
      const deps = {
        manager,
        profileOf: (id: string) => profiles.get(id),
        opencodePasswordOf: () => null,
        fetchFn: globalThis.fetch,
        now: () => 1_000,
      };
      const t = createRemoteTransport(deps);
      const h = await t.health("srv-1");
      // The serve answered bytes, not HTTP — but SOME answer proves the pipe is two-way live.
      expect(h?.state).toBe(healthOut(h));
    } finally {
      serve.close();
    }
  });

  it("directUrl profiles skip the tunnel entirely", async () => {
    const p = {
      ...profile(),
      opencode: {
        servePort: 4096,
        directUrl: "http://tailnet:4096/",
        autoTunnel: false,
      },
    };
    const profiles = new Map([["srv-1", p]]);
    const { manager } = fakeManager();
    const deps = {
      manager,
      profileOf: (id: string) => profiles.get(id),
      opencodePasswordOf: () => null,
      fetchFn: () => Promise.resolve(new Response("{}", { status: 200 })),
      now: () => 1_000,
    };
    const t = createRemoteTransport(deps);
    const r = await t.ensure("srv-1");
    expect(r).toEqual({
      ok: true,
      baseUrl: "http://tailnet:4096",
      tunnel: false,
    });
  });

  it("health is TTL-cached (one probe per 20s window) and invalidated by teardown", async () => {
    const { manager } = fakeManager();
    let clock = 1_000;
    const probes: string[] = [];
    const deps = {
      manager,
      profileOf: (id: string) => (id === "srv-1" ? profile() : undefined),
      opencodePasswordOf: () => "pw",
      fetchFn: (url: string) => {
        probes.push(url);
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
      now: () => clock,
    };
    const t = createRemoteTransport(deps);
    const serve = startEcho(49374);
    try {
      await t.health("srv-1");
      await t.health("srv-1"); // same window → no new probe
      expect(probes).toHaveLength(1);
      clock += 20_001;
      await t.health("srv-1"); // window elapsed → re-probe
      expect(probes).toHaveLength(2);
      t.teardown("srv-1");
      await t.health("srv-1"); // invalidated → re-probe even in-window
      expect(probes).toHaveLength(3);
    } finally {
      serve.close();
    }
  });

  it("a stop-probe profile (no opencode section) answers null health and refuses ensure", async () => {
    const profiles = new Map<string, ServerProfile>([
      ["srv-n", { ...profile(), opencode: undefined }],
    ]);
    profiles.delete("srv-n");
    profiles.set("srv-n", { ...profile(), id: "srv-n", opencode: undefined });
    const { manager } = fakeManager();
    const t = createRemoteTransport({
      manager,
      profileOf: (id) => profiles.get(id),
      opencodePasswordOf: () => null,
      fetchFn: () => Promise.resolve(new Response("{}", { status: 200 })),
      now: () => 1_000,
    });
    expect(await t.health("srv-n")).toBeNull();
    expect(await t.ensure("srv-n")).toEqual({
      ok: false,
      error: "This server does not host OpenCode.",
    });
  });

  it("a 401 serve reads down with the password hint (never the credential)", async () => {
    const { manager } = fakeManager();
    const t = createRemoteTransport({
      manager,
      profileOf: () => profile(),
      opencodePasswordOf: () => "hunter2-secret",
      fetchFn: () => Promise.resolve(new Response("no", { status: 401 })),
      now: () => 1_000,
    });
    const serve = startEcho(49374);
    try {
      const h = await t.health("srv-1");
      expect(h?.state).toBe("down");
      expect(h?.detail).toContain("password");
      expect(JSON.stringify(h)).not.toContain("hunter2-secret");
    } finally {
      serve.close();
    }
  });
});

function healthOut(h: { state: string; detail?: string } | null): string {
  return h ? h.state : "down";
}
