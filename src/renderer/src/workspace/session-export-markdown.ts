import type { DiffHunk } from "@shared/transcript";
import type { TranscriptDoc } from "@shared/transcript";

/** Bump the fence when the content itself contains one (nesting safety). */
function fenceFor(content: string): string {
  let fence = "``";
  while (content.includes(fence)) fence += "`";
  return fence;
}

function renderDiff(hunk: DiffHunk): string {
  const lines: string[] = [];
  for (const line of hunk.removed) lines.push("- " + line);
  for (const line of hunk.added) lines.push("+ " + line);
  if (!lines.length) return "";
  const fence = fenceFor(lines.join("\n"));
  return fence + "diff\n" + lines.join("\n") + "\n" + fence + "\n";
}

/** Serialize one session transcript to GitHub-flavored Markdown. */
export function toExportMarkdown(doc: TranscriptDoc, meta: ExportMeta): string {
  const out: string[] = [];
  out.push("# " + (meta.title || "Session transcript"));
  out.push("");
  out.push(
    "> Agent: **" +
      meta.agent +
      "** \u00b7 Exported: " +
      new Date(meta.exportedMs).toISOString(),
  );
  if (meta.project) out.push("> Project: `" + meta.project + "`");
  out.push("");
  for (const event of doc.events) {
    if (event.kind === "user") {
      out.push("## \ud83d\udc64 User");
      out.push("");
      out.push(event.text);
      out.push("");
    } else if (event.kind === "assistant") {
      out.push("## \ud83e\udd16 Assistant");
      out.push("");
      out.push(event.text);
      out.push("");
    } else if (event.kind === "thinking") {
      const fence = fenceFor(event.text);
      out.push("<details><summary>\ud83d\udce3 Thinking</summary>");
      out.push("");
      out.push(fence + "\n" + event.text + "\n" + fence);
      out.push("");
      out.push("</details>");
      out.push("");
    } else if (event.kind === "tool") {
      out.push(
        "- \ud83d\udee0\ufe0f **Tool " +
          event.name +
          "** \u2014 " +
          event.input +
          " _(" +
          event.status +
          ", " +
          event.outputLines +
          " lines)_",
      );
    } else if (event.kind === "diff") {
      out.push(
        "**" + event.tool + " " + event.file + "** _(" + event.status + ")",
      );
      out.push("");
      const d = renderDiff(event.hunk);
      if (d) {
        out.push(d);
        out.push("");
      }
    } else if (event.kind === "subagent") {
      out.push(
        "- \ud83e\udd16 Subagent **" +
          event.agentType +
          "** \u2014 " +
          event.description,
      );
    }
  }
  if (doc.waitingReason) {
    out.push("---");
    out.push("");
    out.push("> \u23f3 Waiting: " + doc.waitingReason);
  }
  return out.join("\n");
}

export interface ExportMeta {
  title: string;
  agent: string;
  project: string | null;
  exportedMs: number;
}
