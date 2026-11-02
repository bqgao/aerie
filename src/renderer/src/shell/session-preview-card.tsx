import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Session } from "@shared/types";
import { formatUsd } from "@shared/format";
import { Lamp } from "../ui/atoms";
import { Icon } from "../ui/icons";
import { useI18n } from "../i18n";
import { inboxReason, inboxReasonText } from "./inbox-model";
import {
  initialPreviewState,
  isPreviewVisible,
  placePreviewCard,
  previewTimer,
  previewViewport,
  stepPreview,
  type PreviewAnchor,
  type PreviewEvent,
  type PreviewState,
} from "./session-preview-model";

/** Copy a live DOMRect into the plain anchor shape the state machine stores. */
function copyRect(id: string, el: Element): PreviewAnchor {
  const r = el.getBoundingClientRect();
  return { id, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

type RowPointerEvent = {
  /** The pointer class that produced the event: "mouse" opens previews; touch/pen never do. */
  pointerType: string;
  /** Pressed buttons mask (0 = none): a pressed pointer means a drag/pane-resize is on. */
  buttons: number;
};

/**
 * The rail's hover preview (tier-1 spec Run 1 / A2). One hook instance lives in the LeftSidebar;
 * rows only report pointer enter/leave, and this module runs the (pure, separately tested)
 * state machine, its single timer, and the hard dismissals (Escape, scroll, drag). The card is
 * read-only and opens through a portal so no row stacking can clip it.
 *
 * Data comes from what the rail already polls (`sessions`, the same list the rows render);
 * there is deliberately no per-hover transcript read for the last-reply snippet (degradation
 * noted in the run report): the card shows what the rail has — title, state + reason,
 * directory, cost. Touch pointers and any pressed/dragging pointer never open a card.
 */
export function useSessionPreview(
  sessions: Session[],
  homeDir = "",
): {
  /** Row adapter: fire on mouse pointerenter over the row, never while a button is held. */
  onRowEnter: (
    session: Session,
    element: Element,
    event: RowPointerEvent,
  ) => void;
  onRowLeave: () => void;
  /** The card's portal — mount it once; it renders nothing while no preview is up. */
  card: ReactNode;
} {
  const [state, dispatch] = useReducer(
    (current: PreviewState, event: PreviewEvent) => stepPreview(current, event),
    initialPreviewState,
  );
  // Rows get stable identity across poll re-renders: callbacks close over dispatch only, and
  // the id → session lookup re-derives from the prop each render.
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const onRowEnter = (
    session: Session,
    element: Element,
    event: RowPointerEvent,
  ) => {
    // Guard at the boundary so the machine stays pure: mouse pointers only (touch taps must
    // not open read-only chrome), and never while a pointer button is held — pressing anywhere
    // (window drag, pane split, native row drag) is exactly the "while dragging" case.
    if (event.pointerType !== "mouse" || event.buttons !== 0) return;
    dispatch({ type: "enter", anchor: copyRect(session.id, element) });
  };
  const onRowLeave = () => dispatch({ type: "leave" });

  // Exactly one timer lives in the hook, keyed to (phase, nonce) from the state machine, so
  // re-fires that didn't change scheduling (grace holds, same-row reposition) never tear down
  // a running timeout.
  const timer = previewTimer(state);
  useEffect(() => {
    if (!timer) return;
    const id = window.setTimeout(
      () => dispatch({ type: timer.event }),
      timer.afterMs,
    );
    return () => window.clearTimeout(id);
    // discrete-deps: `timer` is a fresh derived object each render — the real identity pair is
    // (phase, nonce), and re-arming on every render would starve the timer it schedules.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.nonce]);

  // Hard dismissals while a preview is in play (pending included — Escape there feels free and
  // a scroll can't leave a stale timer about to pop over a moving rail). Capture-phase scroll
  // so the rail's inner scroller and pane scrolls all count; dismissing on scroll is the safe
  // call — a card can't track a moving rail without becoming the flicker it exists to avoid.
  useEffect(() => {
    if (state.phase === "hidden") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "escape" });
    };
    const onScroll = () => dispatch({ type: "scroll" });
    const onDrag = () => dispatch({ type: "drag" });
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("dragstart", onDrag);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("dragstart", onDrag);
    };
  }, [state.phase]);

  const visible = isPreviewVisible(state);
  const session = state.anchor ? (byId.get(state.anchor.id) ?? null) : null;
  const card =
    visible && session && state.anchor
      ? createPortal(
          <SessionPreviewCard
            session={session}
            anchor={state.anchor}
            homeDir={homeDir}
          />,
          document.body,
        )
      : null;

  return { onRowEnter, onRowLeave, card };
}

/** The directory readout: homeDir abbreviated to ~, else raw (the rail's group hint convention). */
function readoutDir(
  cwd: string | undefined,
  homeDir: string,
): string | undefined {
  if (!cwd) return undefined;
  return homeDir && cwd.startsWith(homeDir)
    ? "~" + cwd.slice(homeDir.length)
    : cwd;
}

/**
 * The card itself: state lamp + title, the A1 reason chip (same mapping), directory, and cost.
 * Pinned next to the row — right of it, flipped to the left side when the viewport is tight —
 * measured after mount, so its first paint happens in its final position (visibility-swapped,
 * like the rail's anchored menus).
 */
function SessionPreviewCard({
  session,
  anchor,
  homeDir = "",
}: {
  session: Session;
  anchor: PreviewAnchor;
  homeDir?: string;
}) {
  const { t } = useI18n();
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  useLayoutEffect(() => {
    function place() {
      const el = cardRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vp = previewViewport(window);
      const base = placePreviewCard(anchor, vp);
      // The pure placement decides the side (right/flip) and clamps with its assumed extent;
      // here, with the measured height, clamp the top exactly — same gutters, no overflow.
      const top = Math.max(
        8,
        Math.min(
          Math.max(base.top, anchor.top),
          Math.max(8, window.innerHeight - 8 - rect.height),
        ),
      );
      // Width is fixed by CSS to match the pure math's CARD_WIDTH; clamp the flipped side's
      // left edge against the measured width so nothing overflows the screen edge.
      const flipped = base.left > anchor.right;
      const left = !flipped
        ? base.left
        : Math.max(8, Math.min(base.left, window.innerWidth - rect.width - 8));
      setPosition({ left, top });
    }
    place();
  }, [anchor]);

  const label = inboxReasonText(inboxReason(session), {
    idle: t.shell.sidebar.reasonIdle,
    generic: t.shell.sidebar.reasonWaiting,
    permission: t.shell.sidebar.reasonPermission,
  });
  const dir = readoutDir(session.cwd, homeDir);
  return (
    <div
      ref={cardRef}
      role="presentation"
      style={{
        position: "fixed",
        left: position?.left ?? anchor.left,
        top: position?.top ?? anchor.top,
        width: 320,
        visibility: position ? "visible" : "hidden",
      }}
      className="z-50 flex flex-col gap-1.5 rounded-lg border border-(--ui-stroke-secondary) bg-[color-mix(in_srgb,var(--ui-bg-elevated)_96%,transparent)] p-2.5 shadow-(--shadow-md) backdrop-blur-xl"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="grid size-3.5 shrink-0 place-items-center">
          <Lamp state={session.state} management={session.management} />
        </span>
        <span className="min-w-0 shrink-[2] truncate text-[0.8125rem] leading-none font-medium text-fg">
          {session.title}
        </span>
        <span className="shrink-0 rounded-sm bg-(--ui-control-active-background) px-1 py-0.5 text-[0.625rem] leading-none text-(--ui-text-tertiary)">
          {label}
        </span>
      </div>
      {dir && (
        <div className="flex min-w-0 items-center gap-1.5 text-[0.72rem] leading-none text-(--ui-text-quaternary)">
          <Icon name="folder" size={12} className="shrink-0" />
          <span className="min-w-0 truncate" title={session.cwd}>
            {dir}
          </span>
        </div>
      )}
      {session.costUsd != null && (
        <div className="flex items-center gap-1.5 text-[0.72rem] leading-none text-(--ui-text-quaternary)">
          <Icon name="coins" size={12} className="shrink-0" />
          <span>{formatUsd(session.costUsd)}</span>
        </div>
      )}
    </div>
  );
}
