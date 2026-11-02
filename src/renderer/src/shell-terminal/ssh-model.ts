/**
 * Renderer-side state + pure decision logic for the S2 SSH terminals: the per-tab session state
 * map (the lamp and the lock overlay read it), the Reconnect dial epochs, the Servers section's
 * polled store, and the double-click reducer that decides revive-in-place vs focus vs a new tab
 * (DESIGN_NOTES §S2: reconnects REUSE the dropped tab; multiple tabs to one server are explicit
 * only). `window`-guarded so this file loads under node tests without jsdom, with the reducer
 * lib-free (test-reachable types stay .ts).
 */
import { atom } from "nanostores";
import type { ServerProfile, ServerStatusMap } from "@shared/servers";
import {
  $terminals,
  createSshTerminal,
  selectTerminal,
  type TerminalEntry,
} from "./terminals";
import { setTerminalTakeover } from "./store";

/** Per-tab session state, the S2 lamp vocabulary (same hues as the ServerCard lamp):
 *  connecting → connected → dropped. Keyed by RENDERER tab id. */
export type SshTabState = "connecting" | "connected" | "dropped";

export const $sshTabState = atom<ReadonlyMap<string, SshTabState>>(new Map());

export function setSshTabState(id: string, state: SshTabState): void {
  const next = new Map($sshTabState.get());
  next.set(id, state);
  $sshTabState.set(next);
}

/** Instance unmount / tab removal: no entry → no stale lamp or revive-in-place match. */
export function clearSshTabState(id: string): void {
  const next = new Map($sshTabState.get());
  next.delete(id);
  $sshTabState.set(next);
}

/** Dial epochs per ssh tab: bumps re-arm the instance's spawn effect (Reconnect), while the xterm
 *  instance and its buffer stay put — same tab, same text, fresh channel. */
export const $sshDialAttempt = atom<ReadonlyMap<string, number>>(new Map());

export function sshDialAttemptOf(id: string): number {
  return $sshDialAttempt.get().get(id) ?? 0;
}

/** Re-arm one ssh tab: state flips to connecting so overseers (sidebar row, rail lamp, overlay)
 *  show the new dial, and the instance's effect re-fires on the epoch change. Returns the epoch. */
export function reconnectSshTerminal(id: string): number {
  const next = new Map($sshDialAttempt.get());
  const epoch = (next.get(id) ?? 0) + 1;
  next.set(id, epoch);
  $sshDialAttempt.set(next);
  setSshTabState(id, "connecting");
  return epoch;
}

/** The Servers section's store: profiles' safe half only (no credential material ever) plus the
 *  pool's status map (sticky lastError included) — polled at the same 3s cadence as ServerCard. */
export const $serverProfiles = atom<readonly ServerProfile[]>([]);
export const $serverStatus = atom<ServerStatusMap>({});

export async function refreshServers(): Promise<void> {
  if (typeof window === "undefined") return;
  const [list, status] = await Promise.all([
    window.api.serversList(),
    window.api.serversStatus(),
  ]);
  $serverProfiles.set(list);
  $serverStatus.set(status);
}

/** Decision input for one server's double-click: the tab list + per-tab session states narrow it.
 *  `tabs`/`tabStates` are passed (not read from the stores) so the reducer is pure and testable. */
export type ServerTerminalPlan =
  | { action: "revive"; tabId: string }
  | { action: "focus"; tabId: string }
  | { action: "new" };

export function planServerTerminalOpen({
  serverId,
  tabs,
  tabStates,
}: {
  serverId: string;
  tabs: readonly TerminalEntry[];
  tabStates: ReadonlyMap<string, SshTabState>;
}): ServerTerminalPlan {
  const riding = tabs.filter(
    (t) => t.kind === "ssh" && t.serverId === serverId,
  );
  if (riding.length === 0) return { action: "new" };
  // A dropped tab revives in place (buffer preserved) before anything else stacks.
  const dropped = riding.find((t) => tabStates.get(t.id) === "dropped");
  if (dropped) return { action: "revive", tabId: dropped.id };
  // Connected or mid-dial: focus the newest riding tab rather than stacking a second one —
  // duplicating a running terminal to the same server is the explicit menu item's job.
  return { action: "focus", tabId: riding[riding.length - 1].id };
}

/** Execute the double-click/menu plan for one server: revive re-dials its tab (buffer preserved),
 *  focus selects it, new creates the optimistic ssh tab and lets the instance's dial own the
 *  spawn — so a refused dial (auth failure / unreachable host) closes the tab before anything
 *  renders and the sticky reason stays on the sidebar row. */ export function openServerTerminal(
  server: { id: string; name: string },
  opts?: { forceNew?: boolean },
): void {
  if (typeof window === "undefined") return;
  const plan: ServerTerminalPlan = opts?.forceNew
    ? { action: "new" }
    : planServerTerminalOpen({
        serverId: server.id,
        tabs: $terminals.get(),
        tabStates: $sshTabState.get(),
      });
  if (plan.action === "revive") {
    selectTerminal(plan.tabId);
    setTerminalTakeover(true);
    reconnectSshTerminal(plan.tabId);
    return;
  }
  if (plan.action === "focus") {
    selectTerminal(plan.tabId);
    setTerminalTakeover(true);
    return;
  }
  const id = createSshTerminal(server);
  setSshTabState(id, "connecting");
  selectTerminal(id);
  setTerminalTakeover(true);
}

/** The server's plan-relevant riding tab id (a dropped one before a live one), or null when none
 *  exists — the Servers section's single-click "select" reads this. */
export function ridingSshTabOf(serverId: string): string | null {
  const plan = planServerTerminalOpen({
    serverId,
    tabs: $terminals.get(),
    tabStates: $sshTabState.get(),
  });
  return plan.action === "new" ? null : plan.tabId;
}

/** The ServerCard lamp palette, reused verbatim for the rail's tiny ssh tab dot and the sidebar
 *  row (the lamp grammar stays shared; connecting keeps its pulse). */
export function sshStateLampClass(state: SshTabState): string {
  return state === "connected"
    ? "h-2 w-2 rounded-full bg-working shadow-[0_0_0.375rem_rgba(45,212,191,0.5)]"
    : state === "connecting"
      ? "h-2 w-2 animate-pulse rounded-full bg-accent"
      : "h-2 w-2 rounded-full bg-danger";
}
