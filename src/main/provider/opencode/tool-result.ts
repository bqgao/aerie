import type { ToolResultDetail } from "@shared/transcript";
import { asRecord } from "../codex/rollout";
import {
  friendlyCommand,
  toolOutputText,
  type OpencodeMessage,
} from "./transcript-events";

/** The tool-output cap for the drill-in modal (~100k chars) — beyond it, the modal shows a head
 *  slice plus nothing else; the transcript row's line count is exact anyway, and no read of the
 *  modal has ever needed the tail of a multi-megabyte log. */
const MAX_TOOL_OUTPUT_CHARS = 100_000;

/**
 * Pull one tool call's full detail out of a session's message list (the pure core; index.ts feeds
 * it the cached messages): the friendly command from the tool part's input, the complete output +
 * status from the same part's state (v2 keeps input/output/state on ONE part, unlike codex's
 * call/output pair — no id pairing needed). `found: false` when no tool part carries the id — a
 * session the sweep hasn't cached, or a non-tool use. A completed-but-metadata-error or `error`
 * state reads error; read fresh on every fetch, so the modal trusts this over the row event's
 * status. The opencode analog of claude/tool-result.ts over message parts.
 */
export function extractToolResult(
  messages: OpencodeMessage[],
  toolUseId: string,
): ToolResultDetail {
  if (!toolUseId) return { found: false };
  let command: string | null = null;
  let output = "";
  let name = "";
  let status: "ok" | "error" | "pending" = "pending";
  let saw = false;
  for (const message of messages) {
    const rec = asRecord(message);
    const content = Array.isArray(rec?.content) ? rec.content : [];
    for (const part of content) {
      const p = asRecord(part);
      if (!p || p.type !== "tool" || p.id !== toolUseId) continue;
      saw = true;
      name = typeof p.name === "string" ? p.name : "tool";
      const state = asRecord(p.state);
      if (!state) continue;
      // An input-less state (the error case verified live) still lands a label: produced via
      // `command || name`, so the modal's command bar reads the tool name instead of blank.
      const produced = friendlyCommand(name, asRecord(state.input)) || name;
      command = produced;
      const isError =
        state.status === "error" || !!asRecord(state.metadata)?.error;
      status = isError
        ? "error"
        : state.status === "completed"
          ? "ok"
          : "pending";
      const text = toolOutputText(state);
      // An errored state may carry its diagnosis ONLY in state.error (input can be {} — the
      // tool.input-incomplete case verified live), so surface its message as the modal's output.
      const errRecord = asRecord(state.error);
      const errorMessage =
        typeof errRecord?.message === "string" ? errRecord.message : "";
      output =
        text ||
        (state.status === "error" ? errorMessage || "tool call failed" : "");
      output = output.slice(0, MAX_TOOL_OUTPUT_CHARS);
    }
  }
  if (!saw) return { found: false };
  return {
    found: true,
    // The label is guaranteed non-empty: oneLiner output or the tool's name (see above).
    command: command ?? name,
    output,
    status,
  };
}
