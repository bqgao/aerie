/**
 * Ambient types for `ssh2` — the package ships no bundled `.d.ts`, and the fork adds exactly ONE
 * dependency (ssh2), so the ambient declaration lives here instead of pulling @types/ssh2. It
 * declares ONLY the surface the app uses (src/main/servers/ssh2-factory.ts); anything beyond it
 * stays out on purpose so a future pass must extend this deliberately rather than reaching for
 * `any`. S2 extended it deliberately: `shell()` + the channel's `setWindow`/`close`. F extended
 * it the same way for the file manager: the `SftpClient` class + `EntryAttributes`, following the
 * REAL ssh2 SFTP API (open/read/write/close/readdir/stat/mkdir/rename/unlink/rmdir/realpath;
 * attrs carry numbers + isDirectory/isFile/isSymbolicLink predicates). File IO rides OPEN
 * HANDLES (SFTPv3), not stream helpers, so chunked transfer progress stays exact.
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

  /** The pseudo-terminal request for `shell()` — narrowed to the fields the app sends (ssh2's real
   *  PseudoTerminalOptions is much bigger). The remote pty is the sshd's; it sizes in cells, so the
   *  app sends cols/rows (plus the TERM declaration) and never pixel dims. */
  export interface ShellWindow {
    term?: string;
    cols?: number;
    rows?: number;
  }

  /** ssh2's interactive shell channel: a duplex stream (keyboard in, terminal output out) with the
   *  two Channel-only members the terminal store drives — `setWindow` (resize) and `close` (a user
   *  teardown of one channel without touching the client). `exit` precedes `close` for a REMOTE
   *  shell exit; a hard drop emits only `close`. Extends Duplex so the pool/hook read/write flow
   *  contract is spelled out in the standard stream vocabulary. */
  export interface ShellStream extends Duplex {
    setWindow(rows: number, cols: number, height: number, width: number): void;
    /** Force the channel closed (a shell terminal teardown before the remote shell exits). */
    close(): void;
    on(event: "data", cb: (chunk: Buffer) => void): void;
    on(event: "exit", cb: () => void): void;
    on(event: "close", cb: (err?: Error) => void): void;
  }

  /** The attributes object ssh2 hands back from readdir/stat (a REAL SFTP.EntryAttributes is a
   *  class holding parsed flags; narrowed to the members the file list drives). */
  export interface EntryAttributes {
    mode?: number;
    size: number;
    /** Seconds since epoch (SFTPv3 timestamps are seconds, not ms). */
    mtime: number;
    atime: number;
    uid: number;
    gid: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  /** One sftp readdir row: filename + longname + attrs. */
  export interface FileEntryLike {
    filename: string;
    longname: string;
    attrs: EntryAttributes;
  }

  /** ssh2's SFTP channel, narrowed to the operations the file manager drives. Flags follow
   *  the POSIX open vocabulary ssh2 accepts ("r", "w", "wx", …). read() returns the number of
   *  bytes PLACED IN `buffer` (0 = EOF); write() returns the count accepted. Errors arrive as
   *  `Error`s whose message carries the server's SFTP status text (ENOENT-style), never
   *  structured codes — the service matches message patterns, never ssh2 internals. */
  export class SftpClient {
    open(path: string, flags: string, cb: (err: Error | undefined, handle: unknown) => void): void;
    read(
      handle: unknown,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
      cb: (err: Error | undefined, bytesRead: number, buffer: Buffer, position: number | null) => void,
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
    readdir(path: string, cb: (err: Error | undefined, list: FileEntryLike[]) => void): void;
    stat(path: string, cb: (err: Error | undefined, attrs: EntryAttributes) => void): void;
    mkdir(path: string, cb: (err: Error | undefined) => void): void;
    rename(srcPath: string, destPath: string, cb: (err: Error | undefined) => void): void;
    unlink(filename: string, cb: (err: Error | undefined) => void): void;
    rmdir(path: string, cb: (err: Error | undefined) => void): void;
    realpath(path: string, cb: (err: Error | undefined, abspath: string) => void): void;
    /** Recover one channel cleanly (a client-side teardown that closes open handles). */
    end(): void;
  }

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
    /** Open an interactive shell channel on this client (the SSH terminal rides the SAME pooled
     *  client as exec/forwardOut). `window` is the initial pseudo-terminal request. */
    shell(
      window: ShellWindow | undefined,
      cb: (err: Error | undefined, stream: ShellStream | undefined) => void,
    ): void;
    /** Open the SFTP subsystem channel (pass F) — the SAME pooled client multiplexes it. In
     *  real ssh2 this is `client.sftp(cb)` with cb(err, sftp). */
    sftp(
      cb: (err: Error | undefined, sftp: SftpClient | undefined) => void,
    ): void;
    end(): void;
    on(event: "ready", cb: () => void): this;
    on(event: "error", cb: (err: Error) => void): this;
    on(event: "close", cb: (hadError: boolean) => void): this;
  }
}
