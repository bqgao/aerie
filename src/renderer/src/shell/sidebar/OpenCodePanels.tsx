import { CORE_TOKEN_KINDS } from "../../ui/token-kinds";
import { useI18n } from "../../i18n";
import { PressurePanel } from "../../workspace/panels/PressurePanel";
import { SpendPanel } from "../../workspace/panels/SpendPanel";
import { TokenSpeedPanel } from "../../workspace/panels/TokenSpeedPanel";
import { SessionPanel } from "../SessionPanel";
import { SectionDivider } from "./SectionDivider";
import type { SidebarPanelsProps } from "./index";

/** OpenCode's telemetry stack, mirroring Codex's (no account fill — Account is Claude-derived and
 *  must never backfill another agent's windows; no Duty — the v2 API carries no api-in-flight
 *  clock). One difference: the v2 session row carves real cost accounting (unlike codex), so the
 *  Spend heading carries its own info copy instead of the "no $" codex line. Cache-write tokens
 *  surface only as the combined row this pass — the 5m/1h split is a Claude-side cache concept the
 *  service doesn't break out, so the indented sub-rows would both be 0. */
export function OpenCodePanels({ session, metrics, doc }: SidebarPanelsProps) {
  const { t } = useI18n();
  return (
    <>
      <PressurePanel
        live={session.liveContext ?? null}
        context={doc?.context ?? null}
        contextPct={session.contextPct}
        contextWindow={session.contextWindow}
        account={null}
        rateLimits={null}
        windowRowsWhenFetchedOnly
      />
      <SectionDivider />
      <SpendPanel
        usageByModel={session.usageByModel ?? []}
        costUsd={session.costUsd ?? null}
        kinds={CORE_TOKEN_KINDS}
        info={t.dock.spend.infoOpenCode}
      />
      <SectionDivider />
      {/* Keyed by session — same sparkline-bleed rule as ClaudePanels/CodexPanels. */}
      <TokenSpeedPanel
        key={session.id}
        speed={metrics ? metrics.tokenSpeed : null}
      />
      <SectionDivider />
      <SessionPanel session={session} git={metrics?.git} pr={metrics?.pr} />
    </>
  );
}
