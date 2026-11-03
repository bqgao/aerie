import type { AgentCapabilities } from "@shared/agents";
import type { SessionState } from "@shared/types";

/**
 * The workspace chat composer's gating rules (tier-1 spec Run 2 / A4) — pure, JSX-free,
 * so the show / disable / empty-text matrix is testable without a DOM.
 *
 * The composer exists only for prompt-capable agents (the registry's canPrompt flag,
 * never an agent id — the same gate the rail's prompt queue rides) and only while the
 * session can still take a message: idle and waiting render it enabled, working renders
 * it disabled with the queue hint (the parked-prompt path takes over), ended takes it
 * away entirely (the session is gone — the op would fail in band).
 */

/** Whether the composer surface renders at all for this agent + session state. */
export function canShowComposer(
  capabilities: AgentCapabilities,
  state: SessionState,
): boolean {
  if (!capabilities.canPrompt) return false;
  return state !== "ended";
}

/** Why the composer is disabled, or null when a send may go right now. "ended" is the
 *  defensive branch — canShowComposer already takes the composer away for it. */
export function composerDisabledReason(
  capabilities: AgentCapabilities,
  state: SessionState,
): "busy" | "ended" | null {
  if (!capabilities.canPrompt || state === "ended") return "ended";
  if (state === "working") return "busy";
  return null; // idle + waiting are the sendable states (the queue's own sendable set)
}

/** The send gate: empty text never sends — whitespace-only counts as empty. */
export type SendGuard = { ok: true } | { ok: false; reason: "empty" };

export function sendGuard(text: string): SendGuard {
  return text.trim().length === 0
    ? { ok: false, reason: "empty" }
    : { ok: true };
}
