import { describe, it, expect } from "vitest";
import { FLOW } from "../../src/shared/terminal";
import {
  createSshTerminalManager,
  type SshTerminalDeps,
} from "../../src/main/terminal/ssh-session";
import type {
  SshShellStream,
  SshShellWindow,
} from "../../src/main/servers/connection-manager";
import type { DataBufferer } from "../../src/main/terminal/data-bufferer";

/** A controllable stand-in for an ssh2 shell channel (the narrowed SshShellStream surface). State
 *  is closed over (no `this`), so the channel's methods mutate it and the test reads `.state`. */
interface FakeStream {
  stream: SshShellStream;
  state: {
    writes: string[];
    windows: Array<[number, number, number, number]>;
    paused: boolean;
    ended: boolean;
    closed: boolean;
  };
  emitData(d: string): void;
  emitExit(): void;
  emitClose(): void;
}

function fakeStream(): FakeStream {
  const state = {
    writes: [] as string[],
    windows: [] as Array<[number, number, number, number]>,
    paused: false,
    ended: false,
    closed: false,
  };
  let dataCb: (d: Buffer | string) => void = () => {};
  let exitCb: () => void = () => {};
  let closeCb: (err?: Error) => void = () => {};
  const stream: SshShellStream = {
    write: (d) => {
      state.writes.push(String(d));
    },
    setWindow: (rows, cols, height, width) => {
      state.windows.push([rows, cols, height, width]);
    },
    pause: () => {
      state.paused = true;
    },
    resume: () => {
      state.paused = false;
    },
    end: () => {
      state.ended = true;
    },
    close: () => {
      state.closed = true;
    },
    on: ((event: string, cb: (arg?: unknown) => void) => {
      if (event === "data") dataCb = cb;
      else if (event === "exit") exitCb = cb;
      else if (event === "close") closeCb = cb;
      return stream;
    }) as unknown as SshShellStream["on"],
  };
  return {
    stream,
    state,
    emitData: (d: string) => dataCb(d),
    emitExit: () => exitCb(),
    emitClose: () => closeCb(),
  };
}

type BuffererSpy = DataBufferer & { disposed: boolean };

function spyBufferer(): BuffererSpy {
  const b: BuffererSpy = {
    add: () => {},
    flush: () => {},
    dispose: () => {
      b.disposed = true;
    },
    disposed: false,
  };
  return b;
}

/** The scripted outcome of openShell; `openScript` is replaced per test. */
type OpenScript = (
  cb: (err: Error | null, stream: SshShellStream | null) => void,
) => void;

function wire() {
  const streams: FakeStream[] = [];
  const bufferers: BuffererSpy[] = [];
  const sent: Array<[string, string, number]> = [];
  const exits: Array<[string, number, "dropped" | "ended"]> = [];
  const opens: Array<{ serverId: string; window: SshShellWindow }> = [];
  let openScript: OpenScript = (cb) => {
    const f = fakeStream();
    streams.push(f);
    cb(null, f.stream);
  };

  const newStream = (): FakeStream => {
    const f = fakeStream();
    streams.push(f);
    return f;
  };

  const deps: SshTerminalDeps = {
    send: (id, data, offset) => {
      sent.push([id, data, offset]);
    },
    notifyExit: (id, exitCode, reason) => {
      exits.push([id, exitCode, reason]);
    },
    openShell: (serverId, window, cb) => {
      opens.push({ serverId, window });
      openScript(cb);
    },
    createBufferer: (flush) => {
      const b = spyBufferer();
      b.add = flush;
      bufferers.push(b);
      return b;
    },
  };

  const manager = createSshTerminalManager(deps);
  return {
    manager,
    streams,
    newStream,
    bufferers,
    sent,
    exits,
    opens,
    setOpenScript: (fn: OpenScript) => (openScript = fn),
  };
}

const REQ = { id: "ssh-tab-1-0", serverId: "srv-1", cols: 90, rows: 26 };

describe("createSshTerminalManager", () => {
  it("opens one shell window per session with the requested TERM + grid, and maps data/write/resize", () => {
    const h = wire();
    h.manager.open(REQ);
    expect(h.opens).toEqual([
      {
        serverId: "srv-1",
        window: { term: "xterm-256color", cols: 90, rows: 26 },
      },
    ]);
    expect(h.streams).toHaveLength(1);
    const f = h.streams[0];

    // Inbound data rides the bufferer (flushed synchronously here) with CUMULATIVE offsets.
    f.emitData("hello");
    f.emitData("wo");
    expect(h.sent).toEqual([
      ["ssh-tab-1-0", "hello", 5],
      ["ssh-tab-1-0", "wo", 7],
    ]);

    // Keystrokes go straight to the channel.
    h.manager.write(REQ.id, "ls\n");
    expect(f.state.writes).toEqual(["ls\n"]);

    // Resize maps xterm cols/rows to ssh2's setWindow argument order (rows, cols), pixels at 0.
    h.manager.resize(REQ.id, 120, 40);
    expect(f.state.windows).toEqual([[40, 120, 0, 0]]);
  });

  it("is idempotent on a live id (a double open cannot double-dial one channel)", () => {
    const h = wire();
    h.manager.open(REQ);
    h.manager.open(REQ);
    expect(h.opens).toHaveLength(1);
  });

  it("pauses the channel's READ side at the high-water credit and acks resume below the low-water line", () => {
    const h = wire();
    h.manager.open(REQ);
    const f = h.streams[0];
    const flood = "x".repeat(FLOW.highWaterChars + 1);
    f.emitData(flood);
    expect(f.state.paused).toBe(true);

    // Partial credit keeps it paused; draining below the resume line resumes.
    h.manager.ack(REQ.id, 50);
    expect(f.state.paused).toBe(true);
    h.manager.ack(REQ.id, FLOW.highWaterChars + 50); // over-drain clamps at 0
    expect(f.state.paused).toBe(false);

    // Writing again re-arms the pause at the same threshold.
    f.emitData("x".repeat(FLOW.highWaterChars + 1));
    expect(f.state.paused).toBe(true);
  });

  it("a pooled server drop records ONE 'dropped' exit and absorbs the dead channel's late close", () => {
    const h = wire();
    h.manager.open(REQ);
    h.manager.noteDown("srv-1");
    expect(h.exits).toEqual([["ssh-tab-1-0", 0, "dropped"]]);
    h.streams[0].emitClose();
    expect(h.exits).toHaveLength(1);

    // Multiple sessions riding one server all record; other servers are untouched.
    h.manager.open({ ...REQ, id: "ssh-tab-2-0" });
    h.manager.noteDown("other-srv");
    expect(h.exits).toHaveLength(1);
    h.manager.noteDown("srv-1");
    expect(h.exits).toHaveLength(2);
  });

  it("a REMOTE shell exit (channel 'exit' then 'close') records 'ended', not 'dropped'", () => {
    const h = wire();
    h.manager.open(REQ);
    const f = h.streams[0];
    f.emitExit();
    f.emitClose();
    expect(h.exits).toEqual([["ssh-tab-1-0", 0, "ended"]]);
  });

  it("a user teardown closes the channel (bufferer disposed, 'ended' recorded) and absorbs the late close", () => {
    const h = wire();
    h.manager.open(REQ);
    h.manager.close(REQ.id);
    expect(h.streams[0].state.closed).toBe(true);
    expect(h.bufferers[0].disposed).toBe(true);
    expect(h.exits).toEqual([["ssh-tab-1-0", 0, "ended"]]);
    h.streams[0].emitClose();
    expect(h.exits).toHaveLength(1);

    // Closing an unknown / already-closed id is a quiet no-op.
    expect(() => h.manager.close("nope")).not.toThrow();
    expect(h.exits).toHaveLength(1);
  });

  it("a refused channel open ends the session 'ended' (exit code 1) with no channel to map", () => {
    const h = wire();
    h.setOpenScript((cb) => cb(new Error("channel refused"), null));
    h.manager.open(REQ);
    expect(h.exits).toEqual([["ssh-tab-1-0", 1, "ended"]]);
    expect(h.streams).toHaveLength(0);
    expect(h.bufferers[0].disposed).toBe(true);
  });

  it("a user close racing a still-opening channel drops the arrived stream silently", () => {
    const h = wire();
    let pendingCb:
      | ((err: Error | null, s: SshShellStream | null) => void)
      | null = null;
    h.setOpenScript((cb) => {
      pendingCb = cb;
    });
    h.manager.open(REQ);
    expect(h.streams).toHaveLength(0);
    h.manager.close(REQ.id);
    expect(h.exits).toEqual([["ssh-tab-1-0", 0, "ended"]]);
    // The stream then arrives from ssh: the manager owns no session anymore, so it closes the
    // channel without recording anything (the user close already owns the story).
    const arrived = h.newStream();
    pendingCb!(null, arrived.stream);
    expect(arrived.state.closed).toBe(true);
    expect(h.exits).toHaveLength(1);
  });

  it("disposeAll closes every channel and records NOTHING (window teardown, not a runtime drop)", () => {
    const h = wire();
    h.manager.open(REQ);
    h.manager.open({
      id: "ssh-tab-2-0",
      serverId: "srv-1",
      cols: 80,
      rows: 24,
    });
    h.manager.disposeAll();
    expect(h.streams.map((f) => f.state.closed)).toEqual([true, true]);
    expect(h.exits).toEqual([]);
    expect(h.bufferers.map((b) => b.disposed)).toEqual([true, true]);
  });
});
