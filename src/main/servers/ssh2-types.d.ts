/**
 * Ambient types for `ssh2` — the package ships no bundled `.d.ts`, and the fork adds exactly ONE
 * dependency (ssh2), so the ambient declaration lives here instead of pulling @types/ssh2. It
 * declares ONLY the surface the app uses (src/main/servers/ssh2-factory.ts); anything beyond it
 * stays out on purpose so a future pass must extend this deliberately rather than reaching for
 * `any`.
 */
declare module "ssh2" {
  import type { Duplex, Readable } from "node:stream";

  export interface ConnectConfig {
    host: string;
    port: number;
    username: string;
    readyTimeout?: number;
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    /** path to the SSH_AUTH_SOCK agent (the only agent wiring used). */
    agent?: string;
    tryKeyboard?: boolean;
  }

  /** ssh2's exec channel: a readable stream carrying stdout chunks and close events. ssh2's real
   *  value is its duplex Channel; the intersection keeps it compatible with Readable consumers. */
  export type ExecStream = Readable & {
    on(event: "close", cb: () => void): void;
    on(event: "data", cb: (chunk: Buffer) => void): void;
  };

  export class Client {
    constructor();
    connect(config: ConnectConfig): void;
    exec(
      command: string,
      cb: (err: Error | undefined, stream: ExecStream | undefined) => void,
    ): void;
    /** The outbound tunnel channel for remote opencode serve (Pass R): a duplex pipe like a TCP
     *  socket, one per forwarded connection. */
    forwardOut(
      srcHost: string,
      srcPort: number,
      dstHost: string,
      dstPort: number,
      cb: (err: Error | undefined, stream: Duplex | undefined) => void,
    ): void;
    end(): void;
    on(event: "ready", cb: () => void): this;
    on(event: "error", cb: (err: Error) => void): this;
    on(event: "close", cb: (hadError: boolean) => void): this;
  }
}
