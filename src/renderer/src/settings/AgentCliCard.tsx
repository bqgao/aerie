import type { CliStatus } from "@shared/cli-status";
import { footerView } from "../ui/rail-footer";
import { Icon } from "../ui/icons";
import { Card } from "../shell/page-primitives";
import { useI18n } from "../i18n";
import {
  SubsystemHeader,
  ReadoutRow,
  FaultBand,
  RailButton,
  DocsLink,
  type LampTone,
} from "./system-primitives";

const TONE: Record<ReturnType<typeof footerView>["dot"], LampTone> = {
  ok: "live",
  warn: "warn",
  error: "error",
  idle: "idle",
};

/** The non-Claude agents' CLI subsystem card — one anatomy shared by every agent whose probe has
 *  no version floor remedies beyond "not detected": the Claude card's state rail/format with an
 *  agent-sized remedy band (install + docs link, no tab set) and no version floor text. Probes run
 *  through the same login-shell/PATHEXT spawn form (main/cli-check.ts); the agent-specific bits
 *  (card title, docs label/href) ride in as props so codex/opencode stay in one component. */
export function AgentCliCard({
  title,
  status,
  checking,
  onRecheck,
  notDetectedHeadline,
  docsHref,
  docsLabel,
  configFallback,
}: {
  title: string;
  status: CliStatus | null;
  checking: boolean;
  onRecheck: () => void;
  notDetectedHeadline: string;
  docsHref: string;
  docsLabel: string;
  /** The Config row's fallback when no probe verdict has landed yet. */
  configFallback: string;
}) {
  const { t } = useI18n();
  const word =
    status === null
      ? t.settings.cli.stateChecking
      : status.kind === "ready"
        ? t.settings.cli.stateReady
        : t.settings.cli.stateFault;
  return (
    <Card title={title}>
      <SubsystemHeader
        tone={TONE[footerView(status).dot]}
        word={word}
        action={
          <RailButton
            onClick={onRecheck}
            disabled={checking || status === null}
          >
            <Icon
              name="rotate-ccw"
              size={13}
              className={checking ? "animate-spin" : ""}
            />
            {t.settings.cli.recheck}
          </RailButton>
        }
      />
      {status && status.kind !== "ready" && (
        <FaultBand headline={notDetectedHeadline}>
          <DocsLink href={docsHref} label={docsLabel} />
        </FaultBand>
      )}
      <ReadoutRow
        label={t.settings.cli.version}
        value={
          status?.version ? `v${status.version}` : t.settings.cli.notDetected
        }
      />
      <ReadoutRow
        label={t.settings.cli.config}
        value={status?.configDir.active ?? configFallback}
      />
    </Card>
  );
}
