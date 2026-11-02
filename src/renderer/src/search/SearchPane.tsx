/**
 * The Search pane (B1, SEARCH_QUICKJUMP_SPEC run B1): a right-hand docked pane registered in
 * layout.ts (id "search", default closed, discovered via the titlebar's search toggle). A
 * browsing surface, per the recon's recommendation — 200ms-debounced query → `search:query`,
 * results grouped by session in the rail's row grammar (agent mark, truncated title, dimmed
 * directory), with the highlighted snippet, the hit count and the relative time beneath.
 * Clicking a row selects that session in the rail (the existing select action — the pane never
 * touches routing itself). Empty/degraded states read the pump's per-source status; backfill
 * progress shows as a slim building line while the pump is still filling.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import type { SearchResultGroup, SearchProgress } from "@shared/search";
import { Icon } from "../ui/icons";
import { AgentIcon } from "../ui/agent-icons";
import { useI18n } from "../i18n";
import { AGENTS, type AgentId } from "@shared/agents";
import { $paneOpen } from "../shell/panes";
import { SEARCH_PANE_ID } from "../shell/layout";
import { $searchScanProgress, kickSearchPump } from "./use-search-pump";
import { splitSnippet } from "./search-model";

/** The input's debounce: fast enough to feel live, slow enough to keep one IPC per pause. */
const QUERY_DEBOUNCE_MS = 200;
/** The result cap — main's default; passed explicitly so the contract is visible in the surface. */
const RESULT_LIMIT = 50;

type QueryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "results"; groups: SearchResultGroup[] }
  | { kind: "error"; error: string };

export function SearchPane({
  onSelectSession,
}: {
  onSelectSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const open = useStore($paneOpen(SEARCH_PANE_ID));
  const scan = useStore($searchScanProgress);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<QueryState>({ kind: "idle" });
  // The result request's identity: a stale response (a slow query overtaken by a new one) must
  // never render — each effect run captures its own request id and only the freshest applies.
  const requestIdRef = useRef(0);

  // Pane-open kick: the freshly opened surface starts a pump step within a frame rather than
  // waiting out the idle cadence (same shape as the Settings card's post-reset kick).
  useEffect(() => {
    if (open) kickSearchPump();
  }, [open]);

  // The debounced query: 200ms after the last keystroke, one invoke — the transaction shared
  // else-where in this app (workspace use-polled-read's settle discipline).
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      requestIdRef.current += 1;
      setState({ kind: "idle" });
      return;
    }
    const requestId = ++requestIdRef.current;
    setState({ kind: "loading" });
    const timer = setTimeout(() => {
      void window.api
        .searchQuery(trimmed, RESULT_LIMIT)
        .then((r) => {
          if (requestId !== requestIdRef.current) return; // a newer keystroke overtook us
          if (r.ok) setState({ kind: "results", groups: r.groups });
          else setState({ kind: "error", error: r.error });
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          setState({ kind: "error", error: t.search.degraded });
        });
    }, QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // t.search.degraded rides the stable-catalog assumption like every other effect here.
  }, [query, t.search.degraded]);

  const building = scan !== null && !scan.done;
  const buildingText = building
    ? `${t.search.backfilling} ${scan.filesDone}/${scan.filesTotal}`
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Query bar */}
      <div className="shrink-0 border-b border-(--ui-stroke-tertiary) px-3 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) px-2 py-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
          <Icon
            name="search"
            size={13}
            className="shrink-0 text-(--ui-text-quaternary)"
          />
          <input
            autoFocus
            aria-label={t.search.title}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.search.placeholder}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-fg outline-none placeholder:text-(--ui-text-quaternary)"
          />
        </div>
      </div>
      {/* Status strip: building progress + degraded sources. */}
      {(buildingText || displayUnavailability(scan).length > 0) && (
        <div className="shrink-0 px-3 py-1.5 text-[0.68rem] text-(--ui-text-quaternary)">
          {buildingText && <p className="animate-pulse">{buildingText}</p>}
          {displayUnavailability(scan).map((s) => (
            <p key={s.agent}>
              {AGENTS[s.agent].label} · {t.search.unavailable}
              {s.error ? ` — ${s.error}` : ""}
            </p>
          ))}
        </div>
      )}
      {/* Results */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 pt-1.5">
        {state.kind === "idle" && (
          <p className="px-3.5 text-aux text-(--ui-text-quaternary)">
            {t.search.noQuery}
          </p>
        )}
        {state.kind === "loading" && (
          <p className="px-3.5 text-aux text-(--ui-text-quaternary)">
            {t.search.placeholder}
          </p>
        )}
        {state.kind === "error" && (
          <p className="px-3.5 text-aux text-danger">{state.error}</p>
        )}
        {state.kind === "results" &&
          state.groups.map((group) => (
            <SearchResultRow
              key={group.sessionId}
              group={group}
              onSelect={onSelectSession}
            />
          ))}
        {state.kind === "results" &&
          state.groups.length === 0 &&
          !buildingText && (
            <p className="px-3.5 text-aux text-(--ui-text-quaternary)">
              {t.search.noResults}
            </p>
          )}
      </div>
    </div>
  );
}

/** The per-source unavailability lines worth showing. `scan` is the pump's latest progress —
 *  null before the first tick (nothing to degrade yet). */
function displayUnavailability(
  scan: SearchProgress | null,
): Array<{ agent: AgentId; error?: string }> {
  if (!scan) return [];
  return scan.sources
    .filter((s) => s.unavailable)
    .map((s) => ({ agent: s.agent, error: s.error }));
}

/** One result row, in the rail's row grammar: a 26px strip, the agent's mark in the icon slot,
 *  the truncated session title — with the directory dimmed after it — and beneath, the snippet
 *  with highlighted marks, the hit count and the relative time. */
function SearchResultRow({
  group,
  onSelect,
}: {
  group: SearchResultGroup;
  onSelect: ((id: string) => void) | undefined;
}) {
  const { t } = useI18n();
  const spans = useMemo(() => splitSnippet(group.snippet), [group.snippet]);
  const directory = shortenPath(group.directory, 24);
  return (
    <button
      type="button"
      onClick={() => onSelect?.(group.sessionId)}
      className="group flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-3.5 py-1.5 text-left hover:bg-(--ui-row-hover-background)"
    >
      <span className="flex min-h-[1.375rem] w-full items-center gap-1.5">
        <span className="grid size-3.5 shrink-0 place-items-center">
          <AgentIcon agent={group.agent} size={14} className="h-3.5 w-3.5" />
        </span>
        <span
          className="min-w-0 flex-1 truncate rounded-md text-[0.8125rem] leading-none text-(--ui-text-secondary) group-hover:text-fg"
          title={group.sessionTitle || group.sessionId}
        >
          {group.sessionTitle || group.sessionId}
        </span>
        {directory && (
          <span
            className="shrink-0 truncate rounded-md text-[0.68rem] leading-none text-(--ui-text-quaternary)"
            title={group.directory}
          >
            {directory}
          </span>
        )}
      </span>
      <span className="flex w-full items-baseline gap-2 pl-5">
        <span className="min-w-0 flex-1 text-[0.75rem] leading-snug">
          {spans.map((span, i) =>
            span.hit ? (
              <mark
                key={i}
                className="bg-transparent font-medium text-primary-bright"
              >
                {span.text}
              </mark>
            ) : (
              <span key={i} className="text-(--ui-text-quaternary)">
                {span.text}
              </span>
            ),
          )}
        </span>
        <span className="shrink-0 text-[0.68rem] tabular-nums text-(--ui-text-quaternary)">
          {t.search.hits(group.hitCount)}
          {group.timeMs > 0 && ` · ${t.time.ago(group.timeMs, Date.now())}`}
        </span>
      </span>
    </button>
  );
}

/** A ~-collapsed tail of a path: keep the last segment plus a leading "…", so the row stays a
 *  single line even for deeply nested worktrees. */
function shortenPath(path: string, maxChars: number): string {
  if (!path) return "";
  const segments = path.split("/");
  let out = segments[segments.length - 1] || "";
  for (let i = segments.length - 2; i >= 0; i--) {
    const candidate = `${segments[i]}/${out}`;
    if (candidate.length + 1 > maxChars) {
      return `…/${out}`;
    }
    out = candidate;
  }
  return out;
}
