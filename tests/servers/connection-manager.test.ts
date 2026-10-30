import { describe, it, expect, vi } from "vitest";
import type { Readable } from "node:stream";
import type { ServerProfile } from "../../src/shared/servers";
import {
  createConnectionManager,
  type SshClientFactory,
  type SshClientRpc,
} from "../../src/main/servers/connection-manager";

/** A scripted ssh2 fake: records every dial config, and hands tests a tiny controller to fire
 *  ready / error / close / exec output in whichever order they like. */
function makeFactory() {
  const configs: Array<Record<string, unknown>> = [];
  type Exec = (err: Error | undefined, stream: Readable | null) => void;
  type Live = {
    handlers: {
      onReady(): void;
      onError(err: Error): void;
      onClose(hadError: boolean): void;
      onDown?(err: Error | null): void;
    };
    execs: Exec[];
    ended: boolean;
    up: boolean;
    down: boolean;
    heldError: Error | null;
  };
  const lives: Live[] = [];
  const down = (l: Live, err: Error | null): void => {
    if (l.down) return; // one physical drop, one onDown — mirroring the real factory
    l.down = true;
    l.handlers.onDown?.(err);
  };
  const factory: SshClientFactory = (config, handlers) => {
    configs.push(config as unknown as Record<string, unknown>);
    const live: Live = {
      handlers,
      execs: [],
      ended: false,
      up: false,
      down: false,
      heldError: null,
    };
    lives.push(live);
    const rpc: SshClientRpc = {
      connect: () => {}, // the fake dials on construction; connect() is a marker
      end: () => {
        live.ended = true;
      },
      exec: (_cmd, cb) => {
        live.execs.push(cb);
      },
    };
    return rpc;
  };
  /** Fire one event on the newest client through the factory's routing rules. */
  const route = (
    ev: "ready" | "error" | "close",
    arg: Error | boolean,
  ): void => {
    const l = lives[lives.length - 1];
    if (!l) throw new Error("no live dial");
    if (ev === "ready") {
      l.up = true;
      l.handlers.onReady();
    } else if (ev === "error") {
      if (!l.up) l.handlers.onError(arg as Error);
      else {
        l.heldError = arg as Error;
        down(l, l.heldError);
      }
    } else {
      if (!l.up) l.handlers.onClose(arg as boolean);
      else down(l, l.heldError); // error-carried close → its message; clean close → null
    }
  };
  return {
    configs,
    lives,
    factory,
    latest: (): Live => lives[lives.length - 1],
    ready: () => route("ready", false),
    /** Dial-phase failure (pre-ready). */
    fail: (msg: string) => route("error", new Error(msg)),
    close: (hadError: boolean) => route("close", hadError),
    /** Post-ready clean drop: server reboot / link cut with no ssh2 'error'. */
    dropClean: () => route("close", false),
    /** Post-ready error drop: ssh2 emits 'error' carrying the message (then 'close'). */
    dropError: (msg: string) => route("error", new Error(msg)),
    /** Answer the newest client's first exec with `text` (stream data + close) or an error. */
    execOutput: (text: string) => {
      const live = lives[lives.length - 1];
      const cb = live.execs[0];
      const stream = {
        on: (ev: string, fn: (c?: unknown) => void) => {
          if (ev === "data") fn(Buffer.from(text));
          if (ev === "close") fn();
        },
      };
      cb(undefined, stream as never);
    },
    execError: (msg: string) => {
      const live = lives[lives.length - 1];
      live.execs[0](new Error(msg), undefined as never);
    },
  };
}

const profile: ServerProfile = {
  id: "srv-1",
  name: "web-1",
  group: "prod",
  host: "web1.home",
  port: 2222,
  username: "deploy",
  authMode: "password",
  createdAtMs: 0,
};

function makeManager(
  overrides?: Partial<Parameters<typeof createConnectionManager>[0]>,
) {
  const ssh = makeFactory();
  const profiles = new Map<string, ServerProfile>([
    [profile.id, { ...profile }],
  ]);
  const creds = new Map<string, { password?: string; passphrase?: string }>([
    [profile.id, { password: "hunter2" }],
  ]);
  const onConnected = vi.fn();
  const manager = createConnectionManager({
    profileOf: (id) => profiles.get(id),
    credentialsOf: (id) => creds.get(id) ?? null,
    sshFactory: ssh.factory,
    onConnected,
    now: () => 42,
    ...(overrides ?? {}),
  });
  return { ssh, manager, profiles, creds, onConnected };
}

describe("createConnectionManager", () => {
  it("dial config carries the pool timeouts, keepalive trio, and the auth-mode resolution (password)", () => {
    const { ssh, manager } = makeManager();
    void manager.connect("srv-1");
    expect(ssh.configs[0]).toMatchObject({
      host: "web1.home",
      port: 2222,
      username: "deploy",
      password: "hunter2",
      readyTimeout: 10_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
    });
    expect(ssh.configs[0].privateKey).toBeUndefined();
  });

  it("key mode reads the key fresh per dial and passes the stored passphrase", () => {
    const keyRead = vi.fn(() => "KEYDATA");
    const { ssh, profiles, creds } = makeManager({ readKeyFile: keyRead });
    profiles.set("srv-1", { ...profile, authMode: "key", keyPath: "/keys/id" });
    creds.set("srv-1", { passphrase: "zap" });
    void createConnectionManager({
      profileOf: (id) => profiles.get(id),
      credentialsOf: (id) => creds.get(id) ?? null,
      sshFactory: ssh.factory,
      onConnected: () => {},
      readKeyFile: keyRead,
    }).connect("srv-1");
    expect(keyRead).toHaveBeenCalledWith("/keys/id");
    expect(ssh.configs[0]).toMatchObject({
      privateKey: "KEYDATA",
      passphrase: "zap",
    });
    expect(ssh.configs[0].password).toBeUndefined();
  });

  it("agent mode passes SSH_AUTH_SOCK and ignores stored secrets", () => {
    const env = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/fake/agent";
    try {
      const { ssh, profiles } = makeManager();
      profiles.set("srv-1", { ...profile, authMode: "agent" });
      void createConnectionManager({
        profileOf: (id) => profiles.get(id),
        credentialsOf: () => ({ password: "ignored" }),
        sshFactory: ssh.factory,
        onConnected: () => {},
      }).connect("srv-1");
      expect(ssh.configs[0]).toMatchObject({ agent: "/fake/agent" });
      expect(ssh.configs[0].password).toBeUndefined();
    } finally {
      if (env === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = env;
    }
  });

  it("missing credential material fails fast without dialing, and the error sticks in status", async () => {
    const { ssh, manager, creds } = makeManager();
    creds.delete("srv-1");
    const r = await manager.connect("srv-1");
    expect(r).toEqual({
      ok: false,
      error: "No password stored for this profile.",
    });
    expect(ssh.configs).toHaveLength(0);
    expect(manager.status()["srv-1"]).toEqual({
      status: "error",
      lastError: "No password stored for this profile.",
    });
  });

  it("pool: ready transitions to connected and stamps lastConnected; a repeat connect reuses the live dial", async () => {
    const { ssh, manager, onConnected } = makeManager();
    const first = manager.connect("srv-1"); // dial in flight
    expect(manager.status()["srv-1"]).toEqual({ status: "connecting" });
    ssh.ready();
    await first;
    expect(onConnected).toHaveBeenCalledWith("srv-1", 42);
    expect(manager.status()["srv-1"]).toEqual({ status: "connected" });
    // Second connect: no new dial (configs unchanged), still ok.
    const r2 = await manager.connect("srv-1");
    expect(r2).toEqual({ ok: true });
    expect(ssh.configs).toHaveLength(1);
  });

  it("a failed dial evicts and leaves the error visible; disconnect clears both", async () => {
    const { ssh, manager } = makeManager();
    const first = manager.connect("srv-1");
    ssh.fail("All configured authentication methods failed");
    expect(await first).toEqual({
      ok: false,
      error: "All configured authentication methods failed",
    });
    // Pool entry evicted on failure, but status keeps the sticky error (the row must show it).
    expect(manager.status()["srv-1"]).toEqual({
      status: "error",
      lastError: "All configured authentication methods failed",
    });
    manager.disconnect("srv-1");
    expect(manager.status()["srv-1"]).toBeUndefined(); // cleared, not stuck
  });

  it("disconnect ends the live client and evicts; a later connect re-dials", async () => {
    const { ssh, manager } = makeManager();
    const first = manager.connect("srv-1");
    ssh.ready();
    await first;
    manager.disconnect("srv-1");
    expect(ssh.latest().ended).toBe(true);
    expect(manager.status()["srv-1"]).toBeUndefined();
    const second = manager.connect("srv-1");
    ssh.ready();
    await second;
    expect(ssh.configs).toHaveLength(2); // a fresh dial, not a zombie reuse
  });

  it("a second connect while the first dial is in flight shares exactly one outcome", async () => {
    const { ssh, manager } = makeManager();
    const a = manager.connect("srv-1");
    const b = manager.connect("srv-1"); // follower attaches to a's dial
    ssh.ready();
    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: true }); // one dial, two ok's
    expect(ssh.configs).toHaveLength(1);
  });

  it("withClient returns null offline and the live handle connected", async () => {
    const { ssh, manager } = makeManager();
    expect(manager.withClient("srv-1", (r) => r)).toBeNull();
    const first = manager.connect("srv-1");
    ssh.ready();
    await first;
    expect(manager.withClient("srv-1", (r) => r !== null)).toBe(true);
    expect(manager.withClient("srv-unknown", (r) => r)).toBeNull();
  });

  it("test(): dials once with pooled settings, requires echo ok, and closes what it opened", async () => {
    const { ssh, manager } = makeManager();
    const p = manager.test({
      host: "probe.home",
      port: 22,
      username: "ci",
      authMode: "password",
      password: "tmp",
    });
    await vi.waitFor(() => {
      expect(ssh.lives.length).toBeGreaterThan(0);
    });
    ssh.ready();
    await vi.waitFor(() => expect(ssh.latest().execs).toHaveLength(1));
    ssh.execOutput("ok\n");
    expect(await p).toEqual({ ok: true });
    expect(ssh.configs).toHaveLength(1);
    expect(ssh.configs[0]).toMatchObject({
      host: "probe.home",
      password: "tmp",
    });
    expect(ssh.latest().ended).toBe(true); // closed even on success
    expect(ssh.latest().execs).toHaveLength(1); // exactly one echo probe
  });

  it("test(): wrong echo output reads ok:false and still closes", async () => {
    const { ssh, manager } = makeManager();
    const p = manager.test({
      host: "h",
      port: 22,
      username: "u",
      authMode: "agent",
    });
    ssh.ready();
    await vi.waitFor(() => expect(ssh.latest().execs).toHaveLength(1));
    ssh.execOutput("command not found");
    expect(await p).toEqual({
      ok: false,
      error: "The test ran but `echo ok` did not come back.",
    });
    expect(ssh.latest().ended).toBe(true);
  });

  it("test(): an exec error and a dial failure both read ok:false with the reason", async () => {
    const { ssh, manager } = makeManager();
    // exec error (after a successful dial — same as a ready shell refusing to run)
    const filtered = manager.test({
      host: "h",
      port: 22,
      username: "u",
      authMode: "agent",
    });
    ssh.ready();
    await vi.waitFor(() => expect(ssh.latest().execs).toHaveLength(1));
    ssh.execError("exec failed");
    expect(await filtered).toEqual({ ok: false, error: "exec failed" });
    expect(ssh.latest().ended).toBe(true);

    // dial failure (never reaches exec)
    const { ssh: ssh2, manager: mgr2 } = makeManager();
    const third = mgr2.test({
      host: "h",
      port: 22,
      username: "u",
      authMode: "agent",
    });
    ssh2.fail("authentication refused");
    expect(await third).toEqual({ ok: false, error: "authentication refused" });
  });

  it("test(): a config-less input (no credential for the raw values) answers before dialing", async () => {
    const { ssh, manager, creds } = makeManager();
    creds.clear();
    const r = await manager.test({
      host: "h",
      port: 22,
      username: "u",
      authMode: "password",
    });
    // test() takes raw values — its own credential was absent → config error, no dial.
    expect(r).toEqual({
      ok: false,
      error: "No password stored for this profile.",
    });
    expect(ssh.configs).toHaveLength(0);
  });

  it("a post-ready clean drop flips status to error with the drop message, evicts, and withClient goes null", async () => {
    const { ssh, manager } = makeManager();
    const first = manager.connect("srv-1");
    ssh.ready();
    await first;
    expect(manager.status()["srv-1"]).toEqual({ status: "connected" });
    expect(manager.withClient("srv-1", (r) => r !== null)).toBe(true);
    // The server reboots: a close with no ssh2 error, after ready.
    ssh.dropClean();
    // The dead client is gone from the pool; the drop reason is sticky for the row.
    expect(manager.status()["srv-1"]).toEqual({
      status: "error",
      lastError: "The connection dropped.",
    });
    expect(manager.withClient("srv-1", (r) => r)).toBeNull();
  });

  it("a post-ready ssh2 'error' drop carries that message instead of the generic one", async () => {
    const { ssh, manager } = makeManager();
    const first = manager.connect("srv-1");
    ssh.ready();
    await first;
    ssh.dropError("connection reset by peer");
    expect(manager.status()["srv-1"]).toEqual({
      status: "error",
      lastError: "connection reset by peer",
    });
    expect(manager.withClient("srv-1", (r) => r)).toBeNull();
    // 'error' then 'close' is ssh2's normal pairing — the second report must not override.
    ssh.close(false);
    expect(manager.status()["srv-1"]).toEqual({
      status: "error",
      lastError: "connection reset by peer",
    });
  });

  it("a user disconnect reads offline (absent), never an error — even with a late close event", async () => {
    const { ssh, manager } = makeManager();
    const first = manager.connect("srv-1");
    ssh.ready();
    await first;
    manager.disconnect("srv-1");
    // The user-initiated call already evicted; then ssh2's clean close fires on the ended client.
    expect(manager.status()["srv-1"]).toBeUndefined();
    ssh.dropClean(); // the late close lands on the flagged entry — must stay silent
    expect(manager.status()["srv-1"]).toBeUndefined(); // offline, NOT "error"
  });

  it("after a drop, connect() re-dials cleanly and the sticky error clears", async () => {
    const { ssh, manager } = makeManager();
    const first = manager.connect("srv-1");
    ssh.ready();
    await first;
    ssh.dropClean();
    expect(manager.status()["srv-1"]).toEqual({
      status: "error",
      lastError: "The connection dropped.",
    });
    const second = manager.connect("srv-1");
    expect(manager.status()["srv-1"]).toEqual({ status: "connecting" });
    ssh.ready();
    await second;
    expect(ssh.configs).toHaveLength(2); // a fresh dial
    expect(manager.status()["srv-1"]).toEqual({ status: "connected" });
    expect(manager.status()["srv-1"].lastError).toBeUndefined(); // sticky error gone
  });

  it("unknown profile ids are answered without touching the factory", async () => {
    const { ssh, manager } = makeManager();
    expect(await manager.connect("srv-nope")).toEqual({
      ok: false,
      error: "Unknown profile.",
    });
    expect(ssh.configs).toHaveLength(0);
  });
});
