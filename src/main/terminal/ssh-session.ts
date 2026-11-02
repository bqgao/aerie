/**
 * The SSH terminal session store — one ssh2 shell channel per session id, adapted onto the same
 * write/resize/ack/exit surface the ppty managers expose (terminal/manager.ts). NO node-pty on the
 * remote side: the remote pty is the sshd's, reached through ONE pooled ssh2 client (the S1 pool's
 * withClient seam) — a shell channel rides whatever client is live, and a pooled drop kills every
 * channel riding it with the socket.
 *
 * The lifecycle mirrors the pty manager's: bytes stream through the 5ms coalescer (the bufferer) to
 * the push channel with a cumulative output offset; flow control pauses the channel's READ side at
 * FLOW.highWaterChars and the renderer's acks resume it below FLOW.lowWaterChars. Exit carries a
 * WHY (shared SshTerminalExitReason): the pool's onDown means "dropped" (the tab survives behind a
 * lock overlay until Reconnect), while a remote `exit`/user teardown means "ended" (the tab dies
 * like a local shell's exit). A user-scoped channel close never disconnects the pooled client —
 * other surfaces (tunnel, execs) share it.
 */
import { FLOW } from "@shared/terminal";
import { createDataBufferer, type DataBufferer } from "./data-bufferer";
import type {
  SshShellStream,
  SshShellWindow,
} from "../servers/connection-manager";

export type {
  SshShellStream,
  SshShellWindow,
} from "../servers/connection-manager";

/** One open request. `id` is the renderer-minted ssh session id (unique per tab+attempt); rows/cols
 *  seed the remote pty's initial grid (the renderer's first fit corrects it through resize). */
export interface SshTerminalOpenRequest {
  id: string;
  serverId: string;
  cols: number;
  rows: number;
}

export interface SshTerminalDeps {
  /** Push a batched output chunk for `id` to the renderer. `offset` is the cumulative count of
   *  output chars through the end of this chunk (same scale as the recorder-less shell surfaces). */
  send: (id: string, data: string, offset: number) => void;
  /** Session ended. exitCode is nominal (0); the renderer branches on `reason`, not the code. */
  notifyExit: (
    id: string,
    exitCode: number,
    reason: "dropped" | "ended",
  ) => void;
  /** On a LIVE pooled client: open one interactive shell window, callback-async, EXACTLY ONE cb
   *  per call. A not-connected server (no live client to borrow), a pool whose client can't open
   *  channels, or a channel refused by the host all err the callback — the session then ends
   *  "ended" like a shell that exited before output. */
  openShell: (
    serverId: string,
    window: SshShellWindow,
    cb: (err: Error | null, stream: SshShellStream | null) => void,
  ) => void;
  /** Injected in tests (synchronous passthrough); defaults to the 5ms coalescer. */
  createBufferer?: (flush: (data: string) => void) => DataBufferer;
}

interface SshTerm {
  id: string;
  /** The server this session rides — noteDown matches on it. */
  serverId: string;
  bufferer: DataBufferer;
  stream: SshShellStream | null;
  /** Chars sent to the renderer but not yet acked — the flow-control credit. */
  unacked: number;
  /** Cumulative output chars sent to the renderer — stamped on each chunk as its end offset. */
  out: number;
  paused: boolean;
  /** Set by close(); the channel's late 'close' then records "ended" (a user teardown), never
   *  "dropped". */
  userClosed: boolean;
}

export interface SshTerminalManager {
  open(req: SshTerminalOpenRequest): void;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  ack(id: string, charCount: number): void;
  /** A user teardown of one terminal tab: close the CHANNEL (buffering the "ended" record), never
   *  the pooled client. Raced before the stream arrives → the armed close flag drops the channel
   *  when it does arrive, without recording anything. */
  close(id: string): void;
  /** The pooled connection for one server died — end EVERY session riding it with reason
   *  "dropped". Runs on the pool's onDown, before each dead channel's close event, so the reason
   *  recorded here wins and the late close is absorbed by the gone-from-map guard. */
  noteDown(serverId: string): void;
  /** Window closed / app quit: channels close, nothing is recorded (the renderer is gone). */
  disposeAll(): void;
}

export function createSshTerminalManager(
  deps: SshTerminalDeps,
): SshTerminalManager {
  const createBufferer = deps.createBufferer ?? createDataBufferer;
  const terms = new Map<string, SshTerm>();

  /** Record one end and dispose the sinks. Identity guard: whoever removes the entry first records
   *  the end (noteDown races the channel's own close; the loser no-ops). */
  const endTerm = (
    term: SshTerm,
    exitCode: number,
    reason: "dropped" | "ended",
  ): void => {
    if (terms.get(term.id) !== term) return;
    terms.delete(term.id);
    term.bufferer.dispose();
    deps.notifyExit(term.id, exitCode, reason);
  };

  const armStream = (term: SshTerm, stream: SshShellStream): void => {
    term.stream = stream;
    stream.on("data", (chunk) => {
      if (terms.get(term.id) !== term) return; // torn down; a late chunk goes nowhere
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      term.unacked += data.length;
      if (!term.paused && term.unacked > FLOW.highWaterChars) {
        term.paused = true;
        stream.pause();
      }
      term.bufferer.add(data); // coalesced into the renderer push (no second emulator)
    });
    // The remote shell exited ITSELF (`exit` in the remote shell): always followed by 'close',
    // which would otherwise read as a hard drop.
    let remoteExited = false;
    stream.on("exit", () => {
      remoteExited = true;
    });
    stream.on("close", () => {
      if (terms.get(term.id) !== term) return; // noteDown/close already recorded the end
      endTerm(term, 0, term.userClosed || remoteExited ? "ended" : "dropped");
    });
  };

  return {
    open(req) {
      if (terms.has(req.id)) return; // idempotent, like the pty manager's start()
      const term: SshTerm = {
        id: req.id,
        serverId: req.serverId,
        bufferer: createBufferer((data) => {
          term.out += data.length;
          deps.send(term.id, data, term.out);
        }),
        stream: null,
        unacked: 0,
        out: 0,
        paused: false,
        userClosed: false,
      };
      terms.set(req.id, term);
      deps.openShell(
        req.serverId,
        { term: "xterm-256color", cols: req.cols, rows: req.rows },
        (err, stream) => {
          // Raced teardown (user close / server drop) between open and the stream's arrival:
          // drop the channel without recording END — the close path already owns that story.
          if (terms.get(req.id) !== term) {
            try {
              stream?.close();
            } catch {
              // already dead
            }
            return;
          }
          if (err || !stream) {
            term.bufferer.dispose();
            terms.delete(req.id);
            deps.notifyExit(req.id, 1, "ended");
            return;
          }
          armStream(term, stream);
        },
      );
    },
    write: (id, data) => terms.get(id)?.stream?.write(data),
    resize: (id, cols, rows) => {
      const term = terms.get(id);
      // ssh2's argument order is (rows, cols, height, width); pixel dims stay 0 — the remote pty
      // sizes in cells (the renderer's xterm grid drives everything).
      term?.stream?.setWindow(Math.max(rows, 1), Math.max(cols, 1), 0, 0);
    },
    ack(id, charCount) {
      const term = terms.get(id);
      if (!term) return;
      term.unacked = Math.max(0, term.unacked - charCount);
      // Same resume line as the pty manager: credit drains below the low-water mark → resume.
      if (term.paused && term.unacked < FLOW.lowWaterChars) {
        term.paused = false;
        term.stream?.resume();
      }
    },
    close(id) {
      const term = terms.get(id);
      if (!term) return; // unknown or already gone
      term.userClosed = true;
      terms.delete(term.id);
      term.bufferer.dispose();
      try {
        // Close the CHANNEL outright; the pooled client stays for every other surface.
        term.stream?.close();
      } catch {
        // a dead channel's close is noise; the record above already decided the state
      }
      // A user teardown gets its "ended" record for symmetry with the pty surface's exit push —
      // the initiating renderer has already dropped its handler, so it costs one orphan push at
      // most.
      deps.notifyExit(id, 0, "ended");
    },
    noteDown(serverId) {
      // Snapshot: endTerm re-checks identity, so the natural channel close that follows no-ops.
      for (const term of [...terms.values()]) {
        if (term.serverId === serverId) endTerm(term, 0, "dropped");
      }
    },
    disposeAll: () => {
      for (const term of [...terms.values()]) {
        terms.delete(term.id);
        term.bufferer.dispose();
        try {
          term.stream?.close();
        } catch {
          // dispose phase: nothing left to record
        }
      }
      terms.clear();
    },
  };
}
