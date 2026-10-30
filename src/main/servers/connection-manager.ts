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
import type { Readable } from "node:stream";
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
      /** The dial's timeout, so a late clean-up can't leave a dangling timer. */
      timer?: NodeJS.Timeout;
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
   *  The first of those events wins; later ones are ignored (a post-ready close fires straight
   *  into the pool's evict, not into this promise). */
  const dial = (config: SshConnectConfig): Promise<SshClientRpc> =>
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
      } = { connecting: true, followers: [] };
      pool.set(id, entry);
      lastError.delete(id); // a fresh attempt leaves any sticky error behind
      return dial(built.config).then(
        (rpc) => {
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
          return { ok: false as const, error: message };
        },
      );
    },
    disconnect(id) {
      const entry = pool.get(id);
      evict(id);
      if (!entry?.rpc) return;
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
