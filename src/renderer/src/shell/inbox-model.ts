import { atom } from "nanostores";
import type { Session } from "@shared/types";

/**
 * The rail's two list modes (tier-1 spec Run 1 / A1). "All" is the rail's existing behavior;
 * "Inbox" narrows every section (pinned rows, project groups, hidden groups) to the sessions
 * that are waiting on the user. Persisted per renderer lifetime in a nanostore atom — never in
 * app settings and never on disk, so it resets to All on the next launch.
 */
export type RailListMode = "all" | "inbox";

export const $railListMode = atom<RailListMode>("all");

export function setRailListMode(mode: RailListMode): void {
  $railListMode.set(mode);
}

/**
 * The inbox predicate: a session is in the inbox when its derived state says it needs the user —
 * "waiting" (the provider's waiting signal, or a transcript tail that ended on an unanswered
 * prompt) or "idle" (alive but neither working nor waiting — nothing in flight, so the user's
 * input is what moves it). Working sessions are busy generating and healthy ended sessions are
 * history; both stay out.
 */
export function isInboxSession(session: Session): boolean {
  return session.state === "waiting" || session.state === "idle";
}

/**
 * The flat inbox view: the sessions that pass the predicate, waiting ones first (most recently
 * waiting first — lastActivityMs is when the session entered waiting, since the last transcript
 * event IS the wait), then idle ones on the same recency axis. Returns a new array; never
 * mutates the input. The pinned section and the project-group rows use the same set — this
 * ordered output feeds the pinned/unpinned chains so the two can't disagree about membership.
 */
export function inboxSessions(sessions: Session[]): Session[] {
  return sessions.filter(isInboxSession).sort((a, b) => {
    const aWaiting = a.state === "waiting" ? 0 : 1;
    const bWaiting = b.state === "waiting" ? 0 : 1;
    if (aWaiting !== bWaiting) return aWaiting - bWaiting;
    return b.lastActivityMs - a.lastActivityMs;
  });
}

/** The reason chip's shape: idle is its own label; a permission wait names the tool it needs;
 *  a provider reason the mapping doesn't know (free-form question text and the like) degrades
 *  to the generic waiting label. */
export type InboxReason =
  | { kind: "idle" }
  | { kind: "generic" }
  | { kind: "permission"; tool: string };

const PERMISSION_PREFIX = "Permission:";

/**
 * Map a session to its reason chip's data (tier-1 spec Run 1 / A1 — the same mapping the hover
 * preview card uses, so the two surfaces can never disagree). Known provider reasons map to
 * short categories; anything unrecognized falls back to the generic one, and a live-but-idle
 * session gets its own label rather than being called out for waiting.
 *
 * Note: the rail's Session rows currently reach the renderer without `waitingReason` populated
 * (it lives only in the transcript doc today), so the generic slot is the common case — the
 * permission mapping activates without further changes once the reason rides the session row.
 */
export function inboxReason(session: Session): InboxReason {
  if (session.state === "idle") return { kind: "idle" };
  const reason = session.waitingReason?.trim();
  if (
    reason !== undefined &&
    reason !== "" &&
    reason.toLowerCase().startsWith(PERMISSION_PREFIX.toLowerCase())
  ) {
    const tool = reason.slice(PERMISSION_PREFIX.length).trim();
    if (tool !== "") return { kind: "permission", tool };
  }
  return { kind: "generic" };
}

/** Resolve a mapped reason to its display text, given the caller's localized labels. Kept pure
 *  and JSX-free so the row chip and the preview card share one mapping. */
export function inboxReasonText(
  reason: InboxReason,
  labels: {
    idle: string;
    generic: string;
    permission: (tool: string) => string;
  },
): string {
  switch (reason.kind) {
    case "idle":
      return labels.idle;
    case "generic":
      return labels.generic;
    case "permission":
      return labels.permission(reason.tool);
  }
}
