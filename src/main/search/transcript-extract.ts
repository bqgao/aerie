/**
 * Transcript-line extractors for the search scan (B1). Each JSONL line of a Claude Transcript or
 * a Codex rollout contributes at most one document: the text of its user/assistant message (plus
 * reasoning/thinking blocks), the line's cwd, and its timestamp. Summaries come back as title
 * candidates rather than body text — the scan keeps the first one as the session's title.
 * Pure and JSX-free: parse failures return null/empty and never throw, so one malformed row can't
 * sink a scan step (same tolerance the analytics scanner has).
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object";

/** A document body is capped: transcripts run long, and FTS5 row bodies triple the trigram
 *  index cost. 20KiB per message keeps both bounded. */
export const MAX_BODY_CHARS = 20_000;

/** What one transcript line yielded for the index. `text` is the searchable body ("" when the
 *  line carries nothing indexable), `title` a display-name candidate ("" when none). */
export interface ExtractedLineHit {
  text: string;
  title: string;
  cwd: string;
  timeMs: number;
}

const EMPTY: ExtractedLineHit = { text: "", title: "", cwd: "", timeMs: 0 };

const normalizeTimeMs = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
};

/** The content parts that are prose, not tool traffic: text and thought blocks only. */
const CONTENT_PART_TYPES = new Set(["text", "thinking", "reasoning"]);
const isProsePart = (part: unknown): part is { text: unknown } => {
  if (!isRecord(part)) return false;
  const t = part.type;
  return typeof t === "string"
    ? CONTENT_PART_TYPES.has(t)
    : t === undefined || t === null;
};

function partText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(isProsePart)
      .map((p) => (typeof p.text === "string" ? p.text.trim() : ""))
      .filter((s) => s !== "")
      .join("\n");
  }
  return "";
}

/**
 * One Claude Transcript line (`.jsonl` under ~/.claude/projects/). User/assistant rows contribute
 * their message text; `summary` rows contribute only a title candidate. Tool calls/results
 * (tool_use/tool_result parts) are deliberately skipped — B1 indexes conversation prose.
 */
export function extractClaudeLine(line: string): ExtractedLineHit | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(row)) return null;
  const type = row.type;
  const cwd = typeof row.cwd === "string" ? row.cwd : "";
  const timeMs = normalizeTimeMs(row.timestamp);
  if (type === "summary") {
    const title = typeof row.summary === "string" ? row.summary.trim() : "";
    return title ? { ...EMPTY, title, cwd, timeMs } : null;
  }
  if (type !== "user" && type !== "assistant") return null;
  const message = isRecord(row.message) ? row.message : null;
  if (!message) return null;
  const text = partText(message.content).slice(0, MAX_BODY_CHARS);
  if (!text) return null;
  return { text, title: "", cwd, timeMs };
}

/**
 * One Codex rollout line: event rows of type user_message / agent_message carry the prose in
 * `payload.message`. Everything else (token_count bookkeeping, turn_context, function calls)
 * contributes nothing.
 */
export function extractCodexLine(line: string): ExtractedLineHit | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(row)) return null;
  if (row.type !== "event_msg") return null;
  const payload = isRecord(row.payload) ? row.payload : null;
  if (
    !payload ||
    (payload.type !== "user_message" && payload.type !== "agent_message")
  )
    return null;
  const text = partText(
    typeof payload.message === "string" ? payload.message : "",
  ).slice(0, MAX_BODY_CHARS);
  if (!text) return null;
  return { text, title: "", cwd: "", timeMs: normalizeTimeMs(row.timestamp) };
}

/** One opencode session_message `data` blob: the JSON payload whose `content[]` parts hold the
 *  prose. Returns the joined text ('' when the message carries nothing indexable) so the scan
 *  can skip empty bodies per spec. */
export function extractOpencodeBody(data: unknown): string {
  let row = data;
  if (typeof row === "string") {
    try {
      row = JSON.parse(row);
    } catch {
      return "";
    }
  }
  if (!isRecord(row)) return "";
  return partText(row.content).slice(0, MAX_BODY_CHARS);
}
