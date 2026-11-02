import type { AgentId } from "./agents";
import type { ScanProgress } from "./stats";

/**
 * B1 full-text search (SEARCH_QUICKJUMP_SPEC, run B1): the shapes crossing the IPC boundary for
 * `search:read` (backfill progress + per-source status), `search:pump` (one bounded scan step)
 * and `search:query` (FTS5 results grouped by session). Pure types + trivial constants only —
 * both processes import this module, so keep it JSX-free and dependency-light.
 */

/** One search source's state: per-agent backfill progress plus the soft-failure verdict. When
 *  `unavailable` is true the source contributes nothing (the opencode store drifted or is absent)
 *  and `error` carries the display-grade reason the UI may surface verbatim. */
export interface SearchSourceState {
  agent: AgentId;
  unavailable: boolean;
  /** Display-grade reason for an unavailable source; absent when healthy. */
  error?: string;
}

/** The aggregate progress one search scan step returned: the ScanProgress shape the renderer's
 *  pump cadence already reads (filesTotal/filesDone/done), with `wrote` mirroring the analytics
 *  scan (a step can record an unreadable file without moving the index) and the per-source detail
 *  the Databases card and the Search pane's degraded states read. */
export interface SearchProgress extends ScanProgress {
  wrote: boolean;
  sources: SearchSourceState[];
}

export function emptySearchProgress(): SearchProgress {
  return {
    filesTotal: 0,
    filesDone: 0,
    done: true,
    wrote: false,
    sources: [],
  };
}

/** One search hit, grouped under its session by the query handler: the sidebar row payload plus
 *  the highlighted snippet (marks: `»`/`«` open/close, `…`-elided tails — exact strings produced
 *  by `snippet(fts, …)` in main). `hitCount` counts the matched documents inside this session
 *  among the rows the query visited. */
export interface SearchResultGroup {
  sessionId: string;
  agent: AgentId;
  sessionTitle: string;
  directory: string;
  /** The most recent hit's timestamp (epoch ms; 0 when unknown). */
  timeMs: number;
  hitCount: number;
  snippet: string;
}

/** The query IPC result. Handlers never reject: a bad FTS query (malformed after our quoting —
 *  should not be reachable) or a failed store read comes back as `{ ok: false, error }`, where
 *  `error` is a display-grade English reason the renderer may show verbatim. */
export type SearchQueryResult =
  | { ok: true; groups: SearchResultGroup[] }
  | { ok: false; error: string };

/** The search progress poll: a fresh snapshot with a change token the caller echoes back as
 *  `since` (mirroring stats:read's memo pattern), or `unchanged` when the progress and every
 *  source's state still match — so an idle pump costs one cheap token read. */
export type SearchRead =
  | { status: "changed"; token: string; progress: SearchProgress }
  | { status: "unchanged"; token: string };
