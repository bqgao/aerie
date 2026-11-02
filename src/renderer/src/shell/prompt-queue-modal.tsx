import { useStore } from "@nanostores/react";
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Session } from "@shared/types";
import { AGENTS } from "@shared/agents";
import { cx } from "../ui/atoms";
import { Icon } from "../ui/icons";
import { ModalShell } from "../ui/ModalShell";
import { useI18n } from "../i18n";
import {
  $promptQueues,
  clearPromptsFor,
  enqueuePromptFor,
  promptEntryId,
  queueOf,
} from "./prompt-queue";

/**
 * The rail row's "Queue prompt…" modal (tier-1 spec Run 2 / A4): a small queue view (read-only —
 * v1 queues are visible but not editable or reorderable) plus the one input — a textarea where
 * Enter queues and Shift+Enter breaks lines. Queued prompts park while the session works and
 * auto-send one per poll tick once it returns to waiting; failures keep the head and surface
 * the service's own reason in band (the modal shows it exactly where it landed).
 */
export function PromptQueueModal({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const queues = useStore($promptQueues);
  const [draft, setDraft] = useState("");
  const entries = queueOf(queues, session.id).entries;

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey) return; // Shift+Enter is a newline
    e.preventDefault();
    const text = draft.trim();
    if (text === "") return;
    enqueuePromptFor(session.id, promptEntryId(), text);
    setDraft("");
  }

  const disabled = !AGENTS[session.agent].capabilities.canPrompt;
  return (
    <ModalShell
      labelledBy="prompt-queue-title"
      widthClass="w-[26rem]"
      onClose={onClose}
    >
      <div className="p-4">
        <div className="flex items-center gap-2">
          <span className="grid size-3.5 shrink-0 place-items-center text-(--ui-text-tertiary)">
            <Icon name="message-square" size={14} />
          </span>
          <h2
            id="prompt-queue-title"
            className="min-w-0 flex-1 truncate text-[0.9rem] font-semibold text-fg"
          >
            {t.shell.promptQueue.modalTitle}
          </h2>
        </div>

        <div className="mt-3 flex flex-col gap-1">
          {entries.length === 0 ? (
            <p className="px-1 py-2 text-xs text-(--ui-text-quaternary)">
              {t.shell.promptQueue.modalEmpty}
            </p>
          ) : (
            entries.map((entry, index) => (
              <div
                key={entry.id}
                className="flex min-w-0 items-start gap-2 rounded-md bg-(--ui-control-active-background) px-2 py-1.5"
              >
                <span className="shrink-0 pt-px text-[0.64rem] tabular-nums text-(--ui-text-quaternary)">
                  {index + 1}
                </span>
                <span
                  className={cx(
                    "min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-fg-muted",
                    entry.error !== undefined && "text-fg",
                  )}
                >
                  {entry.text}
                </span>
                {entry.error !== undefined && (
                  <span className="shrink-0 text-[0.64rem] leading-4 text-accent">
                    {entry.error}
                  </span>
                )}
              </div>
            ))
          )}
        </div>

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t.shell.promptQueue.placeholder}
          aria-label={t.shell.promptQueue.inputLabel}
          rows={3}
          disabled={disabled}
          className="mt-3 w-full resize-none rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) px-2 py-1.5 text-[0.8125rem] text-fg placeholder:text-(--ui-text-tertiary) focus:border-(--ui-stroke-secondary) focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[0.64rem] text-(--ui-text-quaternary)">
            {t.shell.promptQueue.modalHint}
          </p>
          {entries.length > 0 && (
            <button
              type="button"
              onClick={() => clearPromptsFor(session.id)}
              className="shrink-0 rounded-sm px-1.5 py-0.5 text-[0.625rem] text-(--ui-text-tertiary) transition-colors duration-100 hover:bg-(--ui-control-hover-background) hover:text-fg hover:transition-none"
            >
              {t.shell.promptQueue.clearQueue}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
