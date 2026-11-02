import { useState, type ReactNode } from "react";
import type { OpenDetail } from "./events";
import { ToolResultModal } from "./ToolResultModal";
import { DiffModal } from "./DiffModal";
import type { ToolFileSource } from "./tool-file-link";

/** Owns the open-state for a transcript's detail modals and renders the right one, so the Session
 *  transcript and the drilled Subagent transcript behave identically. `agentId` is set in the subagent
 *  view so a tool's full output is fetched from that subagent's own transcript file. `cwd` is the
 *  owning session's directory — the transcript→editor link (I-b) resolves file candidates against
 *  it (per agent×location); passing null cwd turns the affordance off in call sites that don't
 *  know a session directory. Returns the `onOpen` to hand to the feed and the `modals` node to
 *  render alongside it. */
export function useTranscriptModals(
  sessionId: string,
  agentId?: string,
  cwd?: string | null,
): { onOpen: (detail: OpenDetail) => void; modals: ReactNode } {
  const [open, setOpen] = useState<OpenDetail | null>(null);
  const source: ToolFileSource | null = cwd
    ? { sessionId, cwd, platform: window.api.platform }
    : null;
  const modals = (
    <>
      {open?.kind === "tool" && (
        <ToolResultModal
          sessionId={sessionId}
          agentId={agentId}
          linkSource={source}
          tool={open.tool}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === "diff" && (
        <DiffModal
          diff={open.diff}
          linkSource={source}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
  return { onOpen: setOpen, modals };
}
