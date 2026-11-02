import { useEffect } from "react";
import { atom } from "nanostores";
import type { SearchProgress } from "@shared/search";
import { nextPumpDelayMs } from "../stats/pump-schedule";

/**
 * The search index's pump (B1): the renderer drives one bounded scan step per tick for the app's
 * lifetime — brisk (40ms) while a backfill fills in, then a 5-minute idle cadence — so the index
 * tracks new transcripts just like the stats mirror does. Identical hook shape to
 * stats/use-stats-pump (same schedule constants via stats/pump-schedule; a SearchProgress is a
 * ScanProgress superset). Never pauses on document.hidden: backfilling while unwatched is the
 * point. Deliberately does NOT sit behind the Search pane's open state, so the backfill finishes
 * even when the pane is closed (the pane reads $searchScanProgress for its building state).
 */

/** The pump's latest scan progress. null until the first tick lands. */
export const $searchScanProgress = atom<SearchProgress | null>(null);

/** The live pump's "run a step now" handle, registered by the mounted hook. null when no pump
 *  is mounted, so kickSearchPump() is then a no-op. */
let kick: (() => void) | null = null;

/** Run a pump step now: clears the pending idle timer and re-ticks. Fired when the Search pane
 *  opens, so a freshly (re-)mounted pump starts moving within a frame instead of up to
 *  PUMP_IDLE_MS later. No-op when no pump is mounted. */
export function kickSearchPump(): void {
  kick?.();
}

export function useSearchPump(): void {
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    // Set when a kick arrives mid-flight: the settling tick re-runs immediately instead of
    // scheduling, so a kick can never spawn a second, overlapping poll loop.
    let kickPending = false;
    function tick(): void {
      if (inFlight) {
        kickPending = true;
        return;
      }
      inFlight = true;
      kickPending = false;
      void window.api
        .pumpSearch()
        .then((progress) => {
          inFlight = false;
          if (!alive) return;
          $searchScanProgress.set(progress);
          if (kickPending) tick();
          else timer = setTimeout(tick, nextPumpDelayMs(progress));
        })
        .catch(() => {
          // The handler never rejects by design; reaching here means the IPC bridge itself
          // failed. Keep the last progress and retry at the idle cadence.
          inFlight = false;
          if (!alive) return;
          if (kickPending) tick();
          else timer = setTimeout(tick, nextPumpDelayMs(null));
        });
    }
    const kickThis = (): void => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      tick();
    };
    kick = kickThis;
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (kick === kickThis) kick = null;
    };
  }, []);
}
