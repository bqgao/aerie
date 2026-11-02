import { useEffect, useState } from "react";
import { useStore } from "@nanostores/react";
import { cx } from "../ui/atoms";
import { Icon } from "../ui/icons";
import { useI18n } from "../i18n";
import { setTerminalTakeover } from "./store";
import {
  $serverStatus,
  $sshTabState,
  openServerTerminal,
  reconnectSshTerminal,
  sshStateLampClass,
  type SshTabState,
} from "./ssh-model";
import {
  $activeTerminalId,
  $terminals,
  closeAllTerminals,
  closeOtherTerminals,
  closeTerminal,
  createTerminal,
  selectTerminal,
  type TerminalEntry,
} from "./terminals";

const RAIL_ACTION =
  "grid size-7 place-items-center rounded-sm text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-fg [-webkit-app-region:no-drag]";

interface MenuState {
  x: number;
  y: number;
  termId: string;
}

/** Thin icon "bookmark" strip on the pane's outer edge, shown whenever a terminal exists. Each
 *  square is a tab; close via the shell's `exit`, middle-click, or the context menu. */
export function TerminalRail() {
  const { t } = useI18n();
  const terminals = useStore($terminals);
  const activeId = useStore($activeTerminalId);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuState = useStore($sshTabState);
  const serverStatus = useStore($serverStatus);
  const menuEntry = menu
    ? terminals.find((term) => term.id === menu.termId)
    : undefined;

  return (
    // The subtle quaternary left edge separates the rail from the terminal body. The row-mode
    // top seam is the pane sash's full-bleed hairline (z-50, above this rail) — not a border here.
    <div className="group/rail relative z-40 flex h-full w-9 shrink-0 flex-col items-center border-l border-l-(--ui-stroke-quaternary) bg-(--ui-editor-surface-background)">
      <ul
        aria-label={t.terminal.tabListAria}
        className="flex min-h-0 flex-1 flex-col items-center gap-0.5 self-stretch overflow-y-auto overflow-x-hidden overscroll-contain py-1 [scrollbar-width:none]"
        role="tablist"
      >
        {terminals.map((term, index) => (
          <TerminalRailItem
            active={term.id === activeId}
            index={index}
            key={term.id}
            onMenu={(x, y) => setMenu({ x, y, termId: term.id })}
            state={menuState.get(term.id)}
            term={term}
          />
        ))}
        <li className="flex w-full justify-center">
          <button
            aria-label={t.terminal.newTerminal}
            className={cx(RAIL_ACTION, "text-(--ui-text-quaternary)")}
            onClick={() => createTerminal()}
            title={t.terminal.newTerminal}
            type="button"
          >
            <Icon name="plus" size={13} />
          </button>
        </li>
      </ul>

      <div className="flex shrink-0 flex-col items-center pb-1.5">
        <button
          aria-label={t.shell.footer.hideTerminal}
          className={cx(
            RAIL_ACTION,
            "opacity-0 transition-opacity group-hover/rail:opacity-100",
          )}
          onClick={() => setTerminalTakeover(false)}
          title={t.shell.footer.hideTerminal}
          type="button"
        >
          <Icon name="chevron-down" size={13} />
        </button>
      </div>

      {menu && (
        <RailContextMenu
          entry={menuEntry}
          menu={menu}
          onClose={() => setMenu(null)}
          serverConnected={
            menuEntry?.kind === "ssh"
              ? serverStatus[menuEntry.serverId ?? ""]?.status === "connected"
              : false
          }
          sshState={
            menuEntry?.kind === "ssh"
              ? (menuState.get(menuEntry.id) ?? undefined)
              : undefined
          }
        />
      )}
    </div>
  );
}

function TerminalRailItem({
  term,
  index,
  active,
  state,
  onMenu,
}: {
  term: TerminalEntry;
  index: number;
  active: boolean;
  /** S2: the ssh session state behind this tab (undefined for pty tabs). */
  state: SshTabState | undefined;
  onMenu: (x: number, y: number) => void;
}) {
  const label = `${index + 1}. ${term.title}`;
  return (
    <li className="flex w-full justify-center [-webkit-app-region:no-drag]">
      <button
        aria-label={label}
        aria-selected={active}
        className={cx(
          "grid size-7 place-items-center rounded-sm transition-colors",
          active
            ? "bg-(--chrome-action-hover) text-fg"
            : "text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-fg",
        )}
        onAuxClick={(event) => {
          if (event.button === 1) {
            event.preventDefault();
            closeTerminal(term.id);
          }
        }}
        onClick={() => selectTerminal(term.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(event.clientX, event.clientY);
        }}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        role="tab"
        title={label}
        type="button"
      >
        {term.kind === "ssh" ? (
          // The ssh tab's icon IS its lamp (the same connectors-state vocabulary the Servers
          // section and ServerCard show): connecting pulses, connected glows teal, dropped red.
          <span
            className={cx("shrink-0", sshStateLampClass(state ?? "connecting"))}
          />
        ) : (
          <Icon name="square-terminal" size={14} />
        )}
      </button>
    </li>
  );
}

/** Minimal local context menu (cbw has no shared primitive): a fixed-position card dismissed by
 *  click-away or Escape, clamped inside the viewport. */
function RailContextMenu({
  entry,
  menu,
  onClose,
  serverConnected,
  sshState,
}: {
  menu: MenuState;
  entry: TerminalEntry | undefined;
  onClose: () => void;
  /** ssh tabs only: whether the tab's server is pool-connected ("New Tab to This Server" rides a
   *  live dial; forcing another dial to a down host would just re-fail in-band). */
  serverConnected: boolean;
  sshState: SshTabState | undefined;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const isSsh = entry?.kind === "ssh";

  const item =
    "block w-full px-2.5 py-1 text-left text-[0.6875rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent";
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

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
          left: Math.min(menu.x, window.innerWidth - 160),
          top: Math.min(menu.y, window.innerHeight - 140),
        }}
      >
        {isSsh && sshState === "dropped" && entry && (
          <button
            className={item}
            onClick={run(() => {
              selectTerminal(entry.id);
              reconnectSshTerminal(entry.id);
            })}
            type="button"
          >
            {t.terminal.ssh.reconnect}
          </button>
        )}
        {isSsh && entry && (
          // DESIGN_NOTES §S2: duplicating a terminal to the same server is the explicit menu
          // item, never an accidental stacked dial from double-click.
          <button
            className={item}
            disabled={!serverConnected}
            onClick={run(() =>
              openServerTerminal(
                { id: entry.serverId ?? "", name: entry.title },
                { forceNew: true },
              ),
            )}
            type="button"
          >
            {t.shell.servers.newTabToServer}
          </button>
        )}
        <button
          className={item}
          onClick={run(() => closeTerminal(menu.termId))}
          type="button"
        >
          {t.common.close}
        </button>
        <button
          className={item}
          disabled={!isSsh && terminalsLength() < 2}
          onClick={run(() => closeOtherTerminals(menu.termId))}
          type="button"
        >
          {t.terminal.closeOthers}
        </button>
        <button className={item} onClick={run(closeAllTerminals)} type="button">
          {t.terminal.closeAll}
        </button>
        <div className="mx-2 my-1 h-px bg-(--ui-stroke-tertiary)" />
        <button
          className={item}
          onClick={run(() => setTerminalTakeover(false))}
          type="button"
        >
          {t.shell.footer.hideTerminal}
        </button>
      </div>
    </>
  );
}

function terminalsLength(): number {
  return $terminals.get().length;
}
