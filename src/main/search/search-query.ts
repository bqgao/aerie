import type { AgentId } from "@shared/agents";
import type { SearchQueryResult, SearchResultGroup } from "@shared/search";
import type { SqliteDb } from "../db/driver";

/**
 * The transcript search query (B1): tokens → an FTS5 MATCH string under trigram rules, run with
 * bm25() ranking and snippet()/highlight marks, grouped by sessionId and capped (`limit`
 * sessions). Pure logic (the builder) is separated from the SQL so bad syntax is a testable
 * in-band error — the IPC handler converts everything to `{ ok, error }` and never rejects.
 *
 * Trigram caveats this module owns:
 * - a token needs ≥3 characters for the trigram index to answer it (a shorter token simply has
 *   no trigram to match) — shorter tokens fall back to a LIKE prefilter on the body column,
 *   which still serves CJK substrings under 3 characters (a full scan, unchanged semantics);
 * - every token is wrapped in a quoted prefix term (`"tok"*`), so FTS operator characters
 *   inside the token become literal text; embedded double quotes are stripped first, since they
 *   would otherwise close the quote mid-term;
 * - the MATCH string is body-scoped (`{body} : …`), so hits rising from the agent/title/
 *   directory columns can never pollute a prose query (searching "claude" must not hit every
 *   row's agent column).
 */

/** Rows the group loop may visit before it stops — hard bounds keep a very broad query from
 *  walking the whole index into main-thread time. */
const MAX_VISITED_ROWS = 4000;

const GROUP_LIMIT_DEFAULT = 50;

export interface ParsedQuery {
  /** The quoted-prefix MATCH string, body-scoped. null when no token qualifies. */
  match: string | null;
  /** LIKE fragments for tokens the trigram index can't serve (<3 characters). */
  likes: string[];
  /** The original tokens, trimmed and nonempty. Empty when the query is blank. */
  tokens: string[];
}

export function buildSearchQuery(raw: string): ParsedQuery {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const matchTerms: string[] = [];
  const likes: string[] = [];
  for (const token of tokens) {
    // Strip the only character that could break out of a quoted term; the rest is inert inside
    // an FTS quoted string.
    const safe = token.replaceAll('"', "");
    if (safe.length === 0) continue;
    if ([...safe].length >= 3) matchTerms.push(`"${safe}"*`);
    else likes.push(`%${escapeLike(safe)}%`);
  }
  return {
    match: matchTerms.length ? matchTerms.join(" ") : null,
    likes,
    tokens,
  };
}

/** LIKE's wildcard-meaningful characters escaped with `\` (ESCAPE '\' declared in SQL). */
function escapeLike(token: string): string {
  return token
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

const SELECT_ROWS = `
  SELECT sessionId AS sessionId,
         agent AS agent,
         sessionTitle AS sessionTitle,
         directory AS directory,
         timeMs AS timeMs,
         snippet(fts, 0, '…', '»', '«', 24) AS snippet,
         bm25(fts) AS rank
  FROM fts
`;

/**
 * Run the query: rank by bm25 ascending (best first), then group in order — the first hit a
 * session contributes carries its snippet (deterministic: the best-ranked one), and hitCount
 * counts every further hit seen while the 50-session window is still filling. Any store error
 * (a malformed MATCH we couldn't build into safe form should not happen, but a cache half-open
 * might) degrades to `{ ok: false, error }` with a display-grade message.
 */
export function searchTranscripts(
  db: SqliteDb,
  raw: string,
  limit: number = GROUP_LIMIT_DEFAULT,
): SearchQueryResult {
  const parsed = buildSearchQuery(raw);
  if (parsed.tokens.length === 0) return { ok: true, groups: [] };
  try {
    const where: string[] = [];
    const params: string[] = [];
    if (parsed.match) {
      where.push("fts MATCH ?");
      params.push(`{body} : ${parsed.match}`);
    }
    for (const like of parsed.likes) {
      where.push("body LIKE ? ESCAPE '\\'");
      params.push(like);
    }
    if (where.length === 0) return { ok: true, groups: [] };
    const rows = db
      .prepare(
        `${SELECT_ROWS}
        WHERE ${where.join(" AND ")}
        ORDER BY rank`,
      )
      .all(...params) as {
      sessionId: string;
      agent: string;
      sessionTitle: string | null;
      directory: string | null;
      timeMs: number | null;
      snippet: string;
    }[];

    return {
      ok: true,
      groups: groupBySession(rows, Math.max(1, limit), MAX_VISITED_ROWS),
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "unknown query failure";
    return { ok: false, error: `Query failed: ${message}` };
  }
}

/** The bounded, in-order grouping: best-ranked rows first; a session appears once, with its
 *  best hit's snippet, its hit count over the visited rows, and the freshest hit's timeMs.
 *  Pure (test-reachable without a db). */
export function groupBySession(
  rows: {
    sessionId: string;
    agent: string;
    sessionTitle: string | null;
    directory: string | null;
    timeMs: number | null;
    snippet: string;
  }[],
  limit: number,
  maxVisitedRows: number,
): SearchResultGroup[] {
  const byId = new Map<string, SearchResultGroup>();
  for (
    let i = 0;
    i < rows.length && i < maxVisitedRows && byId.size < limit;
    i++
  ) {
    const r = rows[i];
    const group = byId.get(r.sessionId);
    if (group) {
      group.hitCount += 1;
      if ((r.timeMs ?? 0) > group.timeMs) group.timeMs = r.timeMs ?? 0;
    } else {
      byId.set(r.sessionId, {
        sessionId: r.sessionId,
        agent: r.agent as AgentId,
        sessionTitle: r.sessionTitle ?? "",
        directory: r.directory ?? "",
        timeMs: r.timeMs ?? 0,
        hitCount: 1,
        snippet: r.snippet ?? "",
      });
    }
  }
  return [...byId.values()];
}
