import { useI18n } from "../i18n";
import { cx } from "../ui/atoms";

/**
 * The prompt queue's row badge (tier-1 spec Run 2 / A4): the parked count when anything is
 * queued, warning-colored while the head carries its in-band failure; the failed reason itself
 * rides next to it as the row's truncated one-line error (full text on the title). Shared by
 * SessionRow and PinnedSessionRow so the badge can't drift between the two row shapes.
 */
export function QueueBadge({
  count,
  error,
  className,
}: {
  count: number;
  error: string | null;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <span className={cx("flex min-w-0 shrink-0 items-center gap-1", className)}>
      {count > 0 && (
        <span
          className={cx(
            "rounded-full px-1.5 text-[0.64rem] leading-[1.1rem] tabular-nums",
            error
              ? "bg-accent text-[#171717]"
              : "bg-(--ui-control-active-background) text-(--ui-text-tertiary)",
          )}
          title={
            error != null && error !== ""
              ? `${t.shell.promptQueue.queuedPrompts(count)} · ${error}`
              : t.shell.promptQueue.queuedPrompts(count)
          }
        >
          {count}
        </span>
      )}
      {error != null && (
        <span
          className="min-w-0 shrink-[2] truncate text-[0.72rem] leading-none text-accent"
          title={error}
        >
          {error}
        </span>
      )}
    </span>
  );
}
