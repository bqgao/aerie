import { describe, expect, it } from "vitest";
import {
  PREVIEW_LEAVE_GRACE_MS,
  PREVIEW_SHOW_DELAY_MS,
  initialPreviewState,
  isPreviewVisible,
  placePreviewCard,
  previewTimer,
  stepPreview,
  type PreviewAnchor,
  type PreviewEvent,
} from "../../src/renderer/src/shell/session-preview-model";

const anchorAt = (id: string, top = 10): PreviewAnchor => ({
  id,
  left: 0,
  top,
  right: 220,
  bottom: top + 26,
});

const fire = (state: ReturnType<typeof stepPreview>, events: PreviewEvent[]) =>
  events.reduce((s, e) => stepPreview(s, e), state);

const enterA = (top = 10): PreviewEvent => ({
  type: "enter",
  anchor: anchorAt("a", top),
});
const enterB = (top = 50): PreviewEvent => ({
  type: "enter",
  anchor: anchorAt("b", top),
});

describe("hover preview: show choreography", () => {
  it("delay-gates: enter → pending (300ms) → timer → visible", () => {
    const pending = stepPreview(initialPreviewState, enterA());
    expect(pending.phase).toBe("pending");
    expect(previewTimer(pending)).toEqual({
      event: "showTimer",
      afterMs: PREVIEW_SHOW_DELAY_MS,
    });
    expect(isPreviewVisible(pending)).toBe(false);
    const shown = stepPreview(pending, { type: "showTimer" });
    expect(shown.phase).toBe("visible");
    expect(shown.anchor?.id).toBe("a");
    expect(previewTimer(shown)).toBeNull();
  });

  it("leaving before the delay cancels silently — no card, no grace", () => {
    const out = fire(initialPreviewState, [enterA(), { type: "leave" }]);
    expect(out.phase).toBe("hidden");
    expect(previewTimer(out)).toBeNull();
  });
});

describe("hover preview: one card at a time", () => {
  it("entering another row replaces the anchor and restarts the delay", () => {
    const shown = fire(initialPreviewState, [enterA(), { type: "showTimer" }]);
    const next = stepPreview(shown, enterB());
    expect(next.phase).toBe("pending");
    expect(next.anchor?.id).toBe("b");
    expect(next.nonce).toBeGreaterThan(shown.nonce);
    expect(previewTimer(next)?.event).toBe("showTimer");
  });

  it("the same row re-firing its enter while visible keeps the card and timer stable", () => {
    const shown = fire(initialPreviewState, [enterA(), { type: "showTimer" }]);
    const again = stepPreview(shown, enterA());
    expect(again.phase).toBe("visible");
    expect(again.nonce).toBe(shown.nonce);
  });

  it("a geometry change on the same row repositions (nonce bump, still visible)", () => {
    const shown = fire(initialPreviewState, [enterA(), { type: "showTimer" }]);
    const moved = stepPreview(shown, enterA(60));
    expect(moved.phase).toBe("visible");
    expect(moved.anchor?.top).toBe(60);
    expect(moved.nonce).not.toBe(shown.nonce);
  });
});

describe("hover preview: leave grace", () => {
  it("leaving a visible card enters grace with the hide timer, card still up", () => {
    const shown = fire(initialPreviewState, [enterA(), { type: "showTimer" }]);
    const out = stepPreview(shown, { type: "leave" });
    expect(out.phase).toBe("grace");
    expect(isPreviewVisible(out)).toBe(true);
    expect(previewTimer(out)).toEqual({
      event: "hideTimer",
      afterMs: PREVIEW_LEAVE_GRACE_MS,
    });
  });

  it("re-entering during grace returns to visible immediately — no re-delay", () => {
    const out = stepPreview(
      fire(initialPreviewState, [
        enterA(),
        { type: "showTimer" },
        { type: "leave" },
      ]),
      enterA(),
    );
    expect(out.phase).toBe("visible");
    expect(previewTimer(out)).toBeNull();
  });

  it("re-entering a DIFFERENT row during grace moves to that row via the delay", () => {
    const out = stepPreview(
      fire(initialPreviewState, [
        enterA(),
        { type: "showTimer" },
        { type: "leave" },
      ]),
      enterB(),
    );
    expect(out.phase).toBe("pending");
    expect(out.anchor?.id).toBe("b");
  });

  it("grace firing its timer hides the card", () => {
    const out = fire(initialPreviewState, [
      enterA(),
      { type: "showTimer" },
      { type: "leave" },
      { type: "hideTimer" },
    ]);
    expect(out.phase).toBe("hidden");
    expect(out.anchor).toBeNull();
  });

  it("a stale hideTimer after returning to visible is a no-op", () => {
    const back = stepPreview(
      fire(initialPreviewState, [
        enterA(),
        { type: "showTimer" },
        { type: "leave" },
        enterA(),
      ]),
      { type: "hideTimer" },
    );
    expect(back.phase).toBe("visible");
  });
});

describe("hover preview: hard dismissals", () => {
  it("Escape, scroll, and drag dismiss instantly, pending timers included", () => {
    for (const type of ["escape", "scroll", "drag"] as const) {
      const fromPending = stepPreview(initialPreviewState, {
        type: "enter",
        anchor: anchorAt("a"),
      });
      const dismissed = stepPreview(fromPending, { type });
      expect(dismissed.phase).toBe("hidden");
      expect(dismissed.anchor).toBeNull();

      const shown = fire(initialPreviewState, [
        enterA(),
        { type: "showTimer" },
      ]);
      expect(stepPreview(shown, { type }).phase).toBe("hidden");

      // Idempotent: dismissing from hidden stays hidden.
      expect(stepPreview(initialPreviewState, { type })).toBe(
        initialPreviewState,
      );
    }
  });
});

describe("hover preview: card placement", () => {
  const viewport = { width: 1440, height: 900 };

  it("sits right of the row, anchored at its top edge", () => {
    const a = anchorAt("a", 300);
    expect(placePreviewCard(a, viewport)).toEqual({ left: 228, top: 300 });
  });

  it("clamps into the viewport gutter", () => {
    const top = anchorAt("a", 1);
    expect(placePreviewCard(top, viewport).top).toBe(8);
    const pastBottom = anchorAt("a", viewport.height + 20);
    expect(placePreviewCard(pastBottom, viewport).top).toBe(
      viewport.height - 8,
    );
  });

  it("flips to the left of the row when right placement would overflow", () => {
    const near: PreviewAnchor = {
      id: "edge",
      left: viewport.width - 200,
      top: 100,
      right: viewport.width - 4,
      bottom: 126,
    };
    const placed = placePreviewCard(near, viewport);
    expect(placed.left).toBeLessThan(near.left);
    expect(placed.left).toBeGreaterThanOrEqual(8);
  });
});
