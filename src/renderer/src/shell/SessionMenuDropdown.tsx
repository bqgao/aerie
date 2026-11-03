import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import type { Session } from "@shared/types";
import { cx } from "../ui/atoms";
import { Icon, type IconName } from "../ui/icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useI18n } from "../i18n";
import { MENU_WIDTH, type SessionMenuController } from "./use-session-menu";
import { DiagnosticReportModal } from "./DiagnosticReportModal";
import { PromptQueueModal } from "./prompt-queue-modal";
import { AGENTS } from "@shared/agents";

/** The portaled dropdown body shared by every session-menu trigger: seven always-rendered action rows
 *  (only `disabled`/`title` vary — the design's "never hide an action, dim the unavailable ones with a
 *  reason" rule) plus the confirm dialogs Resume/Fork/End can raise. Pure rendering — all state lives in
 *  `useSessionMenu`. */
export function SessionMenuDropdown({
  session,
  menu,
}: {
  session: Session;
  menu: SessionMenuController;
}) {
  const {
    open,
    pos,
    menuId,
    menuRef,
    closeMenu,
    openEdit,
    diagnosticOpen,
    exportMarkdown,
    exportBusy,
    exportError,
    openDiagnostic,
    closeDiagnostic,
    pinned,
    togglePin,
    items,
    openInBusy,
    openInError,
    handleOpenIn,
    resume,
    fork,
    end,
    live,
    resumeDisabled,
    resumeTitle,
    forkDisabled,
    forkTitle,
    endTitle,
    queueOpen,
    openQueue,
    closeQueue,
    canPrompt,
    queuedCount,
    clearQueued,
    deleteOpen,
    openDelete,
    closeDelete,
    requestDelete,
    deleteDisabled,
    deleteTitle,
  } = menu;
  const { t } = useI18n();
  // Reveal-the-transcript failures are shown in the open menu (same in-band place the openIn
  // errors use); cleared whenever the menu closes so a stale error can't greet the next open.
  const [revealError, setRevealError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) setRevealError(null);
  }, [open]);
  const revealTranscript = async () => {
    const result = await window.api.sessionRevealTranscript(session.id);
    if (!result.ok) {
      setRevealError(
        result.error ?? t.shell.sessionMenu.revealTranscriptFailed,
      );
      return;
    }
    setRevealError(null);
    closeMenu();
  };

  return (
    <>
      {open && pos
        ? createPortal(
            <div
              id={menuId}
              ref={menuRef}
              role="menu"
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                width: MENU_WIDTH,
                // The full stack is taller than some windows are tall — clamp and scroll so the
                // lower items (Delete, Open-in) stay reachable when the menu opens low (2026-11
                // fix; `useSessionMenu.place()` pre-clamps the position, this covers the rest).
                maxHeight: "calc(100vh - 16px)",
                overflowY: "auto",
              }}
              className="z-50 rounded-lg border border-(--ui-stroke-secondary) bg-[color-mix(in_srgb,var(--ui-bg-elevated)_96%,transparent)] p-1.5 shadow-(--shadow-md) backdrop-blur-xl"
            >
              <MenuItem
                icon={pinned ? "pin-off" : "pin"}
                label={
                  pinned ? t.shell.sessionMenu.unpin : t.shell.sessionMenu.pin
                }
                onClick={togglePin}
              />
              <MenuItem
                icon="copy"
                label={t.shell.sessionMenu.copySessionId}
                title={session.id}
                onClick={() => {
                  void window.api.clipboardWriteText(session.id);
                  closeMenu();
                }}
              />
              <MenuItem
                icon="stethoscope"
                label={t.shell.sessionMenu.diagnosticReport}
                onClick={openDiagnostic}
              />
              <MenuItem
                icon="download"
                label={
                  exportBusy
                    ? t.shell.sessionMenu.exportBusy
                    : t.shell.sessionMenu.exportMarkdown
                }
                onClick={() => void exportMarkdown()}
              />
              {exportError ? (
                <p className="px-3 pb-1 text-meta text-(--ui-danger)">
                  {exportError}
                </p>
              ) : null}
              <MenuItem
                icon="pencil"
                label={t.shell.sessionMenu.rename}
                onClick={openEdit}
              />
              <MenuItem
                // Tier-1 Run 2 / A4: the prompt queue's only input affordance — prompt-capable
                // agents get the opener; others see the dimmed item with the standard reason.
                icon="message-square"
                label={t.shell.promptQueue.menuLabel}
                onClick={openQueue}
                disabled={!canPrompt}
                title={
                  canPrompt
                    ? undefined
                    : t.shell.sessionMenu.comingSoonForAgent(
                        AGENTS[session.agent].label,
                      )
                }
              />
              <MenuItem
                // Tier-1 Run 2 / A4: the queue's menu-side clear ("clear via menu") — pinned to
                // the prompt menu item, dimmed while nothing is queued.
                icon="x"
                label={t.shell.promptQueue.clearQueue}
                onClick={clearQueued}
                disabled={queuedCount === 0}
              />

              {resume.error && (
                <p role="alert" className="px-2 py-1 text-xs text-danger">
                  {resume.error}
                </p>
              )}
              <MenuItem
                icon="git-pull-request-arrow"
                label={
                  resume.busy
                    ? t.shell.sessionMenu.resuming
                    : t.shell.sessionMenu.resume
                }
                onClick={resume.request}
                disabled={resumeDisabled || resume.busy}
                title={resumeTitle}
              />

              {fork.error && (
                <p role="alert" className="px-2 py-1 text-xs text-danger">
                  {fork.error}
                </p>
              )}
              <MenuItem
                icon="git-branch"
                label={
                  fork.busy
                    ? t.shell.sessionMenu.forking
                    : t.shell.sessionMenu.fork
                }
                onClick={fork.request}
                disabled={forkDisabled || fork.busy}
                title={forkTitle}
              />

              <MenuItem
                icon="square"
                label={t.shell.sessionMenu.endSession}
                onClick={end.request}
                disabled={!live}
                title={endTitle}
                danger
              />

              <MenuItem
                // B-side delete-record: hides this session from every list surface (tombstoned
                // so the next sync can't re-add it; transcript stays on disk). Ended sessions
                // only — a live one must be ended first, same shape as the End item's gating.
                icon="trash"
                label={t.shell.sessionMenu.delete}
                onClick={openDelete}
                disabled={deleteDisabled}
                title={deleteTitle}
                danger
              />

              <div
                role="separator"
                aria-orientation="horizontal"
                className="my-1 h-px bg-(--ui-stroke-tertiary)"
              />

              <div className="px-2 pb-1 pt-0.5 text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-(--theme-primary)">
                {t.shell.sessionMenu.openIn}
              </div>
              {items.map((item) => (
                <MenuItem
                  key={item.key}
                  icon={item.icon}
                  label={item.label}
                  onClick={() => void handleOpenIn(item.key)}
                  disabled={openInBusy}
                />
              ))}
              {openInError && (
                <p role="alert" className="mt-1 px-2 py-1 text-xs text-danger">
                  {openInError}
                </p>
              )}
              {AGENTS[session.agent].capabilities.hasTranscript && (
                <MenuItem
                  icon="scroll-text"
                  label={t.shell.sessionMenu.revealTranscript}
                  onClick={() => void revealTranscript()}
                />
              )}
              {revealError && (
                <p role="alert" className="mt-1 px-2 py-1 text-xs text-danger">
                  {revealError}
                </p>
              )}
            </div>,
            document.body,
          )
        : null}

      {resume.confirmOpen && (
        <ConfirmDialog
          title={t.shell.sessionMenu.resumeConfirmTitle}
          body={t.shell.sessionMenu.resumeConfirmBody}
          confirmLabel={t.shell.sessionMenu.resumeConfirmLabel}
          onCancel={resume.confirmNo}
          onConfirm={resume.confirmYes}
        />
      )}
      {fork.confirmOpen && (
        <ConfirmDialog
          title={t.shell.sessionMenu.forkConfirmTitle}
          body={t.shell.sessionMenu.forkConfirmBody}
          confirmLabel={t.shell.sessionMenu.forkConfirmLabel}
          onCancel={fork.confirmNo}
          onConfirm={fork.confirmYes}
        />
      )}
      {end.confirmOpen && (
        <ConfirmDialog
          title={t.shell.sessionMenu.endConfirmTitle}
          body={t.shell.sessionMenu.endConfirmBody}
          confirmLabel={t.shell.sessionMenu.endSession}
          tone="danger"
          onConfirm={end.confirmYes}
          onCancel={end.confirmNo}
        />
      )}
      {deleteOpen && (
        <ConfirmDialog
          title={t.shell.sessionMenu.deleteConfirmTitle}
          body={t.shell.sessionMenu.deleteConfirmBody(
            session.title || session.id,
          )}
          confirmLabel={t.shell.sessionMenu.deleteConfirmLabel}
          tone="danger"
          onConfirm={requestDelete}
          onCancel={closeDelete}
        />
      )}
      {diagnosticOpen && (
        <DiagnosticReportModal
          sessionId={session.id}
          onClose={closeDiagnostic}
        />
      )}
      {queueOpen && <PromptQueueModal session={session} onClose={closeQueue} />}
    </>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  title,
  danger,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-xs px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:bg-(--ui-control-hover-background) disabled:cursor-default disabled:opacity-40",
        danger
          ? "text-danger enabled:hover:bg-danger/10"
          : "text-fg-muted enabled:hover:bg-(--ui-control-hover-background) enabled:hover:text-fg",
      )}
    >
      <Icon name={icon} size={13} />
      {label}
    </button>
  );
}
