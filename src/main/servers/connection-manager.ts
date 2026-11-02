/**
 * The ssh2 connection pool. One live ssh2 Client per saved profile (pool semantics: a second
 * connect() for a live id returns the existing dial; connecting ids share one in-flight outcome).
 * The renderer POLLs status() — app rule: request/response, no main-side push. This module owns no
 * knowledge of shells, SFTP or forwards: S2/F/R borrow the pooled client via withClient().
 *
 * Every ssh2 object arrives through one injectable factory (SshClientFactory) so unit tests script
 * a fake and run no network. The factory surface (SshClientRpc) mirrors the exact ssh2 Client
 * members used here — the real ssh2 Client satisfies it structurally (see ssh2-factory.ts).
 */
import type { Duplex, Readable } from "node:stream";
import type { ServerProfile, ServerStatusMap } from "@shared/servers";
import { logWarn } from "../log-buffer";

export const CONNECT_TIMEOUT_MS = 10_000;
export const KEEPALIVE_INTERVAL_MS = 15_000;

/** What the manager asks a live ssh2 Client for. ssh2's Client satisfies this structurally. */
export interface SshClientRpc {
  connect(config: SshConnectConfig): void;
  end(): void;
  /** One-shot command; ssh2 hands back its channel (readable + close-evented) or an error. */
  exec(
    command: string,
    cb: (err: Error | undefined, stream: Readable | null) => void,
  ): void;
  /** Open an outbound channel to the remote `opencode serve` port (the Pass R transport): a
   *  full-duplex pipe against the local loopback listener (requests up, answers back). */
  forwardOut(
    srcHost: string,
    srcPort: number,
    dstHost: string,
    dstPort: number,
    cb: (err: Error | undefined, stream: Duplex | null) => void,
  ): void;
  /** S2: open an interactive shell window on the live client — the renderer-side SSH terminal rides
   *  the SAME pooled client the tunnel and execs do. Optional at the seam so a pool-level fake that
   *  never opens channels stays valid (the real factory always provides it); callers guard for its
   *  absence and fail the open in-band. */
  shell?(
    window: SshShellWindow | undefined,
    cb: (err: Error | undefined, stream: SshShellStream | null) => void,
  ): void;
  /** F: open the SFTP subsystem channel on the live client — the file manager's operations ride
   *  the SAME pooled client as shells/tunnels/execs. Optional at the seam (same pattern as
   *  shell): a pool-level fake that never opens subsystem channels stays valid; the real factory
   *  always provides it, and callers guard for absence. */
  sftp?(cb: (err: Error | undefined, sftp: SftpChannel | null) => void): void;
}

/** The shell-window request the ssh terminal sends (narrowed from ssh2's PseudoTerminalOptions):
 *  a TERM declaration plus the first grid. The remote pty sizes in cells; there are no pixel dims. */
export interface SshShellWindow {
  term?: string;
  cols?: number;
  rows?: number;
}

/** The live ssh2 shell channel, narrowed to exactly the members the ssh terminal store drives.
 *  ssh2's real Channel satisfies this structurally (declared in ssh2-types.d.ts's ShellStream).
 *  Resize rides ssh2's argument order (rows, cols, height, width) with pixel dims at 0. */
export interface SshShellStream {
  write(data: string | Buffer | Uint8Array): void;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  /** Read-side flow control: the terminal credit manager pauses the remote stream locally. */
  pause(): void;
  resume(): void;
  /** Half-close (EOF). */
  end(): void;
  /** Force the channel closed (a user teardown of one terminal tab; the pooled client stays). */
  close(): void;
  on(event: "data", cb: (chunk: Buffer | string) => void): void;
  /** The remote shell exiting (user typed `exit`); always precedes a `close` for that path, which
   *  is how a shell exit is told apart from a hard drop (which skips `exit` entirely). */
  on(event: "exit", cb: () => void): void;
  on(event: "close", cb: (err?: Error) => void): void;
}

/** The live SFTP channel, narrowed to exactly the operations the file manager drives (the real
 *  ssh2 SftpClient satisfies this structurally — declared ambient in ssh2-types.d.ts). Handles
 *  are opaque (SFTPv3 file handles); errors arrive as `Error`s whose MESSAGE carries the server's
 *  SFTP status text (e.g. "no such file"), never typed codes — the service matches patterns. */
export interface SftpChannel {
  open(
    path: string,
    flags: string,
    cb: (err: Error | undefined, handle: unknown) => void,
  ): void;
  read(
    handle: unknown,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
    cb: (err: Error | undefined, bytesRead: number) => void,
  ): void;
  write(
    handle: unknown,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
    cb: (err: Error | undefined, written: number) => void,
  ): void;
  close(handle: unknown, cb: (err: Error | undefined) => void): void;
  readdir(
    path: string,
    cb: (err: Error | undefined, list: SftpListEntry[]) => void,
  ): void;
  stat(
    path: string,
    cb: (err: Error | undefined, attrs: SftpAttrs) => void,
  ): void;
  mkdir(path: string, cb: (err: Error | undefined) => void): void;
  rename(
    srcPath: string,
    destPath: string,
    cb: (err: Error | undefined) => void,
  ): void;
  unlink(filename: string, cb: (err: Error | undefined) => void): void;
  rmdir(path: string, cb: (err: Error | undefined) => void): void;
  realpath(
    path: string,
    cb: (err: Error | undefined, abspath: string) => void,
  ): void;
  /** A client-side channel teardown (closes any open handles with "channel closed"-style errors). */
  end(): void;
}

/** readdir row, narrowed from ssh2's FileEntry (filename + attributes; longname is unused). */
export interface SftpListEntry {
  filename: string;
  attrs: SftpAttrs;
}

/** stat/readdir attributes, narrowed from ssh2's EntryAttributes (numbers + the predicates). */
export interface SftpAttrs {
  mode?: number;
  size: number;
  /** SECONDS since epoch — SFTPv3 timestamps are seconds; convert to ms host-side. */
  mtime: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** The dial-time config, narrowed to the exact fields this pool sets (ssh2's ConnectConfig is
 *  much bigger; the narrowing documents the contract and keeps the fake simple). */
export interface SshConnectConfig {
  host: string;
  port: number;
  username: string;
  readyTimeout: number;
  keepaliveInterval: number;
  keepaliveCountMax: number;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** agent mode: the SSH_AUTH_SOCK path (the only agent wiring). */
  agent?: string;
}

export type SshClientFactory = (
  config: SshConnectConfig,
  handlers: {
    onReady(): void;
    onError(err: Error): void;
    onClose(hadError: boolean): void;
    /** Post-ready lifecycle sink: at most ONE call per client, from the first 'error'/'close'
     *  AFTER ready (the error's message when ssh2 emitted one, null for a clean close). A client
     *  whose factory hands this never routes post-ready traffic back into the dial-phase
     *  handlers — that's exactly the silent-dead-connection defect this seam exists to close.
     *  Optional so a fake can omit it (test() does — the probe's own timeout arbitrates). */
    onDown?(err: Error | null): void;
  },
) => SshClientRpc;

export interface SshDeps {
  /** The safe half: profiles by id. */
  profileOf(id: string): ServerProfile | undefined;
  /** The secret half: decrypted credentials (null = none stored). */
  credentialsOf(id: string): { password?: string; passphrase?: string } | null;
  sshFactory: SshClientFactory;
  /** Stamps a successful handshake into the profile registry. */
  onConnected(id: string, atMs: number): void;
  /** Notified whenever this id stops having ANY live connection: a post-ready drop, a user
   *  disconnect, or a failed dial (idempotent — transport teardown rides this seam, so a dead
   *  pooled connection kills its tunnel with it, not just the SSH leg). */
  onDown?(id: string): void;
  now?: () => number;
  /** key-mode key files. Default: the real fs, reading the key FRESH at every dial — a rotated
   *  key file applies without re-saving the profile. */
  readKeyFile?(path: string): string | null;
}

export interface ConnectionManager {
  /** Dial (pool semantics apply). Resolves after ready; failures surface via status()'s error. */
  connect(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  disconnect(id: string): void;
  status(): ServerStatusMap;
  /** The reserved seam for S2/F/R: run fn against the live handle (null = not connected). */
  withClient<T>(id: string, fn: (rpc: SshClientRpc) => T): T | null;
  /** Dial once with raw values (never touches pool or stores), exec `echo ok`, close. */
  test(input: {
    host: string;
    port: number;
    username: string;
    authMode: ServerProfile["authMode"];
    keyPath?: string;
    password?: string;
    passphrase?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
}

export function createConnectionManager(deps: SshDeps): ConnectionManager {
  const now = deps.now ?? ((): number => Date.now());
  // profileId → in-flight/live bookkeeping. An entry WITHOUT rpc and with connecting=false does
  // not exist — the pool holds entries only while a dial is in flight or a connection is live.
  const pool = new Map<
    string,
    {
      rpc?: SshClientRpc;
      connecting?: boolean;
      /** A second connect() while the first dial is in flight attaches to its outcome. */
      followers?: Array<{ ok(): void; fail(err: Error): void }>;
      /** Set by disconnect() before end(): the close ssh2 then fires routes through onDown, which
       *  checks this flag so a user teardown reads offline (no error), not as a remote drop. */
      userEnded?: boolean;
    }
  >();
  // Remembered per-profile lastError — sticky BY DESIGN: the error must stay visible in the row
  // after the socket dies (which is exactly when the pool entry evicts), until the next attempt
  // clears it. Never carries credentials.
  const lastError = new Map<string, string>();

  const status = (): ServerStatusMap => {
    const out: ServerStatusMap = {};
    for (const [id, entry] of pool) {
      out[id] = {
        status: entry.rpc ? ("connected" as const) : ("connecting" as const),
      };
    }
    for (const [id, error] of lastError) {
      if (!out[id]) out[id] = { status: "error", lastError: error };
    }
    return out;
  };

  /** Clear one profile's runtime traces: drop the pool entry (the socket, if any, is ended by the
   *  callers whose transitions this serves) and remove error stickiness — `keepError` keeps the
   *  row's last error visible after a FAILED dial evicts itself. */
  const evict = (id: string, keepError = false): void => {
    pool.delete(id);
    if (!keepError) lastError.delete(id);
  };

  /** The post-ready drop record: a LIVE connection died (ssh2 'error'/'close' after ready).
   *  Evicts so withClient() can never hand out a dead client, and leaves the drop reason sticky
   *  so the settings row shows WHY the lamp went red — until the next connect attempt clears it.
   *  A user-initiated disconnect takes precedence (its entry is flagged before end()): offline,
   *  not an error. `onDown` fires at most once per client (the factory dedupes), but the
   *  entry-identity guard below also absorbs races with a newer dial for the same id. */
  const markDown = (
    id: string,
    entry: { userEnded?: boolean; followers?: unknown[] },
    err: Error | null,
  ): void => {
    if (entry.userEnded) return; // user-initiated teardown → handled by disconnect's evict
    if (pool.get(id) !== entry) return; // evicted already (or superseded by a re-dial)
    pool.delete(id);
    lastError.set(id, err ? err.message : "The connection dropped.");
    deps.onDown?.(id); // transport teardown rides the same evict
  };

  /** Auth-material resolution shared by pool-connect and test: plain field checks, one failure
   *  string per mode (the renderer surfaces it verbatim in the row). */
  const buildConfig = (
    profile: {
      host: string;
      port: number;
      username: string;
      authMode: ServerProfile["authMode"];
      keyPath?: string;
    },
    creds: { password?: string; passphrase?: string } | null,
  ): { ok: true; config: SshConnectConfig } | { ok: false; error: string } => {
    const config: SshConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: 3,
    };
    if (profile.authMode === "password") {
      if (!creds?.password)
        return { ok: false, error: "No password stored for this profile." };
      config.password = creds.password;
    } else if (profile.authMode === "key") {
      if (!profile.keyPath) return { ok: false, error: "No key file set." };
      const key = deps.readKeyFile
        ? deps.readKeyFile(profile.keyPath)
        : readKeyFromDisk(profile.keyPath);
      if (!key)
        return {
          ok: false,
          error: `Couldn't read the key file (${profile.keyPath}).`,
        };
      config.privateKey = key;
      if (creds?.passphrase) config.passphrase = creds.passphrase;
    } else {
      if (!process.env.SSH_AUTH_SOCK)
        return {
          ok: false,
          error: "SSH_AUTH_SOCK is not set — no agent to authenticate with.",
        };
      config.agent = process.env.SSH_AUTH_SOCK;
    }
    return { ok: true, config };
  };

  /** One dial shared by connect() and test(): resolve on ready, reject on error/close/timeout.
   *  The first of those events wins; post-ready movement routes to `onDown` (the pool's drop
   *  record for connect(), a no-op for test(), whose probe timeout arbitrates). */
  const dial = (
    config: SshConnectConfig,
    onDown?: (err: Error | null) => void,
  ): Promise<SshClientRpc> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`),
        );
      }, CONNECT_TIMEOUT_MS);
      let rpc: SshClientRpc | null = null;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      rpc = deps.sshFactory(config, {
        onReady: () => finish(() => resolve(rpc as SshClientRpc)),
        onError: (err) => finish(() => reject(err)),
        // hadError distinguishes "we errored first" (covered by onError) from a clean exit.
        onClose: (hadError) =>
          finish(() =>
            reject(
              new Error(
                hadError
                  ? "The connection failed."
                  : "The host closed the connection.",
              ),
            ),
          ),
        onDown,
      });
      rpc.connect(config);
    });

  return {
    connect(id) {
      const profile = deps.profileOf(id);
      if (!profile)
        return Promise.resolve({
          ok: false as const,
          error: "Unknown profile.",
        });
      const existing = pool.get(id);
      if (existing?.rpc) return Promise.resolve({ ok: true as const });
      if (existing?.connecting) {
        // Pool, don't double-dial: two ssh2 handshakes to one host would both "win".
        return new Promise((resolve) => {
          existing.followers!.push({
            ok: () => resolve({ ok: true as const }),
            fail: (err) => resolve({ ok: false as const, error: err.message }),
          });
        });
      }
      const built = buildConfig(profile, deps.credentialsOf(id));
      if (!built.ok) {
        lastError.set(id, built.error);
        return Promise.resolve({ ok: false as const, error: built.error });
      }
      const entry: {
        rpc?: SshClientRpc;
        connecting?: boolean;
        followers?: Array<{ ok(): void; fail(err: Error): void }>;
        /** Set by disconnect() BEFORE end(): the late 'close' that follows must read as
         *  user-initiated offline, never as a remote drop carrying an error. */
        userEnded?: boolean;
      } = { connecting: true, followers: [] };
      pool.set(id, entry);
      lastError.delete(id); // a fresh attempt leaves any sticky error behind
      return dial(built.config, (downErr) => markDown(id, entry, downErr)).then(
        (rpc) => {
          // Defensive gap-closer: a synthetic factory can fire ready + down in one tick, dropping
          // the entry before this mount runs. Ending the socket and surfacing the recorded error
          // keeps the pool's invariants (no rpc without a live entry) intact.
          if (pool.get(id) !== entry) {
            try {
              rpc.end();
            } catch {
              // drop-already-recorded: the stub never made it into the pool
            }
            return {
              ok: false as const,
              error: lastError.get(id) ?? "The connection dropped.",
            };
          }
          entry.rpc = rpc;
          entry.connecting = false;
          deps.onConnected(id, now());
          for (const f of entry.followers ?? []) f.ok();
          return { ok: true as const };
        },
        (err: unknown) => {
          evict(id, true); // dead → evicted; the sticky error keeps the row honest
          const message =
            err instanceof Error ? err.message : "Connection failed.";
          lastError.set(id, message);
          for (const f of entry.followers ?? []) f.fail(err as Error);
          deps.onDown?.(id); // a re-dial refusal also tears whatever older tunnel might exist
          return { ok: false as const, error: message };
        },
      );
    },
    disconnect(id) {
      const entry = pool.get(id);
      evict(id);
      // Notify BEFORE the rpc access: the transport tears down whether or not a live client
      // ever existed (a rejected dial's tunnel is dead the moment the pool evicts).
      deps.onDown?.(id);
      if (!entry?.rpc) return;
      // Flag BEFORE end(): the 'close' ssh2 then fires must read as user-initiated offline,
      // not as a remote drop (markDown checks the flag through its closure).
      entry.userEnded = true;
      try {
        entry.rpc.end();
      } catch {
        // end() on an already-dead socket is noise; the eviction already decided the state.
        logWarn("ssh-disconnect-error");
      }
    },
    status,
    withClient(id, fn) {
      const rpc = pool.get(id)?.rpc;
      return rpc ? fn(rpc) : null;
    },
    async test(input) {
      const built = buildConfig(
        {
          host: input.host,
          port: input.port,
          username: input.username,
          authMode: input.authMode,
          keyPath: input.keyPath,
        },
        { password: input.password, passphrase: input.passphrase },
      );
      if (!built.ok) return { ok: false as const, error: built.error };
      let rpc: SshClientRpc;
      try {
        rpc = await dial(built.config);
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : "Connection failed.",
        };
      }
      try {
        // Dial won; exec `echo ok` and require that exact sentence back.
        const probe = await new Promise<{ ok: boolean; error: string }>(
          (arbitrate) => {
            const probeTimer = setTimeout(
              () =>
                arbitrate({ ok: false, error: "The test command timed out." }),
              CONNECT_TIMEOUT_MS,
            );
            rpc.exec("echo ok", (err, stream) => {
              if (err) {
                clearTimeout(probeTimer);
                return arbitrate({ ok: false, error: err.message });
              }
              let out = "";
              stream?.on("data", (c: Buffer | string) => {
                out += String(c);
              });
              stream?.on("close", () => {
                clearTimeout(probeTimer);
                arbitrate(
                  out.trim() === "ok"
                    ? { ok: true, error: "" }
                    : {
                        ok: false,
                        error: "The test ran but `echo ok` did not come back.",
                      },
                );
              });
            });
          },
        );
        return probe.ok
          ? { ok: true as const }
          : { ok: false as const, error: probe.error };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : "The test failed.",
        };
      } finally {
        try {
          rpc.end();
        } catch {
          // cleanup-only — the dial already succeeded
        }
      }
    },
  };
}

/** The real fs key read (its own function so deps.readKeyFile can override cleanly in tests). */
import { readFileSync } from "node:fs";
function readKeyFromDisk(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
