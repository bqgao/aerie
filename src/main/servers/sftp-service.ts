/**
 * The SFTP session service (pass F). ONE sftp channel per saved server (the "one channel per
 * pane context" design note), opened lazily on the first operation through the pool's `sftp()`
 * seam, cached per server and evicted on any channel-level failure — the next op opens a fresh
 * channel over the SAME pooled TCP connection (never a second connection, never an sftp/scp
 * CLI). SFTP requests multiplex over one channel, so a big transfer running while a `list`
 * answers is normal, not contention: each transfer runs its own sequential chunk loop (one
 * page in flight per transfer), which keeps per-transfer progress exact.
 *
 * Every operation is never-reject (in-band {ok:false,error}); input is re-shaped through
 * `sftp-paths.ts` (the only remote-path builder; NUL and traversal rejected). Transfers live in
 * a registry exposed as a pollable snapshot plus a coalesced microtask push per progress tick
 * (DESIGN_NOTES F note 3 — the app's polling rule bends once, for transfer progress). A pooled
 * drop (`noteDown`) fails every active transfer of that server with a typed reason (the
 * renderer reads it as failed-with-Retry); a user cancel removes the partial local file (the
 * F.1 stale-temp trap, which exists for drag-OUT only — this Download path never stages temps).
 * Recursive DELETE collects per-child errors instead of exploding; transfers are FILES-ONLY in
 * this pass (drop/paste of a directory answers a failure row instead).
 */
import * as nodeFs from "node:fs";
import type {
  ConnectionManager,
  SftpAttrs,
  SftpChannel,
  SftpListEntry,
} from "./connection-manager";
import {
  joinRemote,
  normalizeRemotePath,
  remoteBasename,
} from "./sftp-paths";
import type {
  SftpDeleteResult,
  SftpEntry,
  SftpFailure,
  SftpListResult,
  SftpOk,
  SftpStatResult,
  SftpTransfer,
  SftpTransferSnapshot,
} from "@shared/sftp";

/** The chunked-transfer page (SFTPv3 packets are ≤32KiB; 256KiB amortizes round trips). */
export const SFTP_CHUNK_BYTES = 256 * 1024;

/** The local-filesystem half of the two cross-boundary transfers (upload/download), narrowed
 *  so tests can stand in an in-memory fake instead of touching the real disk. */
export interface LocalIo {
  statSize(path: string): number | null;
  existsPath(path: string): boolean;
  rmFile(path: string): void;
  /** A truncating local writer ("w" semantics). abort() destroys AND removes the partial. */
  writer(path: string): {
    write(chunk: Buffer): Promise<void>;
    finish(): Promise<void>;
    abort(): Promise<void>;
  };
  /** A local fd pager (null = the file can't be opened). */
  reader(
    path: string,
  ): {
    size: number;
    read(buffer: Buffer, position: number): Promise<number>;
    close(): void;
  } | null;
}

/** The real LocalIo over node:fs. Writers await-drain each page (bounded memory over huge
 *  files); readers hold one fd so every page lands at an exact offset. */
export const realLocalIo: LocalIo = {
  statSize(path) {
    try {
      return nodeFs.statSync(path).size;
    } catch {
      return null;
    }
  },

  existsPath(path) {
    try {
      nodeFs.statSync(path);
      return true;
    } catch {
      return false;
    }
  },

  rmFile(path) {
    try {
      nodeFs.statSync(path);
    } catch {
      return; // already gone — the rm goal is satisfied without a pre-check race
    }
    try {
      nodeFs.rmSync(path);
    } catch {
      // surfaced through the transfer row, not a crash
    }
  },

  writer(path) {
    const ws = nodeFs.createWriteStream(path, { flags: "w" });
    const write = (chunk: Buffer): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        ws.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    const finish = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (ws.writableEnded) {
          resolve();
          return;
        }
        ws.on("finish", () => resolve());
        ws.on("error", (err) => reject(err));
        ws.end();
      });
    const abort = (): Promise<void> =>
      new Promise<void>((resolve) => {
        ws.on("close", () => resolve());
        ws.destroy();
        // The partial: unlinked so a cancel never leaves a stale temp on disk (F.1's trap).
        try {
          nodeFs.rmSync(path);
        } catch {
          // the stream's own failure surfaces in the row if this can't clean up
        }
      });
    return { write, finish, abort };
  },

  reader(path) {
    let fd: number;
    try {
      fd = nodeFs.openSync(path, "r");
    } catch {
      return null;
    }
    let size = 0;
    try {
      size = nodeFs.statSync(path).size;
    } catch {
      nodeFs.closeSync(fd);
      return null;
    }
    return {
      size,
      read(buffer, position) {
        return new Promise<number>((resolve, reject) => {
          nodeFs.read(
            fd,
            buffer,
            0,
            buffer.byteLength,
            position,
            (err, bytesRead) => (err ? reject(err) : resolve(bytesRead)),
          );
        });
      },
      close() {
        try {
          nodeFs.closeSync(fd);
        } catch {
          // a close race during teardown is noise
        }
      },
    };
  },
};

/** A transfer in the registry, with the private cancel flag kept out of the shared shape. */
interface TransferRecord extends SftpTransfer {
  canceled?: boolean;
}

/** The clone the subprocess needs before handing a shared Buffer to a stream write (ssh2's
 *  read fills a page buffer we reuse; the writer needs its own bytes). */
const pageFor = (buffer: Buffer, byteLength: number): Buffer => {
  const out = Buffer.allocUnsafe(byteLength);
  buffer.copy(out, 0, 0, byteLength);
  return out;
};

const ENOENT_RE = /no such file|No such|ENOENT|does not exist/i;
const isNotFound = (err: Error): boolean => ENOENT_RE.test(err.message);

const CHANNEL_LOST_RE = /channel|closed|disconnect|socket|end of stream/i;
const isChannelLost = (err: Error): boolean =>
  CHANNEL_LOST_RE.test(err.message);

/** The local "name-2.ext" suffix for download-name collisions (dotfiles keep their dot). */
const collateLocalName = (
  toDir: string,
  base: string,
  exists: (path: string) => boolean,
): string => {
  const dot = base.indexOf(".", 1);
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let candidate = `${toDir}/${base}`;
  for (let n = 2; exists(candidate) && n < 1000; n++) {
    candidate = `${toDir}/${stem}-${n}${ext}`;
  }
  return candidate;
};

export interface SftpDeps {
  connectionManager: Pick<ConnectionManager, "withClient">;
  /** Local filesystem operations (real by default; tests inject in-memory fakes). */
  localIo?: LocalIo;
}

export interface SftpService {
  list(serverId: string, dir: string): Promise<SftpListResult>;
  stat(serverId: string, path: string): Promise<SftpStatResult>;
  home(serverId: string): Promise<{ ok: true; path: string } | SftpFailure>;
  mkdir(serverId: string, path: string): Promise<SftpOk>;
  rename(serverId: string, from: string, to: string): Promise<SftpOk>;
  /** Directories delete recursively with per-child errors COLLECTED into `warnings`. */
  delete(serverId: string, paths: string[]): Promise<SftpDeleteResult>;
  /** Chunked pull of remote FILES into the chosen local dir (dirs answer a failure row
   *  explaining the v1 files-only support). */
  download(
    serverId: string,
    remotePaths: string[],
    toDir: string,
    /** The native save-dialog's chosen ABSOLUTE local path (single-selection downloads only);
     *  when present its basename REPLACES the remote basename. Multi-select downloads always
     *  reproduce the remote names under the chosen directory. */
    saveAs?: string,
  ): Promise<{ ok: true; skippedLocal: number } | SftpFailure>;
  /** Chunked push of local paths into a remote dir (conflict policy pre-resolved by the
   *  renderer; overwrite truncates per SFTP "w" open flag). */
  upload(
    serverId: string,
    dir: string,
    localPaths: string[],
    opts?: { overwrite?: boolean },
  ): Promise<{ ok: true; skippedLocal: number } | SftpFailure>;
  /** Remote Paste: per-item from→to pairs, conflicts pre-solved (suffix) by the renderer. */
  copy(
    serverId: string,
    items: Array<{ from: string; to: string }>,
  ): Promise<{ ok: true; skippedLocal: number } | SftpFailure>;
  cancel(transferId: string): void;
  transfers(): SftpTransferSnapshot;
  /** Attach/detach the transfer-progress push (the live window's renderer; null = none). */
  setPush(fn: SftpPushFn | null): void;
  /** A pooled connection died — every active transfer of that server fails as `dropped`. */
  noteDown(serverId: string): void;
  /** App teardown: channels close, registries clear, nothing records. */
  disposeAll(): void;
}

/** The push slot's fn shape (attached by sftp-ipc.ts, nulled on window close). */
export type SftpPushFn = (snapshot: SftpTransferSnapshot) => void;

export function createSftpService(deps: SftpDeps): SftpService {
  const localIo = deps.localIo ?? realLocalIo;
  // The transfer-progress push target (the one live window's renderer). Slot, not dep: the
  // service is app-level while the window comes and goes — sftp-ipc attaches on register and
  // detaches on window close; an unset slot means pushes quietly coalesce away.
  let pushFn: SftpPushFn | null = null;
  // serverId → live sftp channel (absent = never opened). Evicted on channel failure so the
  // NEXT op re-dials over the pooled connection instead of surfacing dead-channel errors forever.
  const channels = new Map<string, SftpChannel>();
  const transfers = new Map<string, TransferRecord>();
  let seq = 0;
  const mintId = (): string => `sftp-xfer-${++seq}`;
  let pushQueued = false;

  // ── push plumbing: coalesced ≡ one snapshot per turn for N transfer ticks ──

  const schedulePush = (): void => {
    if (pushQueued || !pushFn) return;
    pushQueued = true;
    queueMicrotask(() => {
      pushQueued = false;
      try {
        pushFn?.(snapshotPrivate());
      } catch {
        // a dead renderer must never cost a running transfer
      }
    });
  };

  /** The shared wire shape without the private cancel flag. */
  const snapshotPrivate = (): SftpTransferSnapshot =>
    [...transfers.values()].map((record) => {
      const { canceled: _canceled, ...rest } = record;
      return rest;
    });

  // ── channel lifecycle ──────────────────────────────────────────────────────

  const evict = (serverId: string): void => {
    const channel = channels.get(serverId);
    if (!channel) return;
    try {
      channel.end();
    } catch {
      // already dead; eviction is the decision, not this end()
    }
    channels.delete(serverId);
  };

  /** Borrow (open or reuse) the server's sftp channel. Never rejects: failures carry either
   *  the general "not connected" reason or the channel-level message the pane can show. */
  const borrow = async (
    serverId: string,
  ): Promise<{ ok: true; channel: SftpChannel } | SftpFailure> =>
    new Promise((resolve) => {
      const cached = channels.get(serverId);
      if (cached) {
        resolve({ ok: true, channel: cached });
        return;
      }
      const got = deps.connectionManager.withClient(serverId, (rpc) => {
        if (!rpc.sftp) {
          resolve({ ok: false, error: "The pooled connection cannot open SFTP channels." });
          return true;
        }
        rpc.sftp((err, sftp) => {
          if (err || !sftp) {
            resolve({ ok: false, error: err?.message ?? "Could not open the SFTP channel." });
            return;
          }
          resolve({ ok: true, channel: sftp });
        });
        return true;
      });
      if (!got) resolve({ ok: false, error: "The server is not connected." });
    });

  /** Run ONE async op over the (borrowed) channel; a channel-level failure evicts so the next
   *  op re-dials; every failure reads as `failure(message)` — never a rejection. */
  const runOp = async <R extends { ok: boolean }>(
    serverId: string,
    failure: (message: string, opts?: { notFound?: boolean }) => R,
    op: (channel: SftpChannel) => Promise<R>,
  ): Promise<R> => {
    const borrowed = await borrow(serverId);
    if (!borrowed.ok) return failure(borrowed.error);
    try {
      return await op(borrowed.channel);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (isChannelLost(e)) evict(serverId);
      return failure(e.message, { notFound: isNotFound(e) });
    }
  };

  // ── raw sftp promise wrappers (reject with ssh2's own message) ─────────────

  const statOf = (channel: SftpChannel, path: string): Promise<SftpAttrs> =>
    new Promise<SftpAttrs>((resolve, reject) => {
      try {
        channel.stat(path, (err, attrs) => (err ? reject(err) : resolve(attrs)));
      } catch (err) {
        reject(err as Error);
      }
    });

  const readdirOf = (
    channel: SftpChannel,
    path: string,
  ): Promise<SftpListEntry[]> =>
    new Promise<SftpListEntry[]>((resolve, reject) => {
      try {
        channel.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
      } catch (err) {
        reject(err as Error);
      }
    });

  const openHandle = (
    channel: SftpChannel,
    path: string,
    flags: string,
  ): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      try {
        channel.open(path, flags, (err, handle) =>
          err ? reject(err) : resolve(handle),
        );
      } catch (err) {
        reject(err as Error);
      }
    });

  const readAt = (
    channel: SftpChannel,
    handle: unknown,
    buffer: Buffer,
    length: number,
    position: number,
  ): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      try {
        channel.read(handle, buffer, 0, length, position, (err, n) =>
          err ? reject(err) : resolve(n),
        );
      } catch (err) {
        reject(err as Error);
      }
    });

  const writeAt = (
    channel: SftpChannel,
    handle: unknown,
    buffer: Buffer,
    position: number,
  ): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      try {
        channel.write(handle, buffer, 0, buffer.byteLength, position, (err, n) =>
          err ? reject(err) : resolve(n),
        );
      } catch (err) {
        reject(err as Error);
      }
    });

  const closeHandle = async (channel: SftpChannel, handle: unknown): Promise<void> => {
    try {
      await new Promise<void>((resolve, reject) => {
        channel.close(handle, (err) => (err ? reject(err) : resolve()));
      });
    } catch {
      // a handle-close failure never changes a transfer's recorded outcome
    }
  };

  const mkdirOf = (channel: SftpChannel, path: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      try {
        channel.mkdir(path, (err) => (err ? reject(err) : resolve()));
      } catch (err) {
        reject(err as Error);
      }
    });

  const renamePair = (
    channel: SftpChannel,
    from: string,
    to: string,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      try {
        channel.rename(from, to, (err) => (err ? reject(err) : resolve()));
      } catch (err) {
        reject(err as Error);
      }
    });

  const unlinkOf = (channel: SftpChannel, path: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      try {
        channel.unlink(path, (err) => (err ? reject(err) : resolve()));
      } catch (err) {
        reject(err as Error);
      }
    });

  const rmdirOf = (channel: SftpChannel, path: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      try {
        channel.rmdir(path, (err) => (err ? reject(err) : resolve()));
      } catch (err) {
        reject(err as Error);
      }
    });

  const realpathOf = (
    channel: SftpChannel,
    path: string,
  ): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      try {
        channel.realpath(path, (err, abs) => (err ? reject(err) : resolve(abs)));
      } catch (err) {
        reject(err as Error);
      }
    });

  // ── shared record helpers ───────────────────────────────────────────────────

  const attrsToKind = (attrs: SftpAttrs): SftpEntry["kind"] =>
    attrs.isDirectory() ? "dir" : attrs.isSymbolicLink() ? "symlink" : "file";

  const entryFrom = (name: string, attrs: SftpAttrs): SftpEntry => ({
    name,
    size: attrs.size,
    mtimeMs: attrs.mtime * 1000, // SFTPv3 mtime is seconds
    kind: attrsToKind(attrs),
  });

  const registerTransfer = (record: TransferRecord): void => {
    transfers.set(record.id, record);
    schedulePush();
  };

  const failTransfer = (
    record: TransferRecord,
    message: string,
    dropped = false,
  ): void => {
    record.status = "failed";
    record.dropped = dropped || undefined;
    record.error = message;
    schedulePush();
  };

  /** Recursive remote delete: depth-first, symlink-cycle guarded, per-child errors collected. */
  const removeRemote = async (
    channel: SftpChannel,
    path: string,
    seen: Set<string>,
    warnings: string[],
  ): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    let attrs: SftpAttrs | null = null;
    try {
      attrs = await statOf(channel, path);
    } catch (err) {
      warnings.push(`${path} — ${(err as Error).message}`);
      return;
    }
    if (attrs.isDirectory()) {
      let list: SftpListEntry[] = [];
      try {
        list = await readdirOf(channel, path);
      } catch (err) {
        warnings.push(`${path} — ${(err as Error).message}`);
        return;
      }
      for (const item of list) {
        const child = joinRemote(path, item.filename);
        if (!child) {
          warnings.push(`${path} — invalid child name`);
          continue;
        }
        await removeRemote(channel, child, seen, warnings);
      }
      try {
        await rmdirOf(channel, path);
      } catch (err) {
        warnings.push(`${path} — ${(err as Error).message}`);
      }
      return;
    }
    try {
      await unlinkOf(channel, path);
    } catch (err) {
      warnings.push(`${path} — ${(err as Error).message}`);
    }
  };


  /** The shared transfer tail: done-status + a max() so a late ack can't shrink progress. */
  const finishTransfer = (record: TransferRecord, bytes: number): void => {
    record.bytesDone = Math.max(record.bytesDone, bytes);
    record.status = "done";
    schedulePush();
  };

  /** The download's partial-file cleanup: a cancel/failure removes what the writer wrote, so no
   *  stale temp survives (the F.1 trap, applied to this pane's own temp-free flow). */
  const runPump = async (opts: {
    channel: SftpChannel;
    record: TransferRecord;
    /** One full page: read source → write destination. >0 = bytes advanced; 0 = EOF. */
    page(position: number): Promise<number>;
    /** The end-of-stream drain (writer.finish for downloads; no-op for remote writes). */
    drain(): Promise<void>;
    /** Canceled-or-failed cleanup (writer.abort → the partial deleted; reader closes). */
    cleanup(): Promise<void>;
  }): Promise<void> => {
    const { record } = opts;
    let position = 0;
    for (;;) {
      if (record.canceled) {
        try {
          await opts.cleanup();
        } catch {
          // cleanup failure never fabricates a transfer state
        }
        record.status = "canceled";
        schedulePush();
        return;
      }
      let bytes = 0;
      try {
        bytes = await opts.page(position);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        try {
          await opts.cleanup();
        } catch {
          // same non-propagation
        }
        failTransfer(record, e.message, isChannelLost(e));
        return;
      }
      if (bytes > 0) {
        position += bytes;
        record.bytesDone = Math.max(record.bytesDone, position);
        schedulePush();
        continue;
      }
      break;
    }
    try {
      await opts.drain();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      try {
        await opts.cleanup();
      } catch {
        // non-propagation
      }
      failTransfer(record, e.message);
      return;
    }
    finishTransfer(record, position);
  };

  /** Copy a shared page Buffer into fresh bytes before handing it to ssh2/write streams: the
   *  pump reuses ONE allocated page, so the destination needs its own copy each time. */
  const pageFor = (buffer: Buffer, byteLength: number): Buffer => {
    const out = Buffer.allocUnsafe(byteLength);
    buffer.copy(out, 0, 0, byteLength);
    return out;
  };

  /** Download one remote file: open "r" → chunked read → local writer → finish. Partial files
   *  (cancel/fail) are REMOVED by the writer's abort. */
  const startDownload = async (
    channel: SftpChannel,
    record: TransferRecord,
    remotePath: string,
    localPath: string,
    _size: number,
  ): Promise<void> => {
    let handle: unknown;
    try {
      handle = await openHandle(channel, remotePath, "r");
    } catch (err) {
      failTransfer(record, (err as Error).message);
      return;
    }
    const buffer = Buffer.alloc(SFTP_CHUNK_BYTES);
    try {
      const writer = localIo.writer(localPath);
      try {
        await runPump({
          channel,
          record,
          page: async (position) => {
            const bytes = await readAt(
              channel,
              handle,
              buffer,
              SFTP_CHUNK_BYTES,
              position,
            );
            if (bytes > 0) await writer.write(pageFor(buffer, bytes));
            return bytes;
          },
          drain: () => writer.finish(),
          cleanup: () => writer.abort(),
        });
      } finally {
        // The writer's own lifecycle (finish vs abort) already ran inside the pump path.
      }
    } finally {
      await closeHandle(channel, handle);
    }
  };

  /** Upload one local file: fd pager → chunked remote write ("w" open truncates, the
   *  overwrite semantics the renderer asked for). A partial server write fails the row. */
  const startUpload = async (
    channel: SftpChannel,
    record: TransferRecord,
    remotePath: string,
    reader: ReturnType<LocalIo["reader"]> & object,
  ): Promise<void> => {
    let handle: unknown;
    try {
      handle = await openHandle(channel, remotePath, "w");
    } catch (err) {
      reader.close();
      failTransfer(record, (err as Error).message);
      return;
    }
    const buffer = Buffer.alloc(SFTP_CHUNK_BYTES);
    try {
      await runPump({
        channel,
        record,
        page: async (position) => {
          if (reader.size > 0 && position >= reader.size) return 0;
          const filled = await reader.read(buffer, position);
          if (filled <= 0) return 0;
          const written = await writeAt(
            channel,
            handle,
            pageFor(buffer, filled),
            position,
          );
          if (written !== filled) {
            throw new Error("The server accepted a partial page.");
          }
          return filled;
        },
        drain: async () => {
          // ssh2's channel-side flush is implicit in the final read offset; nothing to drain.
        },
        cleanup: async () => {
          reader.close();
        },
      });
    } finally {
      reader.close();
      await closeHandle(channel, handle);
    }
  };

  /** Server-side copy (remote paste): remote read → remote write over the SAME channel; the
   *  destination was pre-named by the renderer's conflict policy. */
  const startRemoteCopy = async (
    channel: SftpChannel,
    record: TransferRecord,
    from: string,
    to: string,
  ): Promise<void> => {
    let srcHandle: unknown;
    let dstHandle: unknown;
    try {
      srcHandle = await openHandle(channel, from, "r");
      dstHandle = await openHandle(channel, to, "w");
    } catch (err) {
      if (srcHandle !== undefined) await closeHandle(channel, srcHandle);
      if (dstHandle !== undefined) await closeHandle(channel, dstHandle);
      failTransfer(record, (err as Error).message);
      return;
    }
    const buffer = Buffer.alloc(SFTP_CHUNK_BYTES);
    try {
      await runPump({
        channel,
        record,
        page: async (position) => {
          const bytes = await readAt(
            channel,
            srcHandle,
            buffer,
            SFTP_CHUNK_BYTES,
            position,
          );
          if (bytes > 0) {
            const written = await writeAt(
              channel,
              dstHandle,
              pageFor(buffer, bytes),
              position,
            );
            if (written !== bytes) {
              throw new Error("The server accepted a partial page.");
            }
          }
          return bytes;
        },
        drain: async () => {
          // remote destination: no local drain
        },
        cleanup: async () => {
          // neither side needs removal — the partially written remote copy is overwritten
        },
      });
    } finally {
      await closeHandle(channel, srcHandle);
      await closeHandle(channel, dstHandle);
    }
  };
  // ── the read + shape ops ────────────────────────────────────────────────────

  return {
    /** List one directory (stat first so a missing/mis-typed path answers the notFound-ish
     *  shape the renderer's breadcrumb maps to an inline "path not found"). */
    list(serverId, rawDir) {
      const dir = normalizeRemotePath(rawDir);
      if (!dir) {
        return Promise.resolve<SftpListResult>({
          ok: false,
          error: "Invalid path.",
          notFound: true,
        });
      }
      return runOp<SftpListResult>(
        serverId,
        (message, opts) => ({
          ok: false,
          error: message,
          notFound: opts?.notFound,
        }),
        async (channel) => {
          const attrs = await statOf(channel, dir);
          if (!attrs.isDirectory()) {
            return {
              ok: false,
              error: "Path is not a directory.",
            };
          }
          const list = await readdirOf(channel, dir);
          const entries = list.map((item) => entryFrom(item.filename, item.attrs));
          return { ok: true, entries, path: dir };
        },
      );
    },

    /** One stat (the conflict-policy probe and the breadcrumb's "exists?" check). */
    stat(serverId, rawPath) {
      const path = normalizeRemotePath(rawPath);
      if (!path) {
        return Promise.resolve<SftpStatResult>({
          ok: false,
          error: "Invalid path.",
          notFound: true,
        });
      }
      return runOp<SftpStatResult>(
        serverId,
        (message, opts) => ({
          ok: false,
          error: message,
          notFound: opts?.notFound,
        }),
        async (channel) => {
          const attrs = await statOf(channel, path);
          return { ok: true, entry: entryFrom(remoteBasename(path), attrs) };
        },
      );
    },

    /** The server's home directory, resolved server-side (SFTPv3 realpath ".") — the canonical
     *  first context, so the pane never assumes `/` or `/home/who`. */
    home(serverId) {
      return runOp<{ ok: true; path: string } | SftpFailure>(
        serverId,
        (message) => ({ ok: false, error: message }),
        async (channel) => {
          const abs = await realpathOf(channel, ".");
          return { ok: true, path: normalizeRemotePath(abs) ?? abs };
        },
      );
    },

    mkdir(serverId, rawPath) {
      const path = normalizeRemotePath(rawPath);
      if (!path) {
        return Promise.resolve<SftpOk>({ ok: false, error: "Invalid path." });
      }
      return runOp<SftpOk>(
        serverId,
        (message) => ({ ok: false, error: message }),
        async (channel) => {
          try {
            await mkdirOf(channel, path);
            return { ok: true };
          } catch (err) {
            const e = err as Error;
            // A mkdir racing a sibling creator: if the target is a dir NOW, that's success.
            let statNow: SftpAttrs | null = null;
            try {
              statNow = await statOf(channel, path);
            } catch {
              // still missing — the mkdir error stands
            }
            if (statNow?.isDirectory()) return { ok: true };
            return { ok: false, error: e.message };
          }
        },
      );
    },

    rename(serverId, rawFrom, rawTo) {
      const from = normalizeRemotePath(rawFrom);
      const to = normalizeRemotePath(rawTo);
      if (!from || !to) {
        return Promise.resolve<SftpOk>({ ok: false, error: "Invalid path." });
      }
      return runOp<SftpOk>(
        serverId,
        (message) => ({ ok: false, error: message }),
        async (channel) => {
          try {
            await renamePair(channel, from, to);
            return { ok: true };
          } catch (err) {
            const e = err as Error;
            if (!isNotFound(e) || from === to) {
              return { ok: false, error: e.message };
            }
            // Some servers refuse rename-overwrite (the SFTPv3 rename has no replace flag);
            // the safe retry path is a one-shot target removal then re-rename.
            const existing = await statOf(channel, to).catch(() => null);
            if (!existing) return { ok: false, error: e.message };
            try {
              if (existing.isDirectory()) {
                await rmdirOf(channel, to);
              } else {
                await unlinkOf(channel, to);
              }
            } catch (clearErr) {
              return { ok: false, error: (clearErr as Error).message };
            }
            try {
              await renamePair(channel, from, to);
              return { ok: true };
            } catch (retryErr) {
              return { ok: false, error: (retryErr as Error).message };
            }
          }
        },
      );
    },

    async delete(serverId, rawPaths) {
      const paths: string[] = [];
      for (const raw of rawPaths) {
        const p = normalizeRemotePath(raw);
        if (p) paths.push(p);
      }
      if (paths.length === 0) {
        return {
          ok: false,
          error: "Nothing selected to delete.",
        };
      }
      return runOp<SftpDeleteResult>(
        serverId,
        (message) => ({ ok: false, error: message }),
        async (channel) => {
          const warnings: string[] = [];
          for (const path of paths) {
            await removeRemote(channel, path, new Set<string>(), warnings);
          }
          return { ok: true, warnings };
        },
      );
    },

    async download(serverId, remotePaths, rawToDir, saveAs) {
      const toDir = typeof rawToDir === "string" ? rawToDir.trim() : "";
      if (!remotePaths.length || !toDir) {
        return { ok: false, error: "Nothing selected to download." };
      }
      // A save-dialog rename applies only to the single-selection case; multi downloads always
      // reproduce the remote names under the chosen directory.
      const saveName =
        saveAs && remotePaths.length === 1
          ? remoteBasename(saveAs.replace(/\\/g, "/"))
          : null;
      const borrowed = await borrow(serverId);
      if (!borrowed.ok) return borrowed;
      const channel = borrowed.channel;
      const reservedNames = new Set<string>();
      let skippedLocal = 0;
      for (const raw of remotePaths) {
        const path = normalizeRemotePath(raw);
        if (!path) {
          skippedLocal++;
          continue;
        }
        let attrs: SftpAttrs | null = null;
        try {
          attrs = await statOf(channel, path);
        } catch {
          // unreadable remote — skippedLocal bucket (the pane shows nothing if all skipped)
        }
        if (!attrs || attrs.isDirectory()) {
          // v1 downloads pull FILES; a directory answers a skipped count (documented gap).
          skippedLocal++;
          continue;
        }
        const base = saveName ?? remoteBasename(path).replace(/\0/g, "_");
        const localPath = collateLocalName(toDir, base, (candidate) =>
          localIo.existsPath(candidate) || reservedNames.has(candidate),
        );
        reservedNames.add(localPath);
        const record: TransferRecord = {
          id: mintId(),
          direction: "download",
          serverId,
          remotePath: path,
          localPath,
          name: base,
          bytesDone: 0,
          bytesTotal: attrs.size > 0 ? attrs.size : null,
          status: "active",
        };
        registerTransfer(record);
        void startDownload(channel, record, path, localPath, attrs.size);
      }
      return { ok: true, skippedLocal };
    },

    async upload(serverId, rawDir, localPaths, opts) {
      const dir = normalizeRemotePath(rawDir);
      if (!dir || localPaths.length === 0) {
        return { ok: false, error: "Invalid upload target." };
      }
      const borrowed = await borrow(serverId);
      if (!borrowed.ok) return borrowed;
      const channel = borrowed.channel;
      const overwrite = opts?.overwrite === true;
      let skippedLocal = 0;
      for (const localPath of localPaths) {
        const mine = typeof localPath === "string" ? localPath.trim() : "";
        if (!mine) {
          skippedLocal++;
          continue;
        }
        const size = localIo.statSize(mine);
        if (size === null) {
          skippedLocal++; // unreadable or vanished between drop and push
          continue;
        }
        const name = remoteBasename(mine.replace(/\\/g, "/"));
        const target = joinRemote(dir, name);
        if (!target) {
          skippedLocal++;
          continue;
        }
        let existing: SftpAttrs | null = null;
        try {
          existing = await statOf(channel, target);
        } catch {
          // absent — the write may proceed
        }
        if (!overwrite && existing) {
          skippedLocal++;
          continue;
        }
        const reader = localIo.reader(mine);
        if (!reader) {
          skippedLocal++;
          continue;
        }
        const record: TransferRecord = {
          id: mintId(),
          direction: "upload",
          serverId,
          remotePath: target,
          fromLocalPath: mine,
          name,
          bytesDone: 0,
          bytesTotal: reader.size > 0 ? reader.size : null,
          status: "active",
        };
        registerTransfer(record);
        void startUpload(channel, record, target, reader);
      }
      return { ok: true, skippedLocal };
    },

    async copy(serverId, items) {
      if (!items.length) {
        return { ok: false, error: "Nothing to paste." };
      }
      const borrowed = await borrow(serverId);
      if (!borrowed.ok) return borrowed;
      const channel = borrowed.channel;
      let skippedLocal = 0;
      for (const item of items) {
        const from = typeof item?.from === "string" ? normalizeRemotePath(item.from) : null;
        const to = typeof item?.to === "string" ? normalizeRemotePath(item.to) : null;
        if (!from || !to || from === to) {
          skippedLocal++;
          continue;
        }
        let attrs: SftpAttrs | null = null;
        try {
          attrs = await statOf(channel, from);
        } catch {
          // vanished between copy and paste
        }
        if (!attrs || attrs.isDirectory()) {
          // v1 copy is per-file; a pasted directory answers a skipped count (documented gap).
          skippedLocal++;
          continue;
        }
        const record: TransferRecord = {
          id: mintId(),
          direction: "copy",
          serverId,
          remotePath: to,
          fromLocalPath: from,
          name: remoteBasename(to),
          bytesDone: 0,
          bytesTotal: attrs.size > 0 ? attrs.size : null,
          status: "active",
        };
        registerTransfer(record);
        void startRemoteCopy(channel, record, from, to);
      }
      return { ok: true, skippedLocal };
    },

    /** Arm the cancel flag; the running loop observes it at the next chunk boundary, aborts its
     *  local writer (partial removed) and marks the row. Unknown/finished ids are no-ops. */
    /** Attach/detach the transfer-progress push (the live window's renderer; null = none). */
    setPush(fn: SftpPushFn | null): void {
      pushFn = fn;
    },

    cancel(transferId) {
      const record = transfers.get(transferId);
      if (!record || record.status !== "active") return;
      record.canceled = true;
      schedulePush();
    },

    transfers: () => snapshotPrivate(),

    /** A pooled connection died: every active transfer of that server fails as `dropped` (the
     *  row's Retry re-issues the same op after the reconnect; the stale remote side is garbage),
     *  and the (now dead) channel evicts so subsequent ops re-dial. */
    noteDown(serverId) {
      for (const record of transfers.values()) {
        if (record.serverId !== serverId || record.status !== "active") continue;
        failTransfer(record, "Connection lost.", true);
      }
      evict(serverId);
    },

    disposeAll() {
      for (const serverId of [...channels.keys()]) evict(serverId);
      transfers.clear();
    },
  };
}
