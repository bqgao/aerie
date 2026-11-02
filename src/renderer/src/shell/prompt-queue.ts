import { atom } from "nanostores";
import { AGENTS } from "@shared/agents";
import type { Session } from "@shared/types";

/**
 * The rail's per-session prompt queue (tier-1 spec Run 2 / A4) — pure, JSX-free, driven by a
 * small event vocabulary so the enqueue / send-on-idle / failure-keeps / badge choreography is
 * testable without a DOM.
 *
 * Semantics (per spec):
 * - prompts park in the queue (renderer lifetime nanostore atom, never persisted);
 * - while one send is in flight nothing else auto-sends for that session (the controller sends
 *   one head per poll tick);
 * - a send SUCCESS drops the head (badge decrements); a send FAILURE keeps the head, stamps its
 *   one-line error in band (the renderer turns warning-color; never a rejection), and re-arms;
 * - "clear" vacates the whole session queue (the context menu op; the modal shows it read-only).
 *
 * The DOM-side adapter (App's poll tick + the modal) only translates `Session` snapshots and IPC
 * results into these events — exactly the boundary this module tests without JSX.
 */

export interface PromptQueueEntry {
  id: string;
  text: string;
  /** The in-band display reason from the last failed send; cleared when a retry starts. */
  error?: string;
}

export interface PromptQueue {
  entries: readonly PromptQueueEntry[];
  /** The entry id a send is in flight for; nothing else auto-sends while set. */
  sendingId?: string;
}

export type PromptQueues = Readonly<Record<string, PromptQueue>>;

/** Renderer lifetime only (tier-1 spec Run 2 / A4): never persisted, resets on launch. */
export const $promptQueues = atom<PromptQueues>({});

export function promptEntryId(): string {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export type PromptQueueEvent =
  | { type: "enqueue"; sessionId: string; id: string; text: string }
  | { type: "sendStart"; sessionId: string; id: string }
  | { type: "sendDone"; sessionId: string; id: string }
  | { type: "sendFailed"; sessionId: string; id: string; error: string }
  | { type: "clear"; sessionId: string };

/** A queue snapshot when the session has none yet (the shape every caller matches on). */
export const emptyQueue: PromptQueue = { entries: [] };

export function queueOf(state: PromptQueues, sessionId: string): PromptQueue {
  return state[sessionId] ?? emptyQueue;
}

/** The queue's badge: how many prompts are parked (in-flight head included until it drops). */
export function queuedCount(state: PromptQueues, sessionId: string): number {
  return queueOf(state, sessionId).entries.length;
}

/** Store helpers for non-React call sites (the context-menu op, the modal's Enter). Each fills
 *  the atom from its live value — the atom is the only stateful thing in this module. */
export function enqueuePromptFor(
  sessionId: string,
  id: string,
  text: string,
): void {
  $promptQueues.set(
    reducePrompts($promptQueues.get(), {
      type: "enqueue",
      sessionId,
      id,
      text,
    }),
  );
}

export function clearPromptsFor(sessionId: string): void {
  $promptQueues.set(
    reducePrompts($promptQueues.get(), { type: "clear", sessionId }),
  );
}

/** The warning state the badge keys on: a head that failed and is still queued. */
export function queuedError(
  state: PromptQueues,
  sessionId: string,
): string | null {
  const head = queueOf(state, sessionId).entries[0];
  return head?.error ?? null;
}

function queueIn(state: PromptQueues, sessionId: string): PromptQueue {
  return state[sessionId] ?? { entries: [] };
}
function dropQueue(state: PromptQueues, sessionId: string): PromptQueues {
  const next: Record<string, PromptQueue> = { ...state };
  delete next[sessionId];
  return next;
}

export function reducePrompts(
  state: PromptQueues,
  event: PromptQueueEvent,
): PromptQueues {
  const queue = queueIn(state, event.sessionId);
  switch (event.type) {
    case "enqueue": {
      const text = event.text.trim();
      if (text === "") return state; // an empty prompt is a no-op, not an error
      return {
        ...state,
        [event.sessionId]: {
          ...queue,
          entries: [...queue.entries, { id: event.id, text }],
        },
      };
    }
    case "sendStart": {
      if (queue.sendingId) return state; // one in flight per session, full stop
      const head = queue.entries[0];
      if (!head || head.id !== event.id) return state;
      return {
        ...state,
        [event.sessionId]: {
          entries: queue.entries.map((e) =>
            e.id === event.id ? { ...e, error: undefined } : e,
          ),
          sendingId: event.id,
        },
      };
    }
    case "sendDone": {
      if (queue.sendingId !== event.id) return state; // a stale settle can't drop another head
      const rest = queue.entries.filter((e) => e.id !== event.id);
      if (rest.length === 0) return dropQueue(state, event.sessionId);
      return { ...state, [event.sessionId]: { entries: rest } };
    }
    case "sendFailed": {
      if (queue.sendingId !== event.id) return state;
      return {
        ...state,
        [event.sessionId]: {
          // Failure keeps the prompt (the head) and stamps its in-band one-line error; the badge
          // stays the same count and the row renderer turns it warning-color.
          entries: queue.entries.map((e) =>
            e.id === event.id ? { ...e, error: event.error } : e,
          ),
        },
      };
    }
    case "clear":
      return dropQueue(state, event.sessionId);
  }
}

/** Whether a queued head may auto-send for `session` right now: the queue holds prompts, nothing
 *  in flight, and the session is one of the agent's prompt-able ones back at its waiting state
 *  (tier-1 Run 2 / A4: "the poll sees the session return to waiting"). Pure so the tick tests run
 *  against fixtures. */
export function canAutoSend(
  state: PromptQueues,
  session: Session | undefined,
): boolean {
  if (!session) return false;
  // Flag-gated (the registry's canPrompt), never branched on the agent id.
  if (!AGENTS[session.agent].capabilities.canPrompt) return false;
  const queue = queueOf(state, session.id);
  if (queue.entries.length === 0 || queue.sendingId) return false;
  return session.state === "waiting";
}

/** One head per poll tick, per session: the heads that may auto-send for the just-polled list,
 *  paired with their session ids in list order. */
export function autoSendable(
  state: PromptQueues,
  sessions: readonly Session[],
): readonly { sessionId: string; id: string; text: string }[] {
  const out: { sessionId: string; id: string; text: string }[] = [];
  for (const session of sessions) {
    if (!canAutoSend(state, session)) continue;
    const head = queueOf(state, session.id).entries[0];
    if (head) out.push({ sessionId: session.id, id: head.id, text: head.text });
  }
  return out;
}
