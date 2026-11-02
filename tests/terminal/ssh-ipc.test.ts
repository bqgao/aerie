import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { SSH_TERMINAL } from "../../src/shared/ssh-terminal";
import {
  registerSshTerminalIpc,
  normalizeSshShellWindow,
  type SshTerminalConnectionPool,
} from "../../src/main/terminal/ssh-ipc";
import type { SshClientRpc } from "../../src/main/servers/connection-manager";
import type { SshShellStream } from "../../src/main/servers/connection-manager";

// Same electron mock as tests/servers/servers-ipc.test.ts — capture the handlers the IPC layer
// registers, both invoke-style (handle) and send-style (on).
const { handlers, onHandlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  onHandlers: new Map<string, (...a: unknown[]) => void>(),
}));
vi.mock("electron", () => ({
  app: { on: () => {}, removeListener: () => {} },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) =>
      handlers.set(channel, fn),
    on: (channel: string, fn: (...a: unknown[]) => void) =>
      onHandlers.set(channel, fn),
    removeHandler: () => {},
    removeListener: () => {},
  },
}));

interface ChannelSpy {
  channel: SshShellStream;
  state: { writes: string[]; windows: number[][]; closed: boolean };
  /** Deliver one output chunk as ssh2 would. */
  emitData(d: string): void;
  emitClose(): void;
}

function makeChannel(): ChannelSpy {
  const state = {
    writes: [] as string[],
    windows: [] as number[][],
    closed: false,
  };
  let dataCb: (d: Buffer | string) => void = () => {};
  let closeCb: (err?: Error) => void = () => {};
  const channel: SshShellStream = {
    write: (d) => {
      state.writes.push(String(d));
    },
    setWindow: (rows, cols) => {
      state.windows.push([rows, cols]);
    },
    pause: () => {},
    resume: () => {},
    end: () => {},
    close: () => {
      state.closed = true;
    },
    on: ((event: string, cb: (arg?: unknown) => void) => {
      if (event === "data") dataCb = cb;
      if (event === "close") closeCb = cb;
      return channel;
    }) as unknown as SshShellStream["on"],
  };
  return {
    channel,
    state,
    emitData: (d: string) => dataCb(d),
    emitClose: () => closeCb(),
  };
}

interface Wire {
  /** Spawn through the captured handler (async — the pool dial). */
  spawn(raw: unknown): Promise<unknown>;
  /** PUSH-channel deliveries the fake window recorded. */
  sends: Array<unknown[]>;
  pool: {
    /** The vi.fn spy (typed loosely: the spy ASSERTS are runtime-only here). */
    connect: unknown;
    withClient: unknown;
  };
  rpc: { shell: Mock };
  /** Each `shell(window, cb)` captured callback; use it to hand a channel to the session. */
  deliverChannel(i: number, spy: ChannelSpy): void;
  fire(channel: string, ...args: unknown[]): void;
  noteDown(serverId: string): void;
}

function wire(
  connectResult: { ok: true } | { ok: false; error: string } = { ok: true },
  liveClient: boolean = true,
): Wire {
  const sends: Array<unknown[]> = [];
  const shellCbs: Array<
    (err: Error | null, stream: SshShellStream | null) => void
  > = [];
  // The fake pooled client: the FULL SshClientRpc surface (pool-level members are inert) plus the
  // shell seam. Contextual typing keeps exec's callback in the pool's own param shape.
  const rpc: SshClientRpc & {
    shell: (
      window: unknown,
      cb: (err: Error | undefined, stream: SshShellStream | null) => void,
    ) => void;
  } = {
    connect: () => {},
    end: () => {},
    exec: (_c, cb) => {
      cb(undefined, null);
    },
    forwardOut: () => {},
    shell: vi.fn((_window, cb) => {
      shellCbs.push(cb);
    }),
  };
  const poolConnect: SshTerminalConnectionPool["connect"] = vi.fn(() =>
    Promise.resolve(connectResult),
  );
  const poolWithClient: SshTerminalConnectionPool["withClient"] = vi.fn(
    (_id, fn) => (liveClient ? fn(rpc) : null),
  );
  const pool: SshTerminalConnectionPool = {
    connect: poolConnect,
    withClient: poolWithClient,
  };
  const window = {
    isDestroyed: () => false,
    on: () => {},
    webContents: { send: (...args: unknown[]) => sends.push(args) },
  } as never as import("electron").BrowserWindow;
  const control = registerSshTerminalIpc({
    window,
    connectionManager: pool,
    // Synchronous passthrough: a real channel's chunks must be observable with no coalescing timer.
    createBufferer: (flush) => ({
      add: flush,
      flush: () => {},
      dispose: () => {},
    }),
  });
  return {
    spawn: (raw) =>
      (handlers.get(SSH_TERMINAL.spawn)?.(
        undefined,
        raw,
      ) as Promise<unknown>) ?? Promise.resolve(undefined),
    sends,
    pool: {
      connect: poolConnect,
      withClient: poolWithClient,
    },
    rpc: { shell: rpc.shell as unknown as Mock },
    deliverChannel: (i, spy) => shellCbs[i]?.(null, spy.channel),
    fire: (channel, ...args) => onHandlers.get(channel)?.(undefined, ...args),
    noteDown: control.noteDown,
  };
}

const REQ = { id: "ssh-tab-1-0", serverId: "srv-1", cols: 100, rows: 30 };

describe("registerSshTerminalIpc", () => {
  beforeEach(() => {
    handlers.clear();
    onHandlers.clear();
  });

  it("rejects malformed input in-band, never by throwing, before touching the pool", async () => {
    const h = wire();
    await expect(h.spawn(null)).resolves.toMatchObject({ ok: false });
    await expect(h.spawn({ id: "", serverId: "srv" })).resolves.toMatchObject({
      ok: false,
    });
    await expect(h.spawn({ id: "x" })).resolves.toMatchObject({ ok: false });
    expect(h.pool.connect).not.toHaveBeenCalled();
  });

  it("a refused pool dial answers the refusal in-band BEFORE any channel opens (no dead tab)", async () => {
    const h = wire({
      ok: false,
      error: "No password stored for this profile.",
    });
    await expect(h.spawn(REQ)).resolves.toEqual({
      ok: false,
      error: "No password stored for this profile.",
    });
    expect(h.rpc.shell).not.toHaveBeenCalled();
    expect(h.pool.withClient).not.toHaveBeenCalled();
  });

  it("a happy spawn dials the pool, opens one shell window with the clamped grid, and answers ok:true", async () => {
    const h = wire();
    const result = await h.spawn(REQ);
    expect(result).toEqual({ ok: true });
    expect(h.pool.connect).toHaveBeenCalledWith("srv-1");
    expect(h.rpc.shell).toHaveBeenCalledTimes(1);
    const [win] = (h.rpc.shell.mock.calls[0] ?? []) as [
      { term?: string; cols?: number; rows?: number },
      unknown,
    ];
    expect(win).toEqual({ term: "xterm-256color", cols: 100, rows: 30 });
  });

  it("real channel data pushes with cumulative offsets; a pool drop pushes ONE 'dropped' exit", async () => {
    const h = wire();
    await h.spawn(REQ);
    const spy = makeChannel();
    h.deliverChannel(0, spy);
    spy.emitData("motd");
    expect(h.sends[0]).toEqual([SSH_TERMINAL.data, "ssh-tab-1-0", "motd", 4]);
    spy.emitData("more");
    expect(h.sends[1]).toEqual([SSH_TERMINAL.data, "ssh-tab-1-0", "more", 8]);

    // The composition root's onDown → noteDown: drops end the session with the reason intact.
    h.noteDown("srv-1");
    const exitPush = h.sends.filter((s) => s[0] === SSH_TERMINAL.exit);
    expect(exitPush).toHaveLength(1);
    expect(exitPush[0]).toEqual([
      SSH_TERMINAL.exit,
      "ssh-tab-1-0",
      0,
      "dropped",
    ]);
    spy.emitClose();
    expect(h.sends.filter((s) => s[0] === SSH_TERMINAL.exit)).toHaveLength(1); // absorbed
  });

  it("a remote shell exit pushes 'ended'; the write/resize/ack/close send channels map onto the channel", async () => {
    const h = wire();
    await h.spawn(REQ);
    const spy = makeChannel();
    h.deliverChannel(0, spy);

    h.fire(SSH_TERMINAL.write, "ssh-tab-1-0", "ls\n");
    expect(spy.state.writes).toEqual(["ls\n"]);
    h.fire(SSH_TERMINAL.resize, "ssh-tab-1-0", 120, 40);
    expect(spy.state.windows).toEqual([[40, 120]]);
    h.fire(SSH_TERMINAL.ack, "ssh-tab-1-0", 100); // quiet when nothing is paused

    // Deliver an ssh2 'close' carrying NO remote 'exit': a hard drop while the pool is live.
    // (The pool is still healthy in this fake, but the channel died — the manager can only see
    // a close without exit, which reads "dropped".)
    spy.emitClose();
    const exitPush = h.sends.filter((s) => s[0] === SSH_TERMINAL.exit);
    expect(exitPush).toHaveLength(1);
    expect(exitPush[0][3]).toBe("dropped");
  });

  it("a user close tears the channel down (close() called) without touching the pooled client", async () => {
    const h = wire();
    await h.spawn(REQ);
    const spy = makeChannel();
    h.deliverChannel(0, spy);
    h.fire(SSH_TERMINAL.close, "ssh-tab-1-0");
    expect(spy.state.closed).toBe(true);
    // The pool was never disconnected — one connection per server, terminal teardown is local.
    expect(h.pool.connect).toHaveBeenCalledTimes(1);
  });

  it("a not-connected server (nothing to borrow) fails the channel open in-band as an 'ended' exit", async () => {
    const h = wire({ ok: true }, false);
    await expect(h.spawn(REQ)).resolves.toEqual({ ok: true });
    expect(h.rpc.shell).not.toHaveBeenCalled();
    const exitPush = h.sends.filter((s) => s[0] === SSH_TERMINAL.exit);
    expect(exitPush).toEqual([[SSH_TERMINAL.exit, "ssh-tab-1-0", 1, "ended"]]);
  });

  it("a close racing a still-resolving dial never stands the session up on its late success", async () => {
    const h = wire();
    // Spawn, but do NOT resolve the dial yet.
    const spawning = h.spawn(REQ);
    expect(h.pool.connect).toHaveBeenCalledTimes(1);
    // The renderer closes its (optimistic) tab — the close event lands while the dial resolves.
    h.fire(SSH_TERMINAL.close, "ssh-tab-1-0");
    await expect(spawning).resolves.toEqual({ ok: true });
    expect(h.rpc.shell).not.toHaveBeenCalled();
  });

  it("normalizeSshShellWindow clamps grid dims into the 1–500 window", () => {
    const w = normalizeSshShellWindow(0, -3);
    expect(w).toEqual({ term: "xterm-256color", cols: 80, rows: 24 });
    expect(normalizeSshShellWindow(9999, 1)).toMatchObject({
      cols: 500,
      rows: 1,
    });
    expect(normalizeSshShellWindow("abc", null)).toMatchObject({
      cols: 80,
      rows: 24,
    });
  });
});
