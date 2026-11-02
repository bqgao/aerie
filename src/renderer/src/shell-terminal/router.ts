import { FLOW } from "@shared/terminal";
import type { ShellTerminalApi } from "@shared/shell-terminal";
import type {
  SshTerminalApi,
  SshTerminalExitReason,
} from "@shared/ssh-terminal";

export interface ShellRouterHandlers {
  onData(data: string): void;
  onExit(exitCode: number): void;
}

export interface ShellRouter {
  /** Route this id's chunks/exit to `handlers`. Returns unregister. Register BEFORE spawning the
   *  pty (the renderer mints the id), so the very first bytes land on a live handler. */
  register(id: string, handlers: ShellRouterHandlers): () => void;
  /** Credit consumed output back to the pty, batched into FLOW.ackChars messages (one IPC per
   *  batch, not per write) — VSCode's ack-on-xterm-parse loop, same shape as terminal-store. */
  ackConsumed(id: string, charCount: number): void;
}

export interface SshRouterHandlers {
  onData(data: string): void;
  /** `reason` distinguishes the pooled connection's drop (tab survives, lock overlay until
   *  Reconnect) from a remote shell's own exit (tab dies, like a local shell's exit). */
  onExit(exitCode: number, reason: SshTerminalExitReason): void;
}

export interface SshRouter {
  /** Route this id's chunks/exit to `handlers`. Returns unregister. Register BEFORE invoking the
   *  ssh spawn (the renderer mints the id per attempt), so the very first channel bytes land on a
   *  live handler. */
  register(id: string, handlers: SshRouterHandlers): () => void;
  /** Same ack-batching as the shell router: one IPC per FLOW.ackChars batch of consumed output. */
  ackConsumed(id: string, charCount: number): void;
}

interface RouterApi<E extends unknown[]> {
  onData(cb: (id: string, data: string, offset: number) => void): () => void;
  onExit(cb: (id: string, ...event: E) => void): () => void;
  ack(id: string, charCount: number): void;
}

interface CharRouter<E extends unknown[]> {
  register(
    id: string,
    handlers: { onData(data: string): void; onExit(...event: E): void },
  ): () => void;
  ackConsumed(id: string, charCount: number): void;
}

/**
 * ONE module-level-style subscription multiplexes a data/exit channel to per-tab handlers by id
 * (each terminal namespace builds exactly one). The stray-id ack-back must live in that one place:
 * per-instance filtering would leave a just-closed tab's in-flight chunks unacked, leaking
 * flow-control credit — and a paused stream whose credit never drains below the resume line wedges
 * forever (FLOW's invariant).
 */
function createCharRouter<E extends unknown[]>(
  api: RouterApi<E>,
): CharRouter<E> {
  const handlers = new Map<
    string,
    { onData(data: string): void; onExit(...event: E): void }
  >();
  const pendingAck = new Map<string, number>();

  api.onData((id, data) => {
    const h = handlers.get(id);
    if (!h) {
      api.ack(id, data.length);
      return;
    }
    h.onData(data);
  });
  api.onExit((id, ...event) => handlers.get(id)?.onExit(...event));

  return {
    register(id, h) {
      handlers.set(id, h);
      return () => {
        if (handlers.get(id) === h) {
          handlers.delete(id);
          pendingAck.delete(id);
        }
      };
    },
    ackConsumed(id, charCount) {
      if (!handlers.has(id)) return; // tab closed — drop the late ack, don't resurrect state
      let pending = (pendingAck.get(id) ?? 0) + charCount;
      while (pending >= FLOW.ackChars) {
        api.ack(id, FLOW.ackChars);
        pending -= FLOW.ackChars;
      }
      pendingAck.set(id, pending);
    },
  };
}

export function createShellRouter(
  api: Pick<ShellTerminalApi, "onData" | "onExit" | "ack">,
): ShellRouter {
  const router = createCharRouter<[code: number]>({
    onData: api.onData,
    onExit: (cb) => api.onExit((id, code) => cb(id, code)),
    ack: api.ack,
  });
  return {
    register: router.register,
    ackConsumed: router.ackConsumed,
  };
}

export function createSshRouter(
  api: Pick<SshTerminalApi, "onData" | "onExit" | "ack">,
): SshRouter {
  const router = createCharRouter<[code: number, reason: SshTerminalExitReason]>({
    onData: api.onData,
    onExit: (cb) =>
      api.onExit((id, code, reason) => cb(id, code, reason)),
    ack: api.ack,
  });
  return {
    register: router.register,
    ackConsumed: router.ackConsumed,
  };
}
