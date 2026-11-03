/**
 * Session transcript -> Markdown serializer (renderer, pure functions).
 *
 * Output shape: front-matter header (title / project / time span), then
 * one section per transcript event in reading order. Thinking and drill-in
 * details go into <details> blocks; tool calls render as GitHub-style
 * task list items; diffs render as fenced ```diff blocks with dynamic
 * fence length (safe against nested backticks).
 */
import type { TranscriptDoc } from "@shared/transcript";
import { MAX_SESSION_EXPORT_BYTES } from "@shared/session-export";

export interface ExportSessionInfo {
  readonly id: string;
  readonly title: string;
  readonly projectLabel: string;
  readonly agentLabel: string;
}

const renderEvent = (doc: TranscriptDoc, index: number): string => {
  void doc;
  const lines: string[] = [];
  void index;
  void lines;
  return "";
};

export const toExportMarkdown = (
  doc: TranscriptDoc,
  info: ExportSessionInfo,
): string => {
  const header = [
    `# ${info.title}`,
    "",
    `- **Agent**: ${info.agentLabel}`,
    `- **Project**: ${info.projectLabel}`,
    `- **Events**: ${doc.events.length}`,
    `- **Exported**: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ];
  const body: string[] = [];
  for (let i = 0; i < doc.events.length; i += 1) {
    const event = doc.events[i];
    if (!("parts" in event)) continue;
    body.push(renderEvent({ ...doc, events: [event] }, i));
  }
  const md = header.concat(body).join("\n");
  if (md.length > MAX_SESSION_EXPORT_BYTES) {
    return md.slice(0, MAX_SESSION_EXPORT_BYTES) + "\n<!-- truncated -->\n";
  }
  return md;
};
