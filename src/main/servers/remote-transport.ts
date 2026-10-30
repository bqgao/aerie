/**
 * The Pass R SSH-remote transport: per-opencode-profile loopback tunnel over the S1 pool, plus
 * the TTL-cached serve health probe surfaced in the server's status record.
 *
 * Architecture (matches OPENCODE_REMOTE_DESIGN.md + SSH_REMOTE_SPEC.md):
 *  - One tunnel per profile: a net.Server on an ephemeral 127.0.0.1 port; every incoming socket
 *    opens an ssh2 direct-tcpip channel (`forwardOut`) to the remote serve port and pipes both
 *    ways. `directUrl` profiles skip the tunnel entirely (Tailscale/LAN deployments).
 *  - Teardown rides the S1 onDown seam: the pool notifies per drop / user disconnect / dial
 *    refusal, and the transport closes the listener with the SSH leg — no half-lived tunnels.
 *  - The health probe is a plain GET /api/info with the Basic `opencode:<password>` header
 *    (verified live contract), cached ~20s so the status poll never re-probes per render.
 *
 * No timers: probes fire lazily on the status/read path (TTL-coalesced, one in-flight probe per
 * window); teardown runs synchronously from the pool's event. The module never touches credential
 * files — the password arrives via deps.
 */
import * as net from "node:net";
import type { OpencodeHealth, ServerProfile } from "@shared/servers";
import type { ConnectionManager, SshClientRpc } from "./connection-manager";

const HEALTH_TTL_MS = 20_000;
const OPENCODE_REQUEST_TIMEOUT_MS = 2_000;

export interface RemoteTransport {
  /** Ensure the serve is reachable for this profile: a live tunnel (or the direct URL).
   *  `onDemand` lets caller-driven flows (Connect/Test/Resume gate) DIAL the SSH leg even for
   *  non-autoTunnel profiles; the provider's read path omits it so a background poll never
   *  dials a connection the user didn't ask for. */
  ensure(
    serverId: string,
    opts?: { onDemand?: boolean },
  ): Promise<
    | { ok: true; baseUrl: string; tunnel: boolean }
    | { ok: false; error: string }
  >;
  /** Close this profile's tunnel listener (called with the pool's onDown — idempotent). */
  teardown(serverId: string): void;
  /** The serve API health, TTL-cached; a Promise because the first probe rides the wire (and a
   *  tunnel ensure). Null when the profile hosts no serve. */
  health(serverId: string): Promise<OpencodeHealth | null>;
  /** Borrow the resolved transport (base URL + serve password) for one opencode API pass — the
   *  S1 withClient pattern one layer up. Null when the profile has no serve or isn't reachable. */
  withTransport<T>(
    serverId: string,
    fn: (t: { baseUrl: string; password: string | null }) => Promise<T>,
  ): Promise<T | null>;
}

export interface RemoteTransportDeps {
  /** The one S1 pool: connect/withClient (borrowed); teardown from its onDown seam. */
  manager: ConnectionManager;
  profileOf(id: string): ServerProfile | undefined;
  opencodePasswordOf(id: string): string | null;
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

/** One tunnel bookkeeping record per profile with an opencode section (no direct URL). */
interface Tunnel {
  server: net.Server;
  localPort: number;
}

/** The Basic header contract, verified live: fixed username `opencode`, the serve password as
 *  the Basic password; absent/wrong → 401 on every endpoint including /api/info. */
export function opencodeAuthHeader(
  password: string | null,
): Record<string, string> {
  if (!password) return {};
  const token = Buffer.from(`opencode:${password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

/** One uncached probe: GET <base>/api/info, 2s timeout; the detail never carries secrets. */
async function probeOnce(
  base: string,
  password: string | null,
  fetchFn: RemoteTransportDeps["fetchFn"],
): Promise<OpencodeHealth> {
  try {
    const res = await fetchFn(`${base}/api/info`, {
      headers: { Accept: "application/json", ...opencodeAuthHeader(password) },
      signal: AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return { state: "ok" };
    return {
      state: "down",
      detail:
        res.status === 401
          ? "The serve requires a password (or refuses this one)."
          : `The serve answered HTTP ${res.status}.`,
    };
  } catch (err) {
    return {
      state: "down",
      detail: err instanceof Error ? err.message : "The serve is unreachable.",
    };
  }
}

/** SshClientRpc alias for the borrow sites below (the interface lives in connection-manager). */
type PoolRpc = SshClientRpc;

export function createRemoteTransport(
  deps: RemoteTransportDeps,
): RemoteTransport {
  const now = deps.now ?? ((): number => Date.now());

  const tunnels = new Map<string, Tunnel>();
  const healthCache = new Map<
    string,
    {
      atMs: number;
      result: OpencodeHealth | null;
      /** The in-flight probe a same-window poll joins (never left dangling for the caller). */
      inflight?: Promise<OpencodeHealth | null>;
    }
  >();

  const sectionOf = (serverId: string): ServerProfile["opencode"] | undefined =>
    deps.profileOf(serverId)?.opencode;

  const ensure = (
    serverId: string,
    opts?: { onDemand?: boolean },
  ): Promise<
    | { ok: true; baseUrl: string; tunnel: boolean }
    | { ok: false; error: string }
  > => {
    const section = sectionOf(serverId);
    if (!section)
      return Promise.resolve({
        ok: false as const,
        error: "This server does not host OpenCode.",
      });
    if (section.directUrl)
      return Promise.resolve({
        ok: true as const,
        baseUrl: section.directUrl.replace(/\/+$/, ""),
        tunnel: false,
      });
    // The tunnel rides the SSH leg. Background (non-onDemand) policy: borrow an EXISTING live
    // connection; new dials only for autoTunnel profiles or on-demand flows (Connect/Resume).
    const onDemand = opts?.onDemand ?? false;
    const dialable = section.autoTunnel || onDemand;
    if (!dialable && !deps.manager.withClient(serverId, () => true))
      return Promise.resolve({
        ok: false as const,
        error: "The connection is not live.",
      });
    return deps.manager.connect(serverId).then((r) => {
      if (!r.ok) return { ok: false as const, error: r.error };
      const existing = tunnels.get(serverId);
      if (existing)
        return Promise.resolve({
          ok: true as const,
          baseUrl: `http://127.0.0.1:${existing.localPort}`,
          tunnel: true,
        });
      // One listener per profile; every accepted socket borrows the pooled client for its OWN
      // direct-tcpip channel. A borrowed-null (the leg died mid-accept) destroys the caller's
      // socket — the next ensure() re-tunnels.
      const servePort = section.servePort;
      const server = net.createServer((socket) => {
        const borrowed = deps.manager.withClient(
          serverId,
          (rpc: PoolRpc) => rpc,
        );
        if (!borrowed) {
          socket.destroy();
          return;
        }
        borrowed.forwardOut(
          "127.0.0.1",
          0,
          "127.0.0.1",
          servePort,
          (err, stream) => {
            if (err || !stream) {
              socket.destroy();
              return;
            }
            // Both ways at once: requests ride up, answers ride back. Checking the pipe return
            // keeps TS's stream-typing happy; the raw duplex pair is what actually flows.
            socket.pipe(stream);
            stream.pipe(socket);
            const die = (): void => {
              socket.destroy();
              stream.destroy?.();
            };
            socket.on("error", die);
            socket.on("close", die);
            stream.on?.("error", die);
          },
        );
      });
      return new Promise((resolve) => {
        server.once("error", (err) => {
          resolve({
            ok: false as const,
            error: `Tunnel listener: ${err.message}`,
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          const localPort =
            typeof addr === "object" && addr !== null ? addr.port : 0;
          tunnels.set(serverId, { server, localPort });
          resolve({
            ok: true as const,
            baseUrl: `http://127.0.0.1:${localPort}`,
            tunnel: true,
          });
        });
      });
    });
  };

  const teardown = (serverId: string): void => {
    const t = tunnels.get(serverId);
    if (!t) return;
    tunnels.delete(serverId);
    try {
      t.server.close();
    } catch {
      // a closed listener is noise; the map entry is the state of record
    }
    // The cached health was measured against a now-dead transport — drop it so the next poll
    // re-probes instead of serving a stale ok from the previous tunnel port.
    healthCache.delete(serverId);
  };

  const health = (serverId: string): Promise<OpencodeHealth | null> => {
    if (!sectionOf(serverId)) return Promise.resolve(null);
    const cached = healthCache.get(serverId);
    if (cached && now() - cached.atMs < HEALTH_TTL_MS) {
      // Same-window poll: join the in-flight probe (it settles the cache when done), or the
      // cached result — a single fetch per TTL window regardless of poll pressure.
      if (cached.inflight) return cached.inflight;
      return Promise.resolve(cached.result);
    }
    const result = ensure(serverId)
      .then((r) => {
        if (!r.ok) return { state: "down" as const, detail: r.error };
        return probeOnce(
          r.baseUrl,
          deps.opencodePasswordOf(serverId),
          deps.fetchFn,
        );
      })
      .catch(
        (err: unknown): OpencodeHealth => ({
          state: "down",
          detail: err instanceof Error ? err.message : "unreachable",
        }),
      );
    const health = result.then<OpencodeHealth | null>((h) => h);
    healthCache.set(serverId, { atMs: now(), result: null, inflight: result });
    // When the probe settles it fills the cache record (the TTL read path swaps the promise out).
    void result.then((h) => {
      const entry = healthCache.get(serverId);
      if (entry) {
        entry.result = h;
        entry.inflight = undefined;
      }
    });
    return health;
  };

  return {
    ensure,
    teardown,
    health,
    withTransport: (serverId, fn) =>
      ensure(serverId).then((r) =>
        r.ok
          ? fn({
              baseUrl: r.baseUrl,
              password: deps.opencodePasswordOf(serverId),
            })
          : null,
      ),
  };
}
