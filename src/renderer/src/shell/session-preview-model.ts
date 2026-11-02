/**
 * The rail's hover preview state machine (tier-1 spec Run 1 / A2) — pure, JSX-free, one flat
 * state with a small event vocabulary, so the show/hide choreography is testable without a DOM.
 *
 * Choreography (per spec):
 * - hovering a row shows the card near it after a short delay (enter → pending → timer → visible);
 * - only ONE card at a time: entering a different row replaces the anchor and restarts the delay;
 * - mouse-leave doesn't kill a visible card outright — a small grace window keeps it up so
 *   diagonal travel (out and back, or row to row) doesn't flicker it; re-entering the same row
 *   during that window returns to visible immediately, with no re-delay;
 * - Escape, scroll, and a drag dismiss instantly and never leave a pending timer standing.
 *
 * The DOM wiring is a thin adapter: pointerenter/pointerleave (mouse pointers only) on rows fire
 * `enter`/`leave`, the component's timers fire `showTimer`/`hideTimer`, and Escape/scroll
 * listeners fire their events. The machine owns no timers: every phase change to a scheduling
 * phase bumps `nonce`, and the adapter schedules exactly one timer keyed on (phase, nonce) so a
 * same-phase re-fire never tears down a running timeout.
 */

/** How long a row must be hovered before its card appears. */
export const PREVIEW_SHOW_DELAY_MS = 300;
/** How long a left-behind visible card stays up, so diagonal travel doesn't kill it. */
export const PREVIEW_LEAVE_GRACE_MS = 140;

/** The part of the hovered row's geometry the card placement needs — a plain copied rect, not a
 *  live DOMRect (state must be a plain value; the adapter copies at the event boundary). */
export interface PreviewAnchor {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type PreviewEvent =
  | { type: "enter"; anchor: PreviewAnchor }
  /** The pointer left the row it was pending on or visible over. */
  | { type: "leave" }
  /** The show-delay timer fired. */
  | { type: "showTimer" }
  /** The leave-grace timer fired. */
  | { type: "hideTimer" }
  | { type: "escape" }
  /** Any ancestor scroll cancels the preview outright — a card can't track a moving rail. */
  | { type: "scroll" }
  /** A drag of any kind (window, pane split, native drag) suppresses the preview entirely. */
  | { type: "drag" };

export type PreviewPhase = "hidden" | "pending" | "visible" | "grace";

export interface PreviewState {
  phase: PreviewPhase;
  /** The card's subject and its geometry, present in pending, visible, and grace. */
  anchor: PreviewAnchor | null;
  /** Bumped on every state change that matters to the adapter's single-timer schedule, so
   *  re-firing the same event with identical data leaves a running timeout untouched. */
  nonce: number;
}

export const initialPreviewState: PreviewState = {
  phase: "hidden",
  anchor: null,
  nonce: 0,
};

/** Whether the card should be on screen in this state (pending phase has no card yet). */
export function isPreviewVisible(state: PreviewState): boolean {
  return state.phase === "visible" || state.phase === "grace";
}

/** Which single timer the state schedules next, if any — hidden and visible schedule nothing. */
export function previewTimer(
  state: PreviewState,
): { event: "showTimer" | "hideTimer"; afterMs: number } | null {
  switch (state.phase) {
    case "pending":
      return { event: "showTimer", afterMs: PREVIEW_SHOW_DELAY_MS };
    case "grace":
      return { event: "hideTimer", afterMs: PREVIEW_LEAVE_GRACE_MS };
    default:
      return null;
  }
}

function sameGeometry(a: PreviewAnchor, b: PreviewAnchor): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom
  );
}

function enter(s: PreviewState, anchor: PreviewAnchor): PreviewState {
  return { phase: "pending", anchor, nonce: s.nonce + 1 };
}

function visible(s: PreviewState, anchor: PreviewAnchor | null): PreviewState {
  return { phase: "visible", anchor: anchor ?? s.anchor, nonce: s.nonce + 1 };
}

function grace(s: PreviewState): PreviewState {
  return { phase: "grace", anchor: s.anchor, nonce: s.nonce + 1 };
}

function hide(s: PreviewState): PreviewState {
  return { phase: "hidden", anchor: null, nonce: s.nonce + 1 };
}

export function stepPreview(
  state: PreviewState,
  event: PreviewEvent,
): PreviewState {
  // Escape, scroll, and drag cancel outright — pending timers included. The pointer may still
  // be over a row when the rail is scrolled or a drag starts mid-hover, and a stale pending
  // card popping after the motion is exactly the flicker this machine exists to prevent.
  if (
    event.type === "scroll" ||
    event.type === "drag" ||
    event.type === "escape"
  ) {
    return state.phase === "hidden" ? state : hide(state);
  }
  switch (event.type) {
    case "enter": {
      if (state.phase === "visible" || state.phase === "grace") {
        if (state.anchor?.id === event.anchor.id) {
          // Same row: during grace, back to visible immediately (it was never hidden, so no
          // re-delay); while visible, reposition only if geometry changed.
          if (state.phase === "grace") return visible(state, event.anchor);
          return sameGeometry(state.anchor!, event.anchor)
            ? state
            : visible(state, event.anchor);
        }
        // A different row replaces the anchor and restarts the show delay.
        return enter(state, event.anchor);
      }
      // From hidden, or already pending: only a genuinely new (id or geometry) hover restarts
      // the delay; a re-fired enter on the pending row keeps its running timer.
      if (
        state.phase === "pending" &&
        state.anchor?.id === event.anchor.id &&
        sameGeometry(state.anchor, event.anchor)
      ) {
        return state;
      }
      return enter(state, event.anchor);
    }
    case "leave": {
      if (state.phase === "pending") return hide(state);
      if (state.phase === "visible") return grace(state);
      // From hidden (nothing to lose) or grace (already holding, keep the original timer).
      return state;
    }
    case "showTimer": {
      return state.phase === "pending" ? visible(state, null) : state;
    }
    case "hideTimer": {
      return state.phase === "grace" ? hide(state) : state;
    }
  }
}

const CARD_WIDTH = 320;
const CARD_GAP = 8;
const VIEWPORT_GUTTER = 8;

/** Place the card next to the hovered row: right of it (the rail sits at the screen's left),
 *  vertically tracking the row's top edge, clamped into the viewport; flipped to the row's
 *  left side when the right-of placement would overflow. Pure math on the copied anchor. */
export function placePreviewCard(
  anchor: PreviewAnchor,
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const flip =
    anchor.right + CARD_GAP + CARD_WIDTH > viewport.width - VIEWPORT_GUTTER;
  const left = flip
    ? Math.max(VIEWPORT_GUTTER, anchor.left - CARD_GAP - CARD_WIDTH)
    : anchor.right + CARD_GAP;
  const top = Math.min(
    Math.max(VIEWPORT_GUTTER, anchor.top),
    Math.max(VIEWPORT_GUTTER, viewport.height - VIEWPORT_GUTTER),
  );
  return { left, top };
}
