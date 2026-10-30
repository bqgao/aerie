import type {
  ContextBreakdown,
  DiffHunk,
  ToolEvent,
  TranscriptDoc,
  TranscriptEvent,
  TurnSummary,
} from "@shared/transcript";

/** The record-shape guard the codex module shares (src/main/provider/codex/rollout.ts) — the OpenCode
 *  API returns plain JSON objects, and every field below is read defensively off `unknown` so no shape
 *  surprise (v2 is young) can throw inside a poll. */
import { asRecord } from "../codex/rollout";

/** Tool names whose INPUT is an edit — these render as the diff event (hunk) instead of a plain tool
 *  row, like claude's Edit/Write. Lowercased: opencode's built-ins are the bare `edit`/`write`
 *  (verified live, v2.0.28: edit → {path, oldString, newString}; write → {path, content}), but the
 *  service can front agents that expose claude-style names (`str_replace_editor`), so the set is
 *  name-based, not client-specific. `write` shares the event kind: its `content` input is the added
 *  text with no old text known (the hunk's removed side stays empty — an added-only diff). */
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "save_file",
  "patch",
]);

/** Tools whose row should read the file/pattern they touched; everything else falls back to compact
 *  JSON of the input (truncated — the row is a hint; the drill-in modal carries full detail). */
const PATH_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "find",
  "ls",
  "webfetch",
  "websearch",
]);

/** Exact rendered line count of an output text (a trailing newline adds no phantom line) — same rule
 *  as codex's outputLineCount, so both agents' tool rows agree. */
const outputLineCount = (text: string): number =>
  text ? text.replace(/\n$/, "").split("\n").length : 0;

/** Tool state status → the shared pillar status. Verified live state union: `streaming` (input still
 *  arriving), `running` (executing), `completed` (output landed), `error` (failed — the state carries
 *  an `error` block). A completed call whose metadata carries `error` still reads error. Anything
 *  unknown degrades to error rather than a stuck "pending": the row is honest about being unmodeled. */
function partStatus(st: Record<string, unknown>): "ok" | "error" | "pending" {
  if (st.status === "completed")
    return asRecord(st.metadata)?.error ? "error" : "ok";
  if (st.status === "streaming" || st.status === "running") return "pending";
  return "error";
}

/** The edit hunk from an edit-shaped tool's input. Key fallbacks are ordered by the LIVE shapes first
 *  (v2.0.28 edit/write above), with claude-style snake aliases kept for fronted third-party agents. */
function hunkFromInput(input: Record<string, unknown>): DiffHunk {
  const str = (keys: string[]): string => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string") return v;
    }
    return "";
  };
  const removed = str(["oldString", "old_string"]);
  const added = str(["newString", "new_string", "content"]);
  return { removed: removed.split("\n"), added: added.split("\n") };
}

/** The file path an edit-shaped tool touched, under every key any fronted agent has used. */
function fileFromInput(input: Record<string, unknown>): string {
  for (const k of ["path", "file_path", "filePath", "file"]) {
    const v = input[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** One-line row label per tool shape: shell tools read the command; read/glob/grep/webfetch the
 *  target; edit-shaped the file; else compact JSON (truncated at 200). Shared with the drill-in
 *  modal via friendlyCommand below so the row and the modal can't name a call differently (codex
 *  toolCommand's sharing rule). */
export function oneLiner(name: string, input: Record<string, unknown>): string {
  const lower = name.toLowerCase();
  const s = (keys: string[]): string => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };
  if (lower === "bash" || lower === "shell" || lower === "zsh")
    return s(["command", "cmd"]);
  if (PATH_TOOLS.has(lower)) return s(["path", "pattern", "url", "query"]);
  if (EDIT_TOOLS.has(lower)) return fileFromInput(input);
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return "";
  }
}

/** The friendly command line the drill-in modal names the call by — the oneLiner rules. */
export function friendlyCommand(name: string, input: unknown): string {
  const r = asRecord(input);
  if (!r) return "";
  return oneLiner(name, r);
}

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/** The joined `text` of a tool output's content array (Tool.Content). */
export function toolOutputText(st: Record<string, unknown>): string {
  const content = st.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const r = asRecord(item);
    if (r && typeof r.text === "string" && r.text) parts.push(r.text);
  }
  return parts.join("\n");
}

/** Single-line turn label: the prompt's first non-empty line, capped like codex's promptLine. */
function promptLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t.slice(0, 120);
  }
  return "";
}

/** The visible tail of an unanswered prompt, capped so the Waiting banner can't run away. */
const truncateTail = (text: string): string =>
  text.length <= 200 ? text : `${text.slice(0, 197)}…`;

/** One message as the API serves it (live shape in OPENCODE_PROVIDER_SPEC.md). A loose record so
 *  callers hand over exactly what the wire sends. */
export type OpencodeMessage = Record<string, unknown>;

/**
 * Project the session's message list into render-ready events — the OpenCode analog of
 * parseRolloutEvents, targeting the same shared TranscriptDoc so the renderer needs no opencode
 * wiring. Message-level walk, oldest-first (the API serves newest-first; the provider sorts), each
 * message's content parts in order: text → user/assistant, reasoning → thinking, tool → the diff
 * event for edit-shaped tools else the tool row. Context rides the last assistant message's tokens.
 *
 * Waiting reason, mirroring claude's transcript-tail verdict: a trailing user text with nothing
 * after it → that prompt (first line, truncated); a trailing still-pending tool → that tool; else
 * null (the state machine resets whenever an assistant text or a later message answers).
 *
 * `idle` / `synthetic` / `model-switched` message types and `step-start`-style unknown parts are
 * ignored — forward-compatible with a v2 API that interleaves control rows between turns. Tolerant
 * like every provider parser: no message or part shape may throw.
 */
export function buildTranscriptDoc(
  messages: OpencodeMessage[],
): Omit<TranscriptDoc, "subagents"> {
  const events: TranscriptEvent[] = [];
  const turns: TurnSummary[] = [];
  // Turns split at user messages; the open turn fills from the user part and closes when the next
  // user arrives or at the last assistant completion seen in the span.
  let open: TurnSummary | null = null;
  let lastAssistantEnd = 0;
  let context: ContextBreakdown | null = null;
  // Waiting-reason inputs: the last user text, and the last tool row still pending at the tail.
  let lastUserText: string | null = null;
  let trailingUser = false;
  let trailingPendingToolName: string | null = null;
  let trailingPendingToolInput: Record<string, unknown> | null = null;

  const closeTurn = (endMs: number): void => {
    if (!open) return;
    open.endMs = Math.max(open.endMs, endMs);
    open.durationMs = Math.max(0, open.endMs - open.startMs);
    turns.push(open);
    open = null;
  };

  for (const message of messages) {
    const rec = asRecord(message);
    if (!rec) continue;
    const mType = rec.type;
    const time = asRecord(rec.time);
    const createdMs = num(time?.created);
    // Only the two conversational types render; idle/model-switched/synthetic are control rows.
    if (mType !== "user" && mType !== "assistant") continue;
    const content = Array.isArray(rec.content) ? rec.content : [];
    const tokens = asRecord(rec.tokens);
    const cache = asRecord(tokens?.cache);

    if (mType === "user") {
      let first = true;
      for (const part of content) {
        const p = asRecord(part);
        if (!p || p.type !== "text") continue;
        const text = typeof p.text === "string" ? p.text : "";
        if (!text.trim()) continue;
        events.push({ kind: "user", text });
        if (first) {
          // A new prompt closes the previous turn and opens the next — the shared TurnSummary rule
          // (startMs = the prompt's created; endMs fills from tools/assistant within the span).
          closeTurn(Math.max(createdMs, lastAssistantEnd));
          open = {
            index: turns.length + 1,
            prompt: promptLine(text),
            startMs: createdMs,
            endMs: createdMs,
            durationMs: 0,
            toolCount: 0,
          };
          lastUserText = text;
          trailingUser = true;
          trailingPendingToolName = null;
          trailingPendingToolInput = null;
          first = false;
        }
      }
      continue;
    }

    // assistant: any assistant message after a prompt means the agent took it — an unanswered
    // trailing prompt only survives while every row after it is server control (idle etc.).
    trailingUser = false;
    for (const part of content) {
      const p = asRecord(part);
      if (!p) continue;
      const pt = p.type;
      if (pt === "reasoning") {
        const text = typeof p.text === "string" ? p.text : "";
        if (text.trim()) events.push({ kind: "thinking", text });
        continue;
      }
      if (pt === "text") {
        const text = typeof p.text === "string" ? p.text : "";
        if (!text.trim()) continue;
        events.push({ kind: "assistant", text });
        // Assistant text answered whatever hung before it — the prompt is no longer trailing.
        trailingUser = false;
        trailingPendingToolName = null;
        trailingPendingToolInput = null;
        continue;
      }
      if (pt === "tool") {
        const name = typeof p.name === "string" && p.name ? p.name : "tool";
        const state = asRecord(p.state);
        if (!state) continue;
        const input = asRecord(state.input) ?? {};
        const id = typeof p.id === "string" ? p.id : "";
        if (open) open.toolCount++;
        const status = partStatus(state);
        const pendingTool = (): void => {
          if (status === "pending") {
            trailingPendingToolName = name;
            trailingPendingToolInput = input;
          } else {
            trailingPendingToolName = null;
            trailingPendingToolInput = null;
          }
        };
        if (EDIT_TOOLS.has(name.toLowerCase())) {
          events.push({
            kind: "diff",
            tool: name,
            file: fileFromInput(input),
            hunk: hunkFromInput(input),
            status,
          });
          pendingTool();
          continue;
        }
        const event: ToolEvent = {
          kind: "tool",
          name,
          input: oneLiner(name, input),
          toolUseId: id,
          status,
          outputLines: outputLineCount(toolOutputText(state)),
        };
        events.push(event);
        pendingTool();
        continue;
      }
      // step-start / step-finish / unknown provider-control parts: skipped, forward-compatible.
    }
    // The context split rides the LAST assistant message that reported token usage — message-level
    // TokenUsage.Info (the same split summarize persists), not per-tool.
    if (tokens) {
      const input = num(tokens.input);
      const cacheRead = num(cache?.read);
      const cacheWrite = num(cache?.write);
      if (input > 0 || cacheRead > 0 || cacheWrite > 0)
        context = { input, cacheRead, cacheCreation: cacheWrite };
    }
    const completed = num(time?.completed) || num(time?.streamed);
    if (completed) {
      lastAssistantEnd = Math.max(lastAssistantEnd, completed);
      if (open) open.endMs = Math.max(open.endMs, completed);
      trailingPendingToolName = null;
      trailingPendingToolInput = null;
    }
  }
  closeTurn(lastAssistantEnd);

  const waitingReason =
    trailingUser && lastUserText
      ? truncateTail(promptLine(lastUserText))
      : trailingPendingToolName
        ? friendlyCommand(trailingPendingToolName, trailingPendingToolInput) ||
          trailingPendingToolName
        : null;

  return { events, waitingReason, turns, context };
}
