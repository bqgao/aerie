/**
 * The real ssh2 wiring for the connection pool — the ONLY module that imports ssh2, so the fake
 * boundary in connection-manager.ts stays the single test seam. Events ride arrow closures (never
 * raw method references — that would hand ssh2 an unbound `this`), and the ConnectConfig argument
 * is bridged with a documented `as never`: ssh2's own ConnectConfig carries extra optional fields
 * the pool's narrowed SshConnectConfig deliberately does not model.
 */
import { Client } from "ssh2";
import type { SshClientFactory, SshClientRpc } from "./connection-manager";

/** The default factory: ssh2.Client over the exact members the pool uses. Returns immediately;
 *  events arrive after connect(). */
export function createSshClientFactory(): SshClientFactory {
  return (config, handlers) => {
    const client = new Client();
    client
      .on("ready", () => handlers.onReady())
      .on("error", (err) => handlers.onError(err))
      .on("close", (hadError: boolean) => handlers.onClose(hadError));
    const rpc: SshClientRpc = {
      connect: (cfg) => client.connect(cfg),
      end: () => client.end(),
      exec: (command, cb) =>
        client.exec(command, (err, stream) => cb(err, stream ?? null)),
    };
    return rpc;
  };
}
