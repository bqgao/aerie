import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AGENTS } from "@shared/agents";
import type { Session } from "@shared/types";
import { Icon } from "../ui/icons";
import { useI18n } from "../i18n";
import { useSessionMenu } from "../shell/use-session-menu";
import { PromptQueueModal } from "../shell/prompt-queue-modal";
import {
  canShowComposer,
  composerDisabledReason,
  sendGuard,
} from "./chat-composer-model";

/**
 * The workspace's chat composer (tier-1 spec Run 2 / A4): a slim footer bar for CONTINUING
 * a prompt-capable session in-app — Enter sends through the same opencodePrompt op the
 * rail's prompt queue rides (never a new channel). Success lands via the existing
 * transcript poll (no new event stream); failure surfaces the in-band reason one line
 * under the composer, dismissible by typing again.
 *
 * While the session works the bar stays (disabled) with the queue hint — clicking it opens
 * the SAME modal the session menu opens (the useSessionMenu hook action + PromptQueueModal,
 * not a duplicate). The Send busy state is a local optimistic flag that the next
 * poll-driven session update clears; from then on session.state "working" is the real
 * disable signal. Gating rules live in chat-composer-model.ts (tested).
 */
export function ChatComposer({
  session,
  canSpawn,
  onResume,
  onFork,
  onEnd,
  onRename,
  onTogglePin,
  onDeleteSessions,
}: {
  session: Session;
  /** Whether the agent CLI is usable; threaded to useSessionMenu exactly like SessionMenu. */
  canSpawn: boolean;
  onResume: (id: string) => Promise<void>;
  onFork: (session: Session) => Promise<void>;
  onEnd: (id: string) => void;
  onRename: (id: string, title: string | null) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onDeleteSessions: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const caps = AGENTS[session.agent].capabilities;
  // The same hook action the session menu rides (openQueue); this instance mounts the same
  // PromptQueueModal the menu's own instance does — the two never share state.
  const { queueOpen, openQueue, closeQueue } = useSessionMenu(
    session,
    canSpawn,
    {
      onResume,
      onFork,
      onEnd,
      onRename,
      onTogglePin,
      onDeleteSessions,
    },
  );
  const [draft, setDraft] = useState("");
  /** The optimistic send flag; the next poll-driven session update clears it (effect below). */
  const [sending, setSending] = useState(false);
  /** The last send's in-band failure reason; cleared the moment the user types again. */
  const [error, setError] = useState<string | null>(null);

  const busy = composerDisabledReason(caps, session.state) === "busy";

  // App's sessions poll re-renders Workspace with a fresh session object every tick, so
  // this clears the optimistic flag once the poll catches up (the working state — or the
  // session's return to waiting — takes over from here on).
  useEffect(() => {
    setSending(false);
  }, [session]);

  if (!canShowComposer(caps, session.state)) return null;

  function send(): void {
    if (busy || sending) return;
    if (!sendGuard(draft).ok) return; // empty text never sends
    const text = draft.trim();
    setDraft("");
    setError(null);
    setSending(true);
    void (async () => {
      try {
        const result = await window.api.opencodePrompt(session.id, text);
        if (result.ok) return; // the transcript poll shows the message; sending clears next tick
        setError(result.error ?? t.workspace.chatComposer.sendFailed);
        setSending(false);
      } catch {
        // opencodePrompt never rejects; this only satisfies the dispatch seam (App's own
        // sendQueuedPrompt carries the same defensive tail).
        setError(t.workspace.chatComposer.sendFailed);
        setSending(false);
      }
    })();
  }

  return (
    <>
      <div className="flex shrink-0 flex-col gap-1 border-t border-(--ui-stroke-tertiary) px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            aria-label={t.workspace.chatComposer.inputLabel}
            className="min-w-0 flex-1 resize-none rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) px-2 py-1.5 text-[0.8125rem] text-fg placeholder:text-(--ui-text-tertiary) focus:border-(--ui-stroke-secondary) focus:outline-none disabled:opacity-50"
            disabled={busy || sending}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null); // typing again dismisses the last failure
            }}
            onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault(); // Enter sends; Shift+Enter is a newline
                send();
              } else if (event.key === "Escape") {
                event.currentTarget.blur();
              }
            }}
            placeholder={t.workspace.chatComposer.placeholder}
            rows={2}
            value={draft}
          />
          <button
            aria-label={t.workspace.chatComposer.send}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-body font-medium text-ink-950 ring-1 ring-primary/40 transition-colors hover:bg-primary-bright disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || sending}
            onClick={send}
            type="button"
          >
            {sending ? (
              <Icon className="animate-spin" name="loader-circle" size={14} />
            ) : (
              t.workspace.chatComposer.send
            )}
          </button>
        </div>
        {busy ? (
          <button
            className="self-start rounded-sm px-1.5 py-0.5 text-[0.625rem] text-(--ui-text-tertiary) transition-colors duration-100 hover:bg-(--ui-control-hover-background) hover:text-fg hover:transition-none"
            onClick={openQueue}
            type="button"
          >
            {t.workspace.chatComposer.busyHint}
          </button>
        ) : error !== null ? (
          <p className="truncate px-1 text-[0.64rem] text-accent">{error}</p>
        ) : null}
      </div>
      {queueOpen && <PromptQueueModal session={session} onClose={closeQueue} />}
    </>
  );
}
