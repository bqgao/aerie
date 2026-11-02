/**
 * The Editor pane (pass I-a, IDE_SPEC "Surfaces"). A docked pane registered in layout.ts
 * (id "editor", default closed) hosting an INTERNAL horizontal tab strip — the terminal rail's
 * tab grammar (its size-7 square metrics, action-hover active fill, close affordance) turned
 * into named file tabs with the dirty dot. One tab = one file identity; its body is header row
 * (name + origin badge + dirty dot + markdown mode toggle) / the textarea editor / footer
 * status line (Ln/Col, UTF-8, size, or the in-band error line — "Saved" flashes after a save).
 *
 * Editing model (spec): textarea v1 — CodeMirror/mermaid deferred to I-c; Tab inserts two
 * spaces; Ctrl/Cmd+S saves through the origin's channel (fileio:* local, SftpService server);
 * markdown (.md/.markdown) gains an Edit⇄Preview header toggle rendering the DRAFT through the
 * transcript's MarkdownMessage pipeline (kept-mounted state, never a remount); capped (512KiB)
 * tabs render read-only with a banner; binary reads render the in-band message view; PDF tabs
 * (status "pdf") render the READ-ONLY <webview> pdfium viewer (I-b route (a) — local files
 * stream from disk, server files from main's content-hash temp copy). A dirty
 * close asks Save/Discard/Cancel (the three-button dialog below). Local files drop onto the
 * pane (Electron File API → main's webUtils path).
 *
 * State rules live in editor-model.ts (tested), atoms in editor-store.ts; this file owns React
 * wiring plus the shared open/save actions (the SFTP pane's context-menu "Edit" rides
 * `openServerInEditor`).
 */
import { useEffect, useMemo, useRef, useState, createElement } from "react";
import { useStore } from "@nanostores/react";
import { useI18n } from "../../i18n";
import { cx, focusRing } from "../../ui/atoms";
import { Icon } from "../../ui/icons";
import { ModalShell } from "../../ui/ModalShell";
import { CustomSelect, type CustomSelectOption } from "../../ui/CustomSelect";
import { MarkdownMessage } from "../../workspace/markdown/MarkdownMessage";
import { humanizeBytes } from "../sftp/sftp-model";
import {
  $serverProfiles,
  $serverStatus,
  refreshServers,
} from "../../shell-terminal/ssh-model";
import {
  $editorActiveId,
  $editorCursor,
  $editorTabs,
  activateEditorTab,
  closeEditorTab,
  editorTabOf,
  setTabDraft,
  setTabMode,
} from "./editor-store";
import {
  badgeText,
  canPreview,
  cursorInfo,
  isDirty,
  isMarkdownName,
  readOnlyReason,
  type EditorTab,
} from "./editor-model";
import {
  openLocalPath,
  openLocalPick,
  openServerInEditor,
  saveActive,
} from "./editor-actions";

// ── the component ────────────────────────────────────────────────────────────

export function EditorPane() {
  const { t } = useI18n();
  const tabs = useStore($editorTabs);
  const activeId = useStore($editorActiveId);
  const active = useMemo(
    () => tabs.find((tab) => tab.id === activeId) ?? null,
    [tabs, activeId],
  );

  /** The "Saved" flash (ms epoch; zero = hidden). */
  const [savedFlash, setSavedFlash] = useState(0);
  /** The Open picker: menu of entry points ('menu') → Server… dialog ('server'); none idle. */
  const [picker, setPicker] = useState<null | "menu" | "server">(null);
  /** The menu's anchored point (the Open button's click coords). */
  const [pickerPoint, setPickerPoint] = useState({ x: 24, y: 24 });
  /** The pending dirty-close decision (Save/Discard/Cancel). */
  const [closeTargetId, setCloseTargetId] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const flashTimer = useRef<number | null>(null);

  // The pane's server freshness cadence (the picker reads the same store as SFTP's).
  useEffect(() => {
    void refreshServers();
    const timer = setInterval(() => void refreshServers(), 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const doSave = async (): Promise<boolean> => {
    const ok = await saveActive();
    if (ok) {
      setSavedFlash(Date.now());
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setSavedFlash(0), 1800);
    }
    return ok;
  };

  // Ctrl/Cmd+S at the window level so the save rides even after the textarea lost focus.
  // Keyed on the active tab id: the (re)created doSave reads the store fresh each call.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        const tab = $editorActiveId.get()
          ? editorTabOf($editorActiveId.get() as string)
          : null;
        if (!tab || !isDirty(tab)) return;
        event.preventDefault();
        void doSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId]);

  const requestClose = (tab: EditorTab): void => {
    if (isDirty(tab)) {
      setCloseTargetId(tab.id);
      return;
    }
    closeEditorTab(tab.id);
  };

  /** The Open button's small menu (spec: Local… native dialog, Server… dialog). */
  const openAt = (x: number, y: number): void => {
    setPickerPoint({ x, y });
    setPicker("menu");
  };

  const dirtySaveAndClose = (id: string): void => {
    void (async () => {
      const ok = await doSave();
      if (ok) {
        setCloseTargetId(null);
        closeEditorTab(id);
      }
    })();
  };

  const onDragOverPane = (event: React.DragEvent): void => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropHover(true);
  };

  const onDropPane = (event: React.DragEvent): void => {
    event.preventDefault();
    setDropHover(false);
    const transfer = event.dataTransfer;
    if (!transfer || transfer.files.length === 0) return;
    for (const file of Array.from(transfer.files)) {
      const path = window.api.getPathForFile(file);
      if (path) void openLocalPath(path);
    }
  };

  if (tabs.length === 0) {
    return (
      <div
        className="relative flex h-full flex-col"
        onDragOver={onDragOverPane}
        onDragLeave={() => setDropHover(false)}
        onDrop={onDropPane}
      >
        <EmptyState onOpen={(x, y) => openAt(x, y)} />
        {picker === "menu" && (
          <OpenMenu
            onLocal={() => {
              setPicker(null);
              void openLocalPick();
            }}
            onServer={() => setPicker("server")}
            onClose={() => setPicker(null)}
            point={pickerPoint}
          />
        )}
        {picker === "server" && (
          <ServerPickerDialog onClose={() => setPicker(null)} />
        )}
        {dropHover && (
          <div className="pointer-events-none absolute inset-2 rounded-md border-2 border-dashed border-primary/50 bg-primary/10" />
        )}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={onDragOverPane}
      onDragLeave={() => setDropHover(false)}
      onDrop={onDropPane}
    >
      {/* The internal tab strip (the terminal rail's grammar, horizontal). */}
      <ul
        aria-label={t.editor.pane.tabListAria}
        className="flex min-h-0 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-(--ui-stroke-tertiary) py-1 pl-1 pr-0.5 [scrollbar-width:none]"
        role="tablist"
      >
        {tabs.map((tab) => (
          <EditorTabButton
            active={tab.id === activeId}
            dirty={isDirty(tab)}
            key={tab.id}
            name={tab.name}
            onClick={() => activateEditorTab(tab.id)}
            onClose={() => requestClose(tab)}
            status={tab.status}
          />
        ))}
        <li className="flex shrink-0 justify-center">
          <button
            aria-label={t.editor.open.button}
            className="grid size-7 shrink-0 place-items-center rounded-sm text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-fg [-webkit-app-region:no-drag]"
            onClick={(event) => openAt(event.clientX, event.clientY)}
            title={t.editor.open.button}
            type="button"
          >
            <Icon name="plus" size={13} />
          </button>
        </li>
      </ul>

      {active ? (
        <TabBody
          active={active}
          onSave={() => void doSave()}
          savedFlash={savedFlash > 0}
        />
      ) : null}

      {picker === "menu" && (
        <OpenMenu
          onLocal={() => {
            setPicker(null);
            void openLocalPick();
          }}
          onServer={() => setPicker("server")}
          onClose={() => setPicker(null)}
          point={pickerPoint}
        />
      )}
      {picker === "server" && (
        <ServerPickerDialog onClose={() => setPicker(null)} />
      )}
      {closeTargetId && (
        <DirtyCloseDialog
          name={editorTabOf(closeTargetId)?.name ?? ""}
          onClose={() => setCloseTargetId(null)}
          onDiscard={() => {
            setCloseTargetId(null);
            closeEditorTab(closeTargetId);
          }}
          onSave={() => dirtySaveAndClose(closeTargetId)}
        />
      )}
      {dropHover && (
        <div className="pointer-events-none absolute inset-0 z-10 bg-primary/5" />
      )}
    </div>
  );
}

/** The rail's tab metrics (size-7 squares, action-hover active) as a horizontal named tab. */
function EditorTabButton({
  active,
  dirty,
  name,
  status,
  onClick,
  onClose,
}: {
  active: boolean;
  dirty: boolean;
  name: string;
  status: EditorTab["status"];
  onClick: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <li className={cx("flex shrink-0 items-center")} role="presentation">
      <button
        aria-label={name}
        aria-selected={active}
        className={cx(
          "flex h-7 max-w-44 items-center gap-1.5 rounded-sm px-2 text-[0.6875rem] transition-colors",
          focusRing,
          active
            ? "bg-(--chrome-action-hover) text-fg"
            : "text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-fg",
        )}
        onClick={onClick}
        role="tab"
        title={name}
        type="button"
      >
        <DirtyDot dirty={dirty} status={status} />
        <span className="truncate">{name}</span>
      </button>
      <button
        aria-label={t.editor.pane.closeTabAria(name)}
        className={cx(
          "-ml-0.5 grid size-4 place-items-center rounded-xs text-(--ui-text-quaternary) transition-colors hover:bg-(--ui-row-hover-background) hover:text-danger",
        )}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        type="button"
      >
        <Icon name="x" size={9} />
      </button>
    </li>
  );
}

/** The dirty dot (accent when churning); a failed/binary tab shows the alert glyph instead. */
function DirtyDot({
  dirty,
  status,
}: {
  dirty: boolean;
  status: EditorTab["status"];
}) {
  if (status === "error" || status === "binary") {
    return <Icon name="triangle-alert" size={11} />;
  }
  return (
    <span
      className={cx(
        "size-1.5 shrink-0 rounded-full bg-accent transition-opacity",
        dirty ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/** One tab's body: header row / banner / editor-or-preview / footer. `cursor` is the pane's
 *  tracked caret readout (1-based Ln/Col) — the pane owns it because the footer of WHICHEVER
 *  tab is active shows it, and switching tabs resets it. */
function TabBody({
  active,
  onSave,
  savedFlash,
}: {
  active: EditorTab;
  onSave: () => void;
  savedFlash: boolean;
}) {
  const { t } = useI18n();
  const cursor = useStore($editorCursor);
  const badge = badgeText(active.origin, {
    local: t.editor.header.localBadge,
    opencode: t.editor.header.opencodeBadge,
    server: t.editor.header.serverBadge,
  });
  const markdown = active.status === "ready" && isMarkdownName(active.name);
  const readOnly = readOnlyReason(active);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header row: file name + origin badge + dirty dot, then the markdown mode toggle. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-quaternary) px-3 py-1.5">
        <span className="truncate font-medium text-(--ui-text-secondary)">
          {active.name}
        </span>
        <span
          className={cx(
            "shrink-0 rounded-sm px-1.5 py-px text-meta",
            active.origin.kind === "local"
              ? "bg-(--chrome-action-hover) text-(--ui-text-tertiary)" // the neutral local badge
              : "bg-accent/15 text-accent", // the server lamp hue family
          )}
        >
          {badge}
        </span>
        {readOnly && (
          <span className="shrink-0 text-meta text-fg-faint">
            {t.editor.header.readOnly}
          </span>
        )}
        <div className="flex-1" />
        {markdown && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              aria-pressed={active.mode === "edit"}
              className={cx(
                "rounded-sm px-1.5 py-0.5 text-meta transition-colors",
                active.mode === "edit"
                  ? "bg-(--chrome-action-hover) text-fg"
                  : "text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-fg",
              )}
              onClick={() => setTabModeSafe(active, "edit")}
              type="button"
            >
              {t.editor.header.modeEdit}
            </button>
            <button
              aria-pressed={active.mode === "preview"}
              className={cx(
                "rounded-sm px-1.5 py-0.5 text-meta transition-colors",
                active.mode === "preview"
                  ? "bg-(--chrome-action-hover) text-fg"
                  : "text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-fg",
              )}
              disabled={!canPreview(active)}
              onClick={() => setTabModeSafe(active, "preview")}
              title={
                canPreview(active)
                  ? undefined
                  : t.editor.header.previewUnavailable
              }
              type="button"
            >
              {t.editor.header.modePreview}
            </button>
          </div>
        )}
      </div>

      {/* Load/failure states are message views; ready states carry the editor. */}
      {active.status === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-fg-faint">
          <Icon className="animate-spin" name="loader-circle" size={16} />
        </div>
      ) : (
        <>
          {active.status === "binary" && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <Icon
                className="text-(--ui-text-quaternary)"
                name="triangle-alert"
                size={20}
              />
              <p className="text-aux font-medium text-(--ui-text-secondary)">
                {t.editor.binary.title}
              </p>
              <p className="text-aux text-fg-faint">{t.editor.binary.body}</p>
            </div>
          )}
          {active.status === "error" && (
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <p className="text-aux text-fg-faint">{active.error ?? ""}</p>
            </div>
          )}

          {/* The PDF viewer (status "pdf"): Chromium's own pdfium UI inside a <webview> guest —
              no textarea, no save path (Ctrl+S reads the dirty guard's false and no-ops; the
              footer states read-only). The guest is fully sandboxed (no node) and UNMOUNTS with
              the tab: switching or closing this tab destroys the element, which is the lifecycle
              contract's whole risk surface — a re-focus re-creates it, reloading from the same
              URL (local disk or main's content-hash temp copy). */}
          {active.status === "pdf" && active.pdfUrl && (
            <>
              <PdfViewport url={active.pdfUrl} name={active.name} />
              <div className="flex h-6 shrink-0 items-center gap-3 border-t border-(--ui-stroke-quaternary) px-3 font-mono text-label text-(--ui-text-quaternary)">
                <span aria-hidden>{t.editor.header.readOnly}</span>
                <span aria-hidden>{humanizeBytes(active.bytes)}</span>
                <div className="flex-1" />
                {active.error ? (
                  <span className="truncate text-danger">{active.error}</span>
                ) : null}
              </div>
            </>
          )}

          {active.status !== "ready" ? null : (
            <>
              {active.capped && (
                <div className="flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-quaternary) bg-primary/5 px-3 py-1 text-meta text-(--ui-text-secondary)">
                  <Icon name="triangle-alert" size={12} />
                  {t.editor.banner.capped}
                </div>
              )}

              {/* Edit and Preview COOPERATE through the DOM: the textarea stays mounted
                  (hidden, not remounted) so the draft never loses component state, while the
                  preview derives straight from the draft prop. */}
              {markdown && active.mode === "preview" && (
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  <MarkdownMessage text={active.draft} />
                </div>
              )}

              <textarea
                aria-label={active.name}
                className={cx(
                  "min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-aux text-fg outline-none",
                  markdown && active.mode === "preview" && "hidden",
                  readOnly && "text-(--ui-text-tertiary)",
                )}
                onChange={(event) => {
                  setTabDraft(active.id, event.target.value);
                  $editorCursor.set(
                    cursorInfo(event.target.value, event.target.selectionStart),
                  );
                }}
                onKeyDown={(event) => {
                  if (event.key === "Tab" && !readOnly) {
                    event.preventDefault();
                    const el = event.currentTarget;
                    el.setRangeText(
                      "  ",
                      el.selectionStart,
                      el.selectionEnd,
                      "end",
                    );
                    setTabDraft(active.id, el.value);
                  }
                  if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    onSave();
                  }
                }}
                onKeyUp={(event) =>
                  $editorCursor.set(
                    cursorInfo(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart,
                    ),
                  )
                }
                readOnly={readOnly !== null}
                spellCheck={false}
                value={active.draft}
              />

              {/* Footer status line: Ln/Col · UTF-8 · size — or the error line, or the flash. */}
              <div className="flex h-6 shrink-0 items-center gap-3 border-t border-(--ui-stroke-quaternary) px-3 font-mono text-label text-(--ui-text-quaternary)">
                {t.editor.footer.lineCol(cursor.line, cursor.col)}
                <span aria-hidden>{t.editor.footer.utf8}</span>
                <span aria-hidden>{humanizeBytes(active.bytes)}</span>
                <div className="flex-1" />
                {active.error ? (
                  <span className="truncate text-danger">{active.error}</span>
                ) : (
                  <span
                    className={cx(
                      "shrink-0 text-accent transition-opacity",
                      savedFlash ? "opacity-100" : "opacity-0",
                    )}
                  >
                    {t.editor.footer.savedFlash}
                  </span>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// Perf detail: cursorInfo runs against the LIVE active record so the footer follows typings;
// the two helpers below read the module-level registry instead of threading props.

/** The <webview> element isn't html: the JSX typing umbrella has no intrinsic for it, so the
 *  PDF viewport builds it directly with createElement (src is the ONLY prop it needs; every
 *  other guest preference is Electron's safe default — sandboxed, no node). */
function PdfViewport({ url, name }: { url: string; name: string }) {
  return createElement("webview", {
    key: url,
    "aria-label": name,
    className: "min-h-0 flex-1",
    src: url,
  });
}

function setTabModeSafe(tab: EditorTab, mode: "edit" | "preview"): void {
  setTabMode(tab.id, mode); // setTabMode re-checks canPreview (the guard rules live in the model)
}

/** The pane's empty state (spec: hint + Open button + entry points below). */
function EmptyState({ onOpen }: { onOpen: (x: number, y: number) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Icon
        className="text-(--ui-text-quaternary)"
        name="square-code"
        size={24}
      />
      <p className="text-aux font-medium text-(--ui-text-secondary)">
        {t.editor.empty.hint}
      </p>
      <button
        className="rounded-md border border-ink-700 px-2.5 py-1 text-aux text-fg-muted hover:border-ink-600 hover:text-fg"
        onClick={(event) => onOpen(event.clientX, event.clientY)}
        type="button"
      >
        {t.editor.open.button}
      </button>
      <p className="text-aux text-fg-faint">{t.editor.empty.dropHint}</p>
    </div>
  );
}

/** The Open menu (spec: "a small picker — Local… or Server…"), the rail's minimal
 *  fixed-position card pattern, positioned at the Open button's click point. */
function OpenMenu({
  point,
  onLocal,
  onServer,
  onClose,
}: {
  point: { x: number; y: number };
  onLocal: () => void;
  onServer: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const item =
    "block w-full px-2.5 py-1 text-left text-[0.6875rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-fg";
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
          left: Math.min(point.x, window.innerWidth - 180),
          top: Math.min(point.y, window.innerHeight - 100),
        }}
      >
        <button className={item} onClick={run(onLocal)} type="button">
          {t.editor.open.local}
        </button>
        <button className={item} onClick={run(onServer)} type="button">
          {t.editor.open.server}
        </button>
      </div>
    </>
  );
}

/** Server… : a profile CustomSelect (lamp-ordered, SFTP's grammar) + an absolute path input. */
function ServerPickerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const servers = useStore($serverProfiles);
  const statuses = useStore($serverStatus);
  const [serverId, setServerId] = useState(servers[0]?.id ?? "");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const options = useMemo<CustomSelectOption<string>[]>(() => {
    const rank = (s: string): number =>
      s === "connected" ? 0 : s === "connecting" ? 1 : 2;
    return [...servers]
      .sort(
        (a, b) =>
          rank(statuses[a.id]?.status ?? "offline") -
            rank(statuses[b.id]?.status ?? "offline") ||
          a.name.localeCompare(b.name),
      )
      .map((server) => {
        const status = statuses[server.id]?.status ?? "offline";
        const lampClass =
          status === "connected"
            ? "h-2 w-2 rounded-full bg-working shadow-[0_0_0.375rem_rgba(45,212,191,0.5)]"
            : status === "connecting"
              ? "h-2 w-2 animate-pulse rounded-full bg-accent"
              : status === "error"
                ? "h-2 w-2 rounded-full bg-danger"
                : "h-2 w-2 rounded-full bg-ink-600";
        return {
          value: server.id,
          label: server.name,
          leading: <span className={cx("shrink-0", lampClass)} />,
        };
      });
  }, [servers, statuses]);

  const open = (): void => {
    if (!serverId || !path.trim()) {
      setError(t.editor.errors.invalidPath);
      return;
    }
    void openServerInEditor(serverId, path.trim());
    onClose();
  };

  return (
    <ModalShell
      labelledBy="editor-server-picker-title"
      onClose={onClose}
      widthClass="w-[26rem]"
    >
      <div
        id="editor-server-picker-title"
        className="text-subhead font-semibold"
      >
        {t.editor.open.server}
      </div>
      <div className="mt-3">
        <CustomSelect
          ariaLabel={t.editor.open.serverLabel}
          className="w-full"
          menuClassName="min-w-full"
          onChange={setServerId}
          options={options}
          value={serverId}
        />
      </div>
      <input
        aria-label={t.editor.open.pathLabel}
        autoFocus
        className={cx(
          "mt-2 w-full rounded-md border border-ink-700 bg-well px-2 py-1 font-mono text-aux text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/25",
        )}
        onChange={(event) => {
          setPath(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") open();
        }}
        placeholder={t.editor.open.pathPlaceholder}
        type="text"
        value={path}
      />
      {error && <p className="mt-1 text-meta text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button
          className={cx(
            "rounded-md px-3 py-1.5 text-body text-fg-muted transition-colors hover:text-fg",
            focusRing,
          )}
          onClick={onClose}
          type="button"
        >
          {t.common.cancel}
        </button>
        <button
          className={cx(
            "rounded-md bg-primary px-3 py-1.5 text-body font-medium text-ink-950 ring-1 ring-primary/40 transition-colors hover:bg-primary-bright",
          )}
          onClick={open}
          type="button"
        >
          {t.editor.open.open}
        </button>
      </div>
    </ModalShell>
  );
}

/** Dirty close — Save / Discard / Cancel (three choices, so it's its own ModalShell rather
 *  than the two-button ConfirmDialog; the Escape/overlay path is CANCEL, never a discard). */
function DirtyCloseDialog({
  name,
  onClose,
  onDiscard,
  onSave,
}: {
  name: string;
  onClose: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  return (
    <ModalShell
      labelledBy="editor-dirty-title"
      widthClass="w-[26rem]"
      onClose={onClose}
    >
      <div id="editor-dirty-title" className="text-subhead font-semibold">
        {t.editor.dirty.title}
      </div>
      <p className="mt-2 text-aux leading-relaxed text-fg-faint">
        {t.editor.dirty.body(name)}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          className={cx(
            "rounded-md px-3 py-1.5 text-body text-danger transition-colors hover:text-danger/80",
            focusRing,
          )}
          onClick={onDiscard}
          type="button"
        >
          {t.editor.dirty.discard}
        </button>
        <button
          className={cx(
            "rounded-md px-3 py-1.5 text-body text-fg-muted transition-colors hover:text-fg",
            focusRing,
          )}
          onClick={onClose}
          type="button"
        >
          {t.editor.dirty.cancel}
        </button>
        <button
          className="rounded-md bg-primary px-3 py-1.5 text-body font-medium text-ink-950 ring-1 ring-primary/40 transition-colors hover:bg-primary-bright"
          onClick={onSave}
          type="button"
        >
          {t.editor.dirty.save}
        </button>
      </div>
    </ModalShell>
  );
}
