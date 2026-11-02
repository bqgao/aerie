/**
 * The ⌘⇧O Quick palette (B2, SEARCH_QUICKJUMP_SPEC run B2): a ModalShell lookup over the
 * app's renderer-resident sources — the App's session list (rail grouping included), the
 * Servers store, and the Editor pane's tab family — scored by quick-palette-model.ts and
 * grouped Sessions → Projects → Servers → Editor tabs. One app-level mount; the open/
 * close state lives in the model's atom so the window keybind can toggle without props.
 *
 * The keybind rides the window's BUBBLE phase on purpose: the terminal keybinds
 * (shell-terminal/keybinds.ts) listen in CAPTURE so an early capture listener that
 * preventDefaults its own chord would eat the event before this one ever ran — but that
 * listener only claims Ctrl+` (its guard requires !shiftKey), so ⌘⇧O falls through both
 * capture listeners and this bubble handler still fires. xterm's own keydown handler sits
 * on the terminal element (target → capture → bubble), so a chord struck while a terminal
 * has focus still bubbles up to window. Gating: the palette never stacks over another
 * modal — every modal in the app is ModalShell chrome, so "no
 * [role=dialog][aria-modal=true] in the DOM" answers "is the dirty-close dialog (or any
 * other modal) up".
 *
 * Actions are the existing ones verbatim: session/project → the App's select, server →
 * openServerTerminal, tab → activate + ensure the pane is docked. The pinned
 * "Search transcripts…" row (top, blank-or-matching query) opens B1's Search pane. The
 * pane's query field is component-local state in B1, so without touching a B1 file this
 * row routes to the pane but cannot prefill the query (noted in the run report).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "@nanostores/react";
import type { Session } from "@shared/types";
import { useI18n } from "../i18n";
import { cx } from "../ui/atoms";
import { Icon } from "../ui/icons";
import { AgentIcon } from "../ui/agent-icons";
import { ModalShell } from "../ui/ModalShell";
import { SEARCH_PANE_ID } from "./layout";
import { setPaneOpen } from "./panes";
import { $editorTabs, activateEditorTab } from "./editor/editor-store";
import { focusEditorPane } from "./editor/editor-actions";
import {
  $serverProfiles,
  $serverStatus,
  openServerTerminal,
} from "../shell-terminal/ssh-model";
import {
  $quickPaletteOpen,
  buildPaletteRows,
  closeQuickPalette,
  isQuickPaletteChord,
  openQuickPalette,
  paletteOpenAllowed,
  reducePaletteNav,
  serverLampClass,
  shouldShowSearchRowsRow,
} from "./quick-palette-model";
import type { PaletteKind, PaletteRow } from "./quick-palette-model";

/** The list's scrolling viewport (the modal itself stays compact at ~≤12 rows). */
const LIST_MAX_HEIGHT_CLASS = "max-h-[19rem]";

/** One rendered entry: the pinned "Search transcripts…" row or a model-built result.
 *  A union so navigation and rendering branch on one shape. */
type FlatEntry = { type: "search" } | { type: "model"; row: PaletteRow };

/** The keybind's hint: the chord references the modifier the platform actually sells
 *  (⌘ on macOS, Ctrl elsewhere — the binding itself accepts both). */
function chordHint(): string {
  if (typeof navigator === "undefined") return "";
  const platform = navigator.platform ?? navigator.userAgent;
  return /mac/i.test(platform) ? "⌘⇧O" : "Ctrl+Shift+O";
}

export function QuickPalette({
  sessions,
  homeDir,
  onSelectSession,
}: {
  /** The App's merged (drafts-overlaid) session list — recency-sorted upstream. */
  sessions: Session[];
  /** The overview's homeDir, handed to the project grouping's ~-abbreviation. */
  homeDir: string;
  onSelectSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const open = useStore($quickPaletteOpen);
  const servers = useStore($serverProfiles);
  const serverStatus = useStore($serverStatus);
  const tabs = useStore($editorTabs);
  const [query, setQuery] = useState("");
  const [nav, setNav] = useState<{ index: number; count: number }>({
    index: 0,
    count: 0,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // The ⌘⇧O binding: window-level bubble (NOT capture — see the file doc), installed in
  // this mount effect so the App's footprint stays one component tag.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isQuickPaletteChord(event)) return;
      event.preventDefault();
      if ($quickPaletteOpen.get()) {
        closeQuickPalette(); // a second ⌘⇧O dismisses; Escape/overlay-click also close
        return;
      }
      // No stacking: another modal up (dirty-close confirm included) swallows the chord.
      if (!paletteOpenAllowed(document)) return;
      openQuickPalette();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fresh surface on open: blank query, first row selected, keyboard in the input.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
  }, [open]);

  const modelRows = useMemo(
    () =>
      buildPaletteRows({
        query,
        sessions,
        homeDir,
        servers,
        serverStatus,
        tabs,
      }),
    [query, sessions, homeDir, servers, serverStatus, tabs],
  );

  const searchVisible = shouldShowSearchRowsRow(
    query,
    t.palette.searchTranscripts,
  );
  const flat: FlatEntry[] = useMemo(
    () =>
      searchVisible
        ? [
            { type: "search" },
            ...modelRows.map((row) => ({ type: "model", row }) as const),
          ]
        : modelRows.map((row) => ({ type: "model", row }) as const),
    [searchVisible, modelRows],
  );

  // Re-clamp the selection whenever the rendered list re-flows (typing, sync ticks).
  useEffect(() => {
    setNav((n) =>
      reducePaletteNav({ ...n, count: flat.length }, { type: "home" }),
    );
  }, [flat.length]);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [nav.index]);

  function moveUp(): void {
    setNav((n) => reducePaletteNav(n, { type: "up" }));
  }
  function moveDown(): void {
    setNav((n) => reducePaletteNav(n, { type: "down" }));
  }

  function run(entry: FlatEntry): void {
    if (entry.type === "search") {
      setPaneOpen(SEARCH_PANE_ID, true); // the titlebar search toggle's helper, shared
      closeQuickPalette();
      return;
    }
    const { row } = entry;
    switch (row.source.kind) {
      case "session":
        onSelectSession(row.source.session.id);
        break;
      case "project":
        onSelectSession(row.source.sessionId); // the group's most-recent session
        break;
      case "server":
        openServerTerminal(row.source.profile);
        break;
      case "tab":
        activateEditorTab(row.source.tab.id);
        focusEditorPane(); // activating into a docked pane only, siblings yield
        break;
    }
    closeQuickPalette();
  }

  const rowClass =
    "flex h-6 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-xs text-(--ui-text-secondary) transition-colors duration-100 ease-out hover:bg-(--ui-row-hover-background) hover:text-fg hover:transition-none";

  return (
    <ModalShell
      labelledBy="quick-palette-title"
      widthClass="w-[32rem] max-w-[90vw]"
      onClose={closeQuickPalette}
    >
      <h1 id="quick-palette-title" className="sr-only">
        {t.palette.title}
      </h1>
      {/* Input row (the Search pane's query-bar grammar) */}
      <div className="flex items-center gap-1.5 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) px-2 py-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
        <Icon
          name="search"
          size={13}
          className="shrink-0 text-(--ui-text-quaternary)"
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              moveUp();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              moveDown();
            } else if (e.key === "Enter" && flat.length > 0) {
              e.preventDefault();
              run(flat[Math.min(nav.index, flat.length - 1)]);
            }
          }}
          placeholder={t.palette.placeholder}
          spellCheck={false}
          aria-label={t.palette.title}
          className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-fg outline-none placeholder:text-(--ui-text-quaternary)"
        />
        <kbd className="shrink-0 rounded-sm bg-(--ui-control-active-background) px-1.5 text-[0.64rem] text-(--ui-text-tertiary)">
          {chordHint()}
        </kbd>
      </div>
      {/* Results, kind-grouped */}
      <div className={cx("mt-2 overflow-y-auto", LIST_MAX_HEIGHT_CLASS)}>
        {flat.length === 0 ? (
          <p className="px-2 py-3 text-[0.8125rem] text-(--ui-text-quaternary)">
            {t.palette.noMatches}
          </p>
        ) : (
          renderGroups()
        )}
      </div>
    </ModalShell>
  );

  function renderGroups(): ReactNode[] {
    // Kind headers appear only where a kind's block begins (the model emits kind-pure
    // consecutive blocks — Sessions → Projects → Servers → Editor tabs).
    const entries: ReactNode[] = [];
    let lastKind: PaletteKind | null = null;
    flat.forEach((entry, index) => {
      if (entry.type === "search") {
        entries.push(
          <button
            key="search-transcripts"
            type="button"
            ref={nav.index === index ? selectedRef : undefined}
            onClick={() => run(entry)}
            onMouseEnter={() => setNav((n) => ({ ...n, index }))}
            className={cx(
              rowClass,
              nav.index === index &&
                "bg-(--ui-row-hover-background) text-fg hover:transition-none",
            )}
          >
            <Icon
              name="scroll-text"
              size={12}
              className="shrink-0 text-(--ui-text-quaternary)"
            />
            <span className="min-w-0 flex-1 truncate">
              {t.palette.searchTranscripts}
            </span>
            <kbd className="shrink-0 rounded-sm px-1 text-[0.6rem] text-(--ui-text-quaternary)">
              ↩
            </kbd>
          </button>,
        );
        return;
      }
      const kind = entry.row.source.kind;
      if (kind !== lastKind) {
        lastKind = kind;
        entries.push(
          <p
            key={`k:${kind}`}
            className="flex h-6 items-center gap-1 rounded-sm pl-2 text-[0.64rem] font-semibold uppercase tracking-[0.12em] text-(--ui-text-quaternary)"
          >
            {kindLabel(kind)}
          </p>,
        );
      }
      entries.push(
        <PaletteEntryRow
          key={entry.row.id}
          row={entry.row}
          selected={nav.index === index}
          rowRef={nav.index === index ? selectedRef : undefined}
          lampClass={
            entry.row.source.kind === "server"
              ? serverLampClass(
                  serverStatus[entry.row.source.profile.id]?.status ??
                    "offline",
                )
              : null
          }
          onHover={() => setNav((n) => ({ ...n, index }))}
          onRun={() => run(entry)}
          rowClass={rowClass}
        />,
      );
    });
    return entries;
  }

  function kindLabel(kind: PaletteKind): string {
    return kind === "session"
      ? t.palette.kinds.sessions
      : kind === "project"
        ? t.palette.kinds.projects
        : kind === "server"
          ? t.palette.kinds.servers
          : t.palette.kinds.tabs;
  }
}

/** One result row — the rail's shapes run through here: a session carries its agent
 *  brand mark (as SessionRow's icon slot), a project the folder icon, a server the
 *  ServerCard lamp hue (the palette shared verbatim through the model) and an editor
 *  tab the tab strip's name + dirty dot grammar, its path the dimmed hint. */
function PaletteEntryRow({
  row,
  selected,
  rowRef,
  lampClass,
  onHover,
  onRun,
  rowClass,
}: {
  row: PaletteRow;
  selected: boolean;
  rowRef: React.Ref<HTMLButtonElement> | undefined;
  /** The ServerCard lamp chain, computed by the parent off $serverStatus. */
  lampClass: string | null;
  onHover: () => void;
  onRun: () => void;
  rowClass: string;
}) {
  return (
    <button
      type="button"
      ref={rowRef}
      onClick={onRun}
      onMouseEnter={onHover}
      title={row.hint ? `${row.title} · ${row.hint}` : row.title}
      className={cx(
        rowClass,
        selected &&
          "bg-(--ui-row-hover-background) text-fg hover:transition-none",
      )}
    >
      {row.source.kind === "session" && (
        <span className="grid size-3.5 shrink-0 place-items-center">
          <AgentIcon agent={row.source.session.agent} size={12} />
        </span>
      )}
      {row.source.kind === "project" && (
        <Icon
          name="folder"
          size={12}
          className="shrink-0 text-(--ui-text-quaternary)"
        />
      )}
      {row.source.kind === "server" && (
        <span className={cx("shrink-0", lampClass)} aria-hidden="true" />
      )}
      {row.source.kind === "tab" && (
        <>
          <Icon
            name="square-code"
            size={12}
            className="shrink-0 text-(--ui-text-quaternary)"
          />
          {row.dirty && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-accent"
              aria-hidden="true"
            />
          )}
        </>
      )}
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      {row.hint && (
        <span
          className="max-w-[45%] shrink-0 truncate text-[0.64rem] text-(--ui-text-quaternary)"
          title={row.hint}
        >
          {row.hint}
        </span>
      )}
      {row.badge && (
        <span className="shrink-0 rounded-full bg-(--ui-control-active-background) px-1.5 text-[0.6rem] text-(--ui-text-tertiary)">
          {row.badge}
        </span>
      )}
    </button>
  );
}
