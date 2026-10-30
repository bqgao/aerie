import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { toSpawnForm } from "../../terminal/command";
import { findOnPath, isExecutableFile } from "../../terminal/shell-command";
import { asRecord } from "../codex/rollout";

/** Re-discovery throttle: a failed resolve may be re-attempted at most once per minute — the
 *  background service doesn't flicker faster than that, and every failed resolve costs a CLI
 *  spawn. A resolve that SUCCEEDS caches until invalidate() is called by the client on a
 *  connection failure (which un-throttles immediately: a dead URL must be replaced now, not in
 *  a minute). */
export const OPENCODE_REDISCOVERY_INTERVAL_MS = 60_000;

/** Timeout for one `opencode service …` CLI spawn — a healthy CLI answers in a few ms; a wedged
 *  PATH-shell spawn must not stall the session sweep. */
export const OPENCODE_STATUS_TIMEOUT_MS = 5_000;

export interface OpenCodeServiceEndpoint {
  /** The background service base URL, no trailing slash — e.g. `http://127.0.0.1:49374`. */
  baseUrl: string;
  /** HTTP Basic password for the API, read from the CLI's own service.json (verified live: the
   *  v2.0.28 CLI authenticates with Basic auth over this password; unauthenticated requests get
   *  401). Null when the CLI hasn't minted one. */
  password: string | null;
}

/** The first `http(s)://…` in `opencode service status`'s output, else null. Tolerant to prefix
 *  prose and future fields: the URL is the only thing this output contractually carries. */
export function parseServiceStatus(stdout: string): string | null {
  const m = /https?:\/\/\S+/.exec(stdout);
  return m ? m[0].replace(/[.,;]+$/, "").replace(/\/+$/, "") : null;
}

/** READ-ONLY view of the CLI's service.json (same read-only precedent as codex's readCodexAuth):
 *  where OpenCode keeps the background service's password. Null for absent/malformed files — the
 *  caller then sends no auth and gets the service's own 401, handled as a failed resolve. */
export function readServicePassword(configDir: string): string | null {
  try {
    const parsed = asRecord(
      JSON.parse(readFileSync(join(configDir, "service.json"), "utf8")),
    );
    const password = parsed?.password;
    return typeof password === "string" && password ? password : null;
  } catch {
    return null;
  }
}

/** One-shot `opencode <args>` run through the same login-shell/PATHEXT spawn form every other CLI
 *  spawn in this app uses, stdout-captured, bounded by timeoutMs. Resolves null on any spawn
 *  failure (missing binary, timeout, shell exit) — resolution is best-effort by design. */
export type OpenCodeCliSpawn = (
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string } | null>;

function realCliSpawn(platform: NodeJS.Platform): OpenCodeCliSpawn {
  return (args, timeoutMs) => {
    let cmd;
    try {
      cmd = toSpawnForm(
        { file: "opencode", args },
        platform,
        platform === "win32"
          ? undefined
          : {
              env: process.env,
              isExecutable: isExecutableFile,
              findOnPath: (name) => findOnPath(name, process.env),
            },
      );
    } catch {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let out = "";
      const child = spawn(cmd.file, cmd.args, {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already dead
        }
        resolve(null);
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string | Buffer) => {
        out += String(d);
      });
      // exit code 0 is what matters; a non-zero status output is treated the same as a failure
      // (no running service) below, so the code is carried for exactly that check.
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: out });
      });
    });
  };
}

export interface ServiceDiscovery {
  /** The endpoint to talk to, or null while the service can't be reached — the provider's inert
   *  mode (empty candidates, `absent` reads). Concurrent callers share one in-flight spawn. */
  resolve(): Promise<OpenCodeServiceEndpoint | null>;
  /** Drop the cached endpoint after a connection failure. Un-throttles the next resolve: a dead
   *  URL must be re-discovered on the next read, not a minute later. */
  invalidate(): void;
}

export interface ServiceDiscoveryDeps {
  /** The CLI's config dir (holds service.json). Default resolves like the CLI does. */
  configDir?: string;
  now?: () => number;
  spawnFn?: OpenCodeCliSpawn;
}

/** OpenCode's config dir: OPENCODE_CONFIG_DIR on top, else the CLI's own well-known path
 *  (~/.config/opencode — OpenCode reads XDG_CONFIG_HOME/opencode and falls back to ~/.config on
 *  every platform, including Windows). */
export function resolveOpencodeConfigDir(
  env: NodeJS.ProcessEnv | undefined,
): string {
  const override = env?.OPENCODE_CONFIG_DIR;
  if (override) return override;
  return join(env?.HOME ?? "", ".config", "opencode");
}

/**
 * Base-URL discovery for the v2 background service. One `opencode service status` spawn, cached;
 * when that hits no running service, `opencode service start` fires ONCE per process (the service
 * persists once started — respawning it forever would be a startup bomb), then status is retried
 * once; beyond that resolve() stays null (the provider is inert) until the throttle elapses.
 */
export function createServiceDiscovery(
  deps: ServiceDiscoveryDeps = {},
): ServiceDiscovery {
  const now = deps.now ?? ((): number => Date.now());
  const configDir = deps.configDir ?? resolveOpencodeConfigDir(process.env);
  const spawnFn = deps.spawnFn ?? realCliSpawn(process.platform);
  let cached: OpenCodeServiceEndpoint | null = null;
  let lastFailureMs = -Infinity;
  let startAttempted = false;
  let inFlight: Promise<OpenCodeServiceEndpoint | null> | null = null;

  const runStatus = (): Promise<{
    code: number | null;
    stdout: string;
  } | null> => spawnFn(["service", "status"], OPENCODE_STATUS_TIMEOUT_MS);

  const attemptResolve = async (): Promise<OpenCodeServiceEndpoint | null> => {
    let status = await runStatus();
    const url = status?.code === 0 ? parseServiceStatus(status.stdout) : null;
    if (!url && !startAttempted) {
      startAttempted = true;
      await spawnFn(["service", "start"], OPENCODE_STATUS_TIMEOUT_MS);
      status = await runStatus();
    }
    if (status?.code !== 0) return null;
    const baseUrl = parseServiceStatus(status.stdout);
    if (!baseUrl) return null;
    return { baseUrl, password: readServicePassword(configDir) };
  };

  return {
    resolve(): Promise<OpenCodeServiceEndpoint | null> {
      if (cached) return Promise.resolve(cached);
      if (inFlight) return inFlight;
      if (now() - lastFailureMs < OPENCODE_REDISCOVERY_INTERVAL_MS)
        return Promise.resolve(null);
      inFlight = attemptResolve()
        .then((endpoint) => {
          cached = endpoint;
          if (!endpoint) lastFailureMs = now();
          return endpoint;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    invalidate(): void {
      // Un-throttle unconditionally: the caller failed a live read against whatever this resolver
      // had (or had nothing) — the next read must re-discover NOW, not after the 60s window.
      cached = null;
      inFlight = null;
      lastFailureMs = -Infinity;
      startAttempted = false;
    },
  };
}
