import type { Session } from "@shared/types";
import { useI18n } from "../i18n";
import { cx } from "../ui/atoms";
import { inboxReason, inboxReasonText } from "./inbox-model";

/**
 * The Inbox row chip (tier-1 spec Run 1 / A1): the session's waiting-on-user reason mapped to a
 * short localized label — the known permission wait names the tool it needs, an unmapped provider
 * reason degrades to the generic waiting label, and a live-but-idle session shows Idle (its lamp
 * already says so, but the rest of the row has nothing else to disarm). Shown only when the rail
 * is in Inbox mode; rendered next to the title, truncated — the full text stays on the title
 * attribute. Shared by SessionRow and PinnedSessionRow so the chip style and mapping can't drift.
 *
 * The preview card (A2) builds its own layout from `inboxReason`/`inboxReasonText` directly —
 * same mapping, different shape.
 */
export function SessionReasonChip({
  session,
  className,
}: {
  session: Session;
  /** Row-shape extras (the pinned row's line-2 baseline differs from SessionRow's). */
  className?: string;
}) {
  const { t } = useI18n();
  const label = inboxReasonText(inboxReason(session), {
    idle: t.shell.sidebar.reasonIdle,
    generic: t.shell.sidebar.reasonWaiting,
    permission: t.shell.sidebar.reasonPermission,
  });
  return (
    <span
      // aria: the text is real content; no title-only meaning.
      title={label}
      className={cx(
        "min-w-0 shrink-[2] truncate rounded-sm bg-(--ui-control-active-background) px-1 py-0.5 text-[0.625rem] leading-none text-(--ui-text-tertiary)",
        className,
      )}
    >
      {label}
    </span>
  );
}
