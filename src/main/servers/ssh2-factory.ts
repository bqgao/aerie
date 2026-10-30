/**
 * The real ssh2 wiring for the connection pool — the ONLY module that imports ssh2, so the fake
 * boundary in connection-manager.ts stays the single test seam. Events ride arrow closures (never
 * raw method references — that would hand ssh2 an unbound `this`), and the `as never` ConnectConfig
 * bridge is documented at its use site below: ssh2's own ConnectConfig carries extra optional
 * fields the pool's narrowed SshConnectConfig deliberately does not model.
 */
import { Client } from "ssh2";
import type { SshClientFactory, SshClientRpc } from "./connection-manager";

/** The default factory: ssh2.Client over the exact members the pool uses. Returns immediately;
 *  events arrive after connect().
 *
 * Lifecycle routing (the seam the pool relies on): every event is classified by a per-client
 * `ready` flag. 'error'/'close' BEFORE ready are dial-phase (onError / onClose, which decide the
 * dial's promise); AFTER ready they are at most ONE onDown(err) — ssh2's 'error' message when one
 * fired, null for a clean close — and anything later is swallowed, so the pool can never
 * double-count one physical drop. */
export function createSshClientFactory(): SshClientFactory {
  return (config, handlers) => {
    const client = new Client();
    let ready = false;
    let down = false;
    let readyPhaseError: Error | null = null;
    const reportDownOnce = (err: Error | null): void => {
      if (down) return; // one physical drop, one onDown — 'error' then 'close' is normal ssh2
      down = true;
      handlers.onDown?.(err);
    };
    client
      .on("ready", () => {
        ready = true;
        handlers.onReady();
      })
      .on("error", (err) => {
        if (!ready) {
          handlers.onError(err);
          return;
        }
        readyPhaseError = err; // ssh2's error message is the informative one
        reportDownOnce(err);
      })
      .on("close", (hadError: boolean) => {
        // The dial-phase close contract stays as it was (hadError distinguishes loud exits);
        // post-ready, the error variant already carried the message, so close adds nothing.
        if (!ready) {
          handlers.onClose(hadError);
          return;
        }
        reportDownOnce(readyPhaseError);
      });
    const rpc: SshClientRpc = {
      connect: (cfg) => client.connect(cfg),
      end: () => client.end(),
      exec: (command, cb) =>
        client.exec(command, (err, stream) => cb(err, stream ?? null)),
    };
    return rpc;
  };
}
