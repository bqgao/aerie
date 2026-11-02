import type { ServerProfile } from "@shared/servers";
import { useStore } from "@nanostores/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SETTINGS_ID } from "../settings/sentinel";
import { cx } from "../ui/atoms";
import { Icon } from "../ui/icons";
import { useI18n } from "../i18n";
import {
  $serverProfiles,
  $serverStatus,
  openServerTerminal,
  refreshServers,
  ridingSshTabOf,
} from "../shell-terminal/ssh-model";
import { selectTerminal } from "../shell-terminal/terminals";
import { setTerminalTakeover } from "../shell-terminal/store";
import { SFTP_PANE_ID } from "./layout";
import { setPaneOpen } from "./panes";
import { setSftpServer } from "./sftp/sftp-store";

interface MenuState {
  x: number;
  y: number;
  server: ServerProfile;
}

/**
 * The Servers section in the sessions rail (S2, DESIGN_NOTES §S2 flow 2): a collapsible group at
 * the TOP of the rail. One row per saved server — name + group chip + the ServerCard lamp
 * vocabulary (same hues, compiled inline there; no new design language). Double-click =
 * connect (pool) + open a terminal tab; single click selects the server's riding tab; the
 * context menu owns Open Terminal / New Tab / Connect / Disconnect / Edit in Settings. Rows poll
 * at the same 3s cadence as the ServerCard's; a dial's sticky lastError shows under the errored
 * row (S1 semantics — the error lives on the ROW, never in a dead tab).
 */
export function ServerRailSection({
  onRoute,
}: {
  onRoute: (id: string) => void;
}) {
  const { t } = useI18n();
  const servers = useStore($serverProfiles);
  const statusMap = useStore($serverStatus);
  const [collapsed, setCollapsed] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    void refreshServers();
    // Polled like the rest of the poll-driven app: row lamps move because main's pool state moves.
    const timer = setInterval(() => void refreshServers(), 3000);
    return () => clearInterval(timer);
  }, []);

  const statusOf = (id: string) => statusMap[id]?.status ?? "offline";

  const row =
    "flex h-6 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-xs text-(--ui-text-secondary) transition-colors duration-100 ease-out hover:bg-(--ui-row-hover-background) hover:text-fg hover:transition-none";

  return (
    <div className="border-b border-sidebar-border pb-1">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((v) => !v)}
        className="mt-1 flex h-6 w-full items-center gap-1 rounded-sm pl-2 text-(--ui-text-quaternary) hover:bg-(--ui-row-hover-background) hover:text-fg"
      >
        <span className="text-[0.64rem] font-semibold uppercase tracking-[0.12em]">
          {t.shell.servers.sectionTitle}
        </span>
        {servers.length > 0 && (
          <span className="rounded-full bg-(--ui-control-active-background) px-1.5 text-[0.64rem] tabular-nums">
            {servers.length}
          </span>
        )}
        <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={12} />
      </button>
      {!collapsed &&
        (servers.length === 0 ? (
          <p className="px-2.5 py-1 text-xs text-(--ui-text-quaternary)">
            {t.shell.servers.emptyState}
          </p>
        ) : (
          <div className="flex flex-col gap-px px-2.5">
            {servers.map((server) => {
              const st = statusOf(server.id);
              const lampClass =
                st === "connected"
                  ? "h-2 w-2 rounded-full bg-working shadow-[0_0_0.375rem_rgba(45,212,191,0.5)]"
                  : st === "connecting"
                    ? "h-2 w-2 animate-pulse rounded-full bg-accent"
                    : st === "error"
                      ? "h-2 w-2 rounded-full bg-danger"
                      : "h-2 w-2 rounded-full bg-ink-600";
              const error =
                st === "error" ? statusMap[server.id]?.lastError : undefined;
              return (
                <div key={server.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onDoubleClick={() => openServerTerminal(server)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") openServerTerminal(server);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, server });
                    }}
                    onClick={() => {
                      // Single click selects the server's riding tab when one exists; there is
                      // no separately-selected server state (S2 stays inside the tab store).
                      const riding = ridingSshTabOf(server.id);
                      if (riding) {
                        selectTerminal(riding);
                        setTerminalTakeover(true);
                      }
                    }}
                    className={cx(row, "select-none")}
                    title={error ?? undefined}
                  >
                    <span className={cx("shrink-0", lampClass)} />
                    <span className="min-w-0 flex-1 truncate">
                      {server.name}
                    </span>
                    {server.group && (
                      <span className="shrink-0 rounded-full bg-(--ui-control-active-background) px-1.5 text-[0.6rem] text-(--ui-text-tertiary)">
                        {server.group}
                      </span>
                    )}
                  </div>
                  {error && (
                    <p
                      className="truncate pl-4 pr-2 text-[0.64rem] text-danger"
                      title={error}
                    >
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      {menu &&
        createPortal(
          <ServerContextMenu
            menu={menu}
            onClose={() => setMenu(null)}
            onRoute={onRoute}
          />,
          document.body,
        )}
    </div>
  );
}

/** One server row's context menu — the minimal local card, dismissed by click-away or Escape
 *  (same pattern as the terminal rail's RailContextMenu, no shared primitive exists). */
function ServerContextMenu({
  menu,
  onClose,
  onRoute,
}: {
  menu: MenuState;
  onClose: () => void;
  onRoute: (id: string) => void;
}) {
  const { t } = useI18n();
  const statusMap = useStore($serverStatus);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const item =
    "block w-full px-2.5 py-1 text-left text-[0.6875rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent";
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const st = statusMap[menu.server.id]?.status ?? "offline";
  return (
    <>
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="fixed z-50 min-w-36 rounded-sm border border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background) py-1 shadow-lg"
        role="menu"
        style={{
          left: Math.min(menu.x, window.innerWidth - 200),
          top: Math.min(menu.y, window.innerHeight - 160),
        }}
      >
        <button
          className={item}
          onClick={run(() => openServerTerminal(menu.server))}
          type="button"
        >
          {t.shell.servers.openTerminal}
        </button>
        <button
          className={item}
          disabled={st !== "connected"}
          onClick={run(() =>
            openServerTerminal(menu.server, { forceNew: true }),
          )}
          type="button"
        >
          {t.shell.servers.newTabToServer}
        </button>
        <button
          className={item}
          disabled={st === "connected" || st === "connecting"}
          onClick={run(() => {
            void window.api.serversConnect(menu.server.id);
            void refreshServers();
          })}
          type="button"
        >
          {t.shell.servers.connect}
        </button>
        <button
          className={item}
          disabled={st === "offline"}
          onClick={run(() => {
            void window.api.serversDisconnect(menu.server.id);
            void refreshServers();
          })}
          type="button"
        >
          {t.shell.servers.disconnect}
        </button>
        <div className="mx-2 my-1 h-px bg-(--ui-stroke-tertiary)" />
        <button
          className={item}
          onClick={run(() => {
            setPaneOpen(SFTP_PANE_ID, true);
            setSftpServer(menu.server.id);
          })}
          type="button"
        >
          {t.sftp.pane.title}
        </button>
        <button
          className={item}
          onClick={run(() => onRoute(SETTINGS_ID))}
          type="button"
        >
          {t.shell.servers.editInSettings}
        </button>
      </div>
    </>
  );
}
