/**
 * The SFTP file-manager pane (pass F, DESIGN_NOTES §F). A docked pane registered in panes.ts
 * (id "sftp", default closed). Layout top→bottom: the server `CustomSelect` (connected lamps
 * first), the breadcrumb/path bar (click a segment to jump; pencil → a path input, Enter
 * navigates, an invalid path answers the inline "path not found" line under the bar while the
 * list keeps its last good state), the vertical tree+list split (lazy one-level tree open; the
 * list of the CURRENT dir with name/size/mtime columns and a click-to-cycle sort header), the
 * transfers strip, and the whole file grammar via the context menu / drag-drop.
 *
 * The store/context rules (sftp-store.ts) and state rules (sftp-model.ts) are the testable
 * halves; this component owns writes into them through window.api.sftp at the 3s poll cadence
 * plus the transfer push.
 */
import { useStore } from "@nanostores/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../ui/atoms";
import { CustomSelect, type CustomSelectOption } from "../../ui/CustomSelect";
import { Icon } from "../../ui/icons";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useI18n } from "../../i18n";
import {
  $serverProfiles,
  $serverStatus,
  refreshServers,
} from "../../shell-terminal/ssh-model";
import {
  ConflictDialog,
  NamePromptDialog,
  type ConflictResolution,
} from "./sftp-dialogs";
import {
  basenameRemoteish,
  humanizeBytes,
  humanizeMtime,
  joinRemoteFor,
  pathUpTo,
  pasteTargets,
  reduceSelection,
  renameSuggestion,
  sortEntries,
  type SftpSortKey,
} from "./sftp-model";
import {
  $sftpClipboard,
  $sftpServerId,
  $sftpTransfers,
  sftpContextOf,
  setSftpClipboard,
  setSftpCwd,
  setSftpHome,
  setSftpServer,
  setSftpTransfers,
} from "./sftp-store";
import { sftpTransferFraction } from "@shared/sftp";
import type { SftpEntry, SftpTransfer } from "@shared/sftp";
/** The drag-MIME for in-pane moves, defined once for both the row source and the targets. */
const SFTP_MOVE_MIME = "application/x-sftp-move";

interface Draft {
  kind: "new-file" | "new-folder" | "rename";
  /** rename carries the full FROM path; new-* carry the parent dir. */
  path: string;
  initial: string;
}

/** The conflict resolution's closure over the main-side call it feeds (upload or paste). */
type ConflictFlow = {
  kind: "upload" | "paste";
  /** The colliding base names (one per pending item). */
  names: string[];
  exists: (candidate: string) => boolean;
  /** The run after resolution (null = the user closed the dialog → skip everything). */
  run(resolution: ConflictResolution | null): void;
};

/// One pane instance. All interactions run through the store atoms (the pane is the writer);
/// scope resets are server-scoped, never per-entry garbage collection.
export function SftpPane() {
  const { t } = useI18n();
  const servers = useStore($serverProfiles);
  const statuses = useStore($serverStatus);
  const serverId = useStore($sftpServerId) ?? servers[0]?.id ?? null;
  const context = serverId ? sftpContextOf(serverId) : null;
  const clipboard = useStore($sftpClipboard);
  const transfers = useStore($sftpTransfers);

  const [cwd, setCwdState] = useState<string>(context?.cwd ?? "/");
  const [entries, setEntries] = useState<readonly SftpEntry[]>([]);
  const [listStatus, setListStatus] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [listError, setListError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SftpSortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  /** Directory → its dir-children (lazy tree level per open). */
  const [treeChildren, setTreeChildren] = useState<
    ReadonlyMap<string, readonly SftpEntry[]>
  >(new Map());
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(new Set());
  const [treeLoading, setTreeLoading] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [pathBarEditing, setPathBarEditing] = useState(false);
  const [pathBarValue, setPathBarValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<readonly SftpEntry[] | null>(
    null,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflictFlow, setConflictFlow] = useState<ConflictFlow | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** The cut selection's 50%-opacity visual (the DESIGN_NOTES cut cue). */
  const [lastClick, setLastClick] = useState<string | null>(null);

  // A per-server epoch: late async answers must not touch a server the pane already left.
  const epochRef = useRef(0);
  useEffect(
    () => () => {
      epochRef.current++;
    },
    [],
  );

  // The atom-level server selection mirrors the pane's picked server (later passes may read).
  useEffect(() => {
    setSftpServer(serverId);
  }, [serverId]);

  /** Fetch + install one directory listing (the cwd/world setter). */
  const navigate = async (id: string, dir: string): Promise<void> => {
    const epoch = epochRef.current;
    setListStatus("loading");
    const res = await window.api.sftp.list(id, dir);
    if (epoch !== epochRef.current || id !== $sftpServerId.get()) return;
    if (!res.ok) {
      setListStatus("error");
      setListError(res.notFound ? t.sftp.path.invalid : res.error);
      return;
    }
    const sorted = sortEntries(res.entries, sortKey, sortAsc);
    setEntries(sorted);
    setListStatus("idle");
    setListError(null);
    setCwdState(res.path);
    setSftpCwd(
      id,
      res.path,
      sorted.map((entry) => entry.name),
    );
    setSelection(new Set());
    setLastClick(null);
  };

  // First context load (per server): resolve home (server-side realpath), then land there.
  useEffect(() => {
    if (!serverId) {
      setEntries([]);
      setListStatus("idle");
      setListError(null);
      setTreeChildren(new Map());
      return;
    }
    const epoch = epochRef.current;
    const ctx = sftpContextOf(serverId);
    setListStatus("loading");
    void window.api.sftp.home(serverId).then((res) => {
      if (epoch !== epochRef.current || !res.ok) return;
      setSftpHome(serverId, res.path);
      void navigate(serverId, ctx && ctx.cwd !== "/" ? ctx.cwd : res.path);
    });
    return window.api.sftp.onEvent((snapshot) => {
      setSftpTransfers(snapshot);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- navigate is recreated per render; the serverId gate is what matters
  }, [serverId]);

  // The 3s transfers poll (F note 3) rides the pane's cadence; the push keeps rows live between.
  useEffect(() => {
    const timer = setInterval(() => {
      void window.api.sftp.transfers().then(setSftpTransfers);
      void refreshServers();
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const serverOptions = useMemo<CustomSelectOption<string>[]>(() => {
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

  /** Sorted display rows (the sort header writes only; the payload carries the stats). */
  const sortedEntries = useMemo(
    () => sortEntries(entries, sortKey, sortAsc),
    [entries, sortKey, sortAsc],
  );
  const rowNames = useMemo(
    () => sortedEntries.map((entry) => entry.name),
    [sortedEntries],
  );

  /** The menu acts on the selection; with nothing selected it's just the background (new/up). */
  const menuTargets = useMemo(
    () => sortedEntries.filter((entry) => selection.has(entry.name)),
    [sortedEntries, selection],
  );
  /** The cut rows (50% opacity). */
  const cutNames = useMemo(() => {
    if (!clipboard || clipboard.mode !== "cut") return new Set<string>();
    return new Set(clipboard.paths.map((p) => basenameRemoteish(p)));
  }, [clipboard]);

  // ── drag & drop: local files IN = upload (conflict-resolved) ────────────────

  const localPathsFromDrop = (event: React.DragEvent): string[] => {
    const transfer = event.dataTransfer;
    if (!transfer || transfer.files.length === 0) return [];
    return Array.from(transfer.files)
      .map((file) => window.api.getPathForFile(file))
      .filter((path) => path.length > 0);
  };

  /** Upload with the DESIGN_NOTES conflict flow: non-colliding names go straight through; a
   *  collision opens Overwrite/Skip/Rename and re-invokes the WHOLE batch after resolution in
   *  one main call — overwrite=true covers the overwrite answers, renameAs covers the renamed
   *  ones, and skips are simply dropped from the batch. */
  const uploadPaths = async (
    dir: string,
    localPaths: string[],
  ): Promise<void> => {
    if (!serverId || localPaths.length === 0) return;
    const names = sftpContextOf(serverId).cwdNames;
    const plain = localPaths.filter((p) => !names.has(basenameRemoteish(p)));
    const colliding = localPaths.filter((p) => names.has(basenameRemoteish(p)));
    if (colliding.length === 0) {
      await window.api.sftp.upload(serverId, dir, plain);
      return;
    }
    setConflictFlow({
      kind: "upload",
      names: colliding.map((p) => basenameRemoteish(p)),
      exists: (candidate) => names.has(candidate),
      run: (resolution) => {
        void (async () => {
          const renames: Record<string, string> = {};
          const proceeding = [...plain];
          for (const p of colliding) {
            const name = basenameRemoteish(p);
            const choice = resolution?.perName[name] ?? "skip";
            if (choice === "skip") continue;
            if (choice === "rename") {
              renames[p] = renameSuggestion(name, (candidate) =>
                names.has(candidate),
              );
              continue;
            }
            proceeding.push(p);
          }
          if (proceeding.length === 0) return;
          await window.api.sftp.upload(serverId, dir, proceeding, {
            overwrite: true,
            ...(Object.keys(renames).length > 0 ? { renameAs: renames } : {}),
          });
          void navigate(serverId, dir);
        })();
      },
    });
  };

  const onDragOverPane = (event: React.DragEvent): void => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  // In-pane drag = move within the same server: the dragged row's name rides SFTP_MOVE_MIME
  // (module scope), and the drop target (background = the CURRENT dir) decides the destination.

  const onDropOnTarget = async (
    event: React.DragEvent,
    targetDir: string | null,
  ): Promise<void> => {
    const localPaths = localPathsFromDrop(event);
    if (localPaths.length > 0 && serverId) {
      await uploadPaths(targetDir ?? cwd, localPaths);
      return;
    }
    const draggedName = event.dataTransfer?.getData(SFTP_MOVE_MIME);
    if (!draggedName || !serverId) return;
    event.preventDefault();
    event.stopPropagation();
    const dragged = sortedEntries.find((entry) => entry.name === draggedName);
    const target = targetDir ?? cwd;
    if (!dragged || !target) return;
    const source = joinRemoteFor(cwd, draggedName);
    const destination = joinRemoteFor(target, draggedName);
    if (destination === source || destination.startsWith(`${source}/`)) return;
    const targetState = await window.api.sftp.stat(serverId, destination);
    if (targetState.ok && targetState.entry.kind === "dir") return;
    await window.api.sftp.rename(serverId, source, destination);
    void navigate(serverId, target === cwd ? cwd : target);
  };

  // ── selection handlers ──────────────────────────────────────────────────────

  const onRowClick = (entry: SftpEntry, event: React.MouseEvent): void => {
    if (event.metaKey || event.ctrlKey) {
      setSelection(
        reduceSelection(selection, rowNames, {
          op: "toggle",
          name: entry.name,
        }),
      );
      setLastClick(entry.name);
      return;
    }
    if (event.shiftKey && lastClick) {
      setSelection(
        reduceSelection(selection, rowNames, {
          op: "range",
          from: lastClick,
          to: entry.name,
        }),
      );
      return;
    }
    if (entry.kind === "dir") {
      if (serverId) void navigate(serverId, joinRemoteFor(cwd, entry.name));
      return;
    }
    setSelection(
      reduceSelection(selection, rowNames, { op: "set-one", name: entry.name }),
    );
    setLastClick(entry.name);
  };

  const onRowKeyDown = (entry: SftpEntry, event: React.KeyboardEvent): void => {
    if (event.key === "Enter" && entry.kind === "dir" && serverId) {
      void navigate(serverId, joinRemoteFor(cwd, entry.name));
    }
  };

  // ── the file grammar (context menu / empty-state buttons) ──────────────────

  const runDownload = (): void => {
    if (!serverId || menuTargets.length === 0) return;
    void window.api.sftp
      .download(
        serverId,
        menuTargets.map((entry) => joinRemoteFor(cwd, entry.name)),
      )
      .catch(() => {});
  };

  const runUploadHere = (): void => {
    // The native picker opens in MAIN (upload with an empty localPaths array).
    if (!serverId) return;
    void window.api.sftp.upload(serverId, cwd, []);
  };

  const runDelete = (): void => {
    if (menuTargets.length === 0) return;
    setDeleteTarget(menuTargets);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!serverId || !deleteTarget) return;
    const targets = deleteTarget;
    setDeleteTarget(null);
    await window.api.sftp.delete(
      serverId,
      targets.map((entry) => joinRemoteFor(cwd, entry.name)),
    );
    void navigate(serverId, cwd);
  };

  const runCopy = (): void => {
    if (menuTargets.length === 0) return;
    setSftpClipboard({
      mode: "copy",
      paths: menuTargets.map((entry) => joinRemoteFor(cwd, entry.name)),
    });
  };

  const runCut = (): void => {
    if (menuTargets.length === 0) return;
    setSftpClipboard({
      mode: "cut",
      paths: menuTargets.map((entry) => joinRemoteFor(cwd, entry.name)),
    });
  };

  /** Paste (Copy or Cut): non-conflicts copy straight; conflicts resolve via the dialog, whose
   *  rewrite maps each name to its suffixed target. Cut clears on SUCCESS (the model's rule). */
  const runPaste = (): void => {
    if (!serverId || !clipboard || clipboard.paths.length === 0) return;
    const namesInTarget = sftpContextOf(serverId).cwdNames;
    const plan = pasteTargets(clipboard, cwd, namesInTarget);
    if (plan.pairs.length === 0 && plan.conflicts.length === 0) return;
    const run = async (
      resolution: ConflictResolution | null,
    ): Promise<void> => {
      const pairs = [...plan.pairs];
      for (const conflict of plan.conflicts) {
        const name = basenameRemoteish(conflict.to);
        const choice = resolution?.perName[name] ?? "skip";
        if (choice === "skip") continue;
        if (choice === "rename") {
          pairs.push({
            from: conflict.from,
            to: joinRemoteFor(
              cwd,
              renameSuggestion(name, (candidate) =>
                namesInTarget.has(candidate),
              ),
            ),
          });
          continue;
        }
        pairs.push(conflict);
      }
      if (pairs.length === 0) return;
      await window.api.sftp.copy(serverId, pairs);
      if (plan.cleared) setSftpClipboard(null);
      void navigate(serverId, cwd);
    };
    if (plan.conflicts.length > 0) {
      setConflictFlow({
        kind: "paste",
        names: plan.conflicts.map((c) => basenameRemoteish(c.to)),
        exists: (candidate) => namesInTarget.has(candidate),
        run: (resolution) => {
          void run(resolution);
        },
      });
      return;
    }
    void run({ perName: {} });
  };

  const runRename = (entry: SftpEntry): void => {
    setDraft({
      kind: "rename",
      path: joinRemoteFor(cwd, entry.name),
      initial: entry.name,
    });
  };

  const runNewFolder = (): void => {
    setDraft({
      kind: "new-folder",
      path: cwd,
      initial: t.sftp.menu.newFolderDefault,
    });
  };

  const runNewFile = (): void => {
    setDraft({
      kind: "new-file",
      path: cwd,
      initial: t.sftp.menu.newFileDefault,
    });
  };

  const confirmDraft = async (name: string): Promise<void> => {
    if (!serverId || !draft) return;
    const kind = draft.kind;
    setDraft(null);
    const parent =
      kind === "rename" ? breadcrumbParent(draft.path) : draft.path;
    const target = joinRemoteFor(parent, name);
    if (kind === "rename") {
      await window.api.sftp.rename(serverId, draft.path, target);
    } else if (kind === "new-folder") {
      await window.api.sftp.mkdir(serverId, target);
    } else {
      await window.api.sftp.createFile(serverId, target);
    }
    void navigate(serverId, cwd);
  };

  /** The parent dir of a full remote path (the rename context). */
  const breadcrumbParent = (path: string): string => {
    const cut = path.lastIndexOf("/");
    return cut <= 0 ? "/" : path.slice(0, cut);
  };

  // ── tree open / lazy load (one level at a time) ──────────────────────────────

  const ensureTreeChildren = async (dir: string): Promise<void> => {
    if (!serverId || treeChildren.has(dir)) return;
    setTreeLoading((prev) => new Set(prev).add(dir));
    const res = await window.api.sftp.list(serverId, dir);
    setTreeLoading((prev) => {
      const next = new Set(prev);
      next.delete(dir);
      return next;
    });
    if (!res.ok) return;
    setTreeChildren((prev) => {
      const next = new Map(prev);
      next.set(
        dir,
        [...res.entries].sort((a, b) => a.name.localeCompare(b.name)),
      );
      return next;
    });
  };

  const toggleTreeDir = (dir: string): void => {
    if (openDirs.has(dir)) {
      setOpenDirs((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
      return;
    }
    setOpenDirs((prev) => new Set(prev).add(dir));
    void ensureTreeChildren(dir);
  };

  /** Navigate on a tree NAME click (a dir → enter it; a file → no-op, the list is the surface). */
  const navigateTreeDir = (dir: string): void => {
    if (!serverId) return;
    setOpenDirs((prev) => new Set(prev).add(dir));
    void ensureTreeChildren(dir);
    void navigate(serverId, dir);
  };

  // ── context menu (the app's minimal local menu pattern, like the rail's) ────

  const menuOpen = (event: React.MouseEvent): void => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);

  const disabledTargets = menuTargets.length > 0;

  const transferRows = transfers.filter(
    (transfer) => !serverId || transfer.serverId === serverId,
  );
  const cancelTransfer = (id: string): void => window.api.sftp.cancel(id);
  const retryTransfer = (transfer: SftpTransfer): void => {
    if (!serverId) return;
    if (transfer.direction === "upload" && transfer.fromLocalPath) {
      void window.api.sftp.upload(serverId, cwd, [transfer.fromLocalPath], {
        overwrite: true,
      });
      return;
    }
    if (transfer.direction === "copy" && transfer.fromLocalPath) {
      void window.api.sftp.copy(serverId, [
        { from: transfer.fromLocalPath, to: transfer.remotePath },
      ]);
      return;
    }
    // download: the native dialog re-arms for the same remote path
    void window.api.sftp.download(serverId, [transfer.remotePath]);
  };

  const breadcrumbs = useMemo(() => cwd.split("/").filter(Boolean), [cwd]);
  const canPaste = clipboard !== null && clipboard.paths.length > 0;

  const onSortHeader = (key: SftpSortKey): void => {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  if (servers.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Icon className="text-(--ui-text-quaternary)" name="folder" size={22} />
        <p className="text-aux text-fg-faint">{t.sftp.empty.noServers}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Server + path bar */}
      <div className="shrink-0 border-b border-(--ui-stroke-tertiary) px-3 py-2">
        <CustomSelect
          ariaLabel={t.sftp.pane.serverLabel}
          className="w-full"
          menuClassName="min-w-full"
          onChange={(id) => {
            setSelection(new Set());
            const next = sftpContextOf(id);
            const nextCwd = next.home ?? "/";
            void navigate(id, nextCwd);
          }}
          options={serverOptions}
          value={serverId ?? ""}
        />
        {pathBarEditing ? (
          <input
            aria-label={t.sftp.path.edit}
            className="mt-2 w-full rounded-md border border-ink-700 bg-well px-2 py-1 font-mono text-aux text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
            onBlur={() => setPathBarEditing(false)}
            onChange={(e) => setPathBarValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && serverId) {
                const target = pathBarValue.trim();
                setPathBarEditing(false);
                if (target) void navigate(serverId, target);
              }
              if (e.key === "Escape") setPathBarEditing(false);
            }}
            placeholder={cwd}
            type="text"
            value={pathBarValue}
          />
        ) : (
          <div className="mt-2 flex items-center gap-1 overflow-x-auto text-aux [&::-webkit-scrollbar]:hidden">
            <button
              className="shrink-0 rounded-sm px-1 py-0.5 font-mono hover:bg-(--ui-row-hover-background) hover:text-fg"
              onClick={() => {
                if (serverId) void navigate(serverId, cwd || "/");
              }}
              type="button"
            >
              /
            </button>
            {breadcrumbs.map((segment, index) => (
              <div
                className="flex shrink-0 items-center gap-1"
                key={`${segment}-${index}`}
              >
                <span className="text-(--ui-text-quaternary)">/</span>
                <button
                  className={cx(
                    "rounded-sm px-1 py-0.5 font-mono hover:bg-(--ui-row-hover-background) hover:text-fg",
                    index === breadcrumbs.length - 1 && "text-fg",
                  )}
                  onClick={() => {
                    if (serverId) void navigate(serverId, pathUpTo(cwd, index));
                  }}
                  type="button"
                >
                  {segment}
                </button>
              </div>
            ))}
            <button
              aria-label={t.sftp.path.edit}
              className="ml-1 shrink-0 rounded-sm p-0.5 text-(--ui-text-quaternary) hover:bg-(--ui-row-hover-background) hover:text-fg"
              onClick={() => {
                setPathBarValue(cwd);
                setPathBarEditing(true);
              }}
              title={t.sftp.path.edit}
              type="button"
            >
              <Icon name="pencil" size={11} />
            </button>
          </div>
        )}
        {!pathBarEditing && listError && (
          <p className="mt-1 truncate text-meta text-danger" title={listError}>
            {listError}
          </p>
        )}
        {clipboard && clipboard.mode === "cut" && (
          <p className="mt-1 text-meta text-fg-faint">
            {t.sftp.menu.cutHint} {clipboard.paths.length}
          </p>
        )}
      </div>

      {/* Tree + list split */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Directory tree (lazy) */}
        <div className="min-h-24 shrink-0 basis-[40%] overflow-y-auto border-b border-(--ui-stroke-tertiary) px-1.5 py-1">
          <TreeRows
            childrenOf={(dir) => treeChildren.get(dir)}
            depth={0}
            dirs={sortedEntries
              .filter((entry) => entry.kind === "dir")
              .map((entry) => ({
                name: entry.name,
                path: joinRemoteFor(cwd, entry.name),
              }))}
            expandedDirs={openDirs}
            loadingDirs={treeLoading}
            onNameClick={(dir) => navigateTreeDir(dir)}
            onOpen={(dir) => toggleTreeDir(dir)}
          />
        </div>
        {/* File list */}
        <div
          className="relative min-h-0 flex-1 overflow-y-auto"
          onClick={() =>
            setSelection(reduceSelection(selection, rowNames, { op: "clear" }))
          }
          onDragOver={onDragOverPane}
          onDrop={(event) => void onDropOnTarget(event, null)}
        >
          {listStatus === "loading" ? (
            <div className="flex h-full items-center justify-center text-fg-faint">
              <Icon className="animate-spin" name="loader-circle" size={16} />
            </div>
          ) : sortedEntries.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <p className="text-aux text-fg-faint">{t.sftp.list.empty}</p>
              <div className="flex gap-2">
                <button
                  className="rounded-md border border-ink-700 px-2.5 py-1 text-aux text-fg-muted hover:border-ink-600 hover:text-fg"
                  onClick={runUploadHere}
                  type="button"
                >
                  {t.sftp.menu.uploadHere}
                </button>
                <button
                  className="rounded-md border border-ink-700 px-2.5 py-1 text-aux text-fg-muted hover:border-ink-600 hover:text-fg"
                  onClick={runNewFolder}
                  type="button"
                >
                  {t.sftp.menu.newFolder}
                </button>
              </div>
            </div>
          ) : (
            <div className="min-w-full">
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background) px-3 py-1 text-meta font-medium text-(--ui-text-tertiary)">
                <button
                  className="flex flex-1 items-center gap-1 text-left hover:text-fg"
                  onClick={() => onSortHeader("name")}
                  type="button"
                >
                  {t.sftp.list.name}
                  <SortMark
                    asc={sortAsc}
                    activeKey={sortKey}
                    headerKey="name"
                  />
                </button>
                <button
                  className="w-20 text-right hover:text-fg"
                  onClick={() => onSortHeader("size")}
                  type="button"
                >
                  {t.sftp.list.size}
                  <SortMark
                    asc={sortAsc}
                    activeKey={sortKey}
                    headerKey="size"
                  />
                </button>
                <button
                  className="w-36 text-right hover:text-fg"
                  onClick={() => onSortHeader("mtimeMs")}
                  type="button"
                >
                  {t.sftp.list.mtime}
                  <SortMark
                    asc={sortAsc}
                    activeKey={sortKey}
                    headerKey="mtimeMs"
                  />
                </button>
              </div>
              {sortedEntries.map((entry) => (
                <FileRow
                  cut={cutNames.has(entry.name)}
                  entry={entry}
                  key={entry.name}
                  onClick={(event) => onRowClick(entry, event)}
                  onContextMenu={(event) => {
                    // A right-click on an unselected row RE-SELECTS that row (the Finder rule).
                    if (!selection.has(entry.name)) {
                      setSelection(
                        reduceSelection(selection, rowNames, {
                          op: "set-one",
                          name: entry.name,
                        }),
                      );
                    }
                    menuOpen(event);
                  }}
                  onKeyDown={(event) => onRowKeyDown(entry, event)}
                  selected={selection.has(entry.name)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Transfers strip */}
      {transferRows.length > 0 && (
        <TransfersStrip
          onCancel={cancelTransfer}
          onRetry={retryTransfer}
          rows={transferRows}
        />
      )}

      {/* Overlays */}
      {menu && (
        <SftpContextMenu
          items={[
            { label: t.sftp.menu.open, disabled: true, run: () => {} },
            {
              label: t.sftp.menu.download,
              disabled: !disabledTargets,
              run: runDownload,
            },
            { label: t.sftp.menu.uploadHere, run: runUploadHere },
            { label: t.sftp.menu.newFile, run: runNewFile },
            { label: t.sftp.menu.newFolder, run: runNewFolder },
            {
              label: t.sftp.menu.rename,
              disabled: menuTargets.length !== 1,
              run: () => {
                if (menuTargets[0]) runRename(menuTargets[0]);
              },
            },
            {
              label: t.sftp.menu.delete,
              disabled: menuTargets.length === 0,
              run: runDelete,
            },
            { separator: true, label: "", disabled: false, run: () => {} },
            {
              label: t.sftp.menu.copy,
              disabled: !disabledTargets,
              run: runCopy,
            },
            { label: t.sftp.menu.cut, disabled: !disabledTargets, run: runCut },
            { label: t.sftp.menu.paste, disabled: !canPaste, run: runPaste },
          ]}
          onClose={() => setMenu(null)}
          position={menu}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          body={
            deleteTarget.some((entry) => entry.kind === "dir")
              ? t.sftp.confirm.deleteFolder
              : t.sftp.confirm.deleteBody(deleteTarget.length)
          }
          confirmLabel={t.sftp.menu.delete}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            void confirmDelete();
          }}
          title={t.sftp.confirm.deleteTitle(deleteTarget.length)}
          tone="danger"
        />
      )}
      {draft && (
        <NamePromptDialog
          initial={draft.initial}
          onCancel={() => setDraft(null)}
          onConfirm={(name) => {
            void confirmDraft(name);
          }}
          title={
            draft.kind === "rename"
              ? t.sftp.menu.rename
              : draft.kind === "new-folder"
                ? t.sftp.menu.newFolder
                : t.sftp.menu.newFile
          }
        />
      )}
      {conflictFlow && (
        <ConflictDialog
          exists={conflictFlow.exists}
          names={conflictFlow.names}
          onDone={(resolution) => {
            setConflictFlow(null);
            conflictFlow.run(resolution);
          }}
          title={
            conflictFlow.kind === "upload"
              ? t.sftp.conflict.uploadTitle
              : t.sftp.conflict.pasteTitle
          }
        />
      )}
    </div>
  );
}

/** The lazy directory tree (one row set per dir path, cached in the parent's map). */
function TreeRows({
  depth,
  dirs,
  expandedDirs,
  childrenOf,
  loadingDirs,
  onOpen,
  onNameClick,
}: {
  depth: number;
  dirs: readonly { path: string; name: string }[];
  expandedDirs: ReadonlySet<string>;
  childrenOf: (dir: string) => readonly SftpEntry[] | undefined;
  loadingDirs: ReadonlySet<string>;
  onOpen: (path: string, name: string) => void;
  onNameClick: (path: string) => void;
}) {
  const { t } = useI18n();
  if (dirs.length === 0) {
    if (depth === 0) {
      return (
        <p className="px-2 py-3 text-meta text-fg-quaternary">
          {t.sftp.tree.empty}
        </p>
      );
    }
    return null;
  }
  return (
    <ul className="flex flex-col">
      {dirs.map((dir) => {
        const expanded = expandedDirs.has(dir.path);
        const loading = loadingDirs.has(dir.path);
        const children = childrenOf(dir.path);
        return (
          <li key={dir.path} className="flex flex-col">
            <div
              className="flex min-w-0 items-center gap-1 rounded-sm pr-1 text-aux hover:bg-(--ui-row-hover-background) hover:text-fg"
              style={{ paddingLeft: `${depth * 12 + 2}px` }}
            >
              <button
                aria-label={dir.name}
                aria-expanded={expanded}
                className="shrink-0 rounded-sm p-0.5 hover:text-fg"
                onClick={() => onOpen(dir.path, dir.name)}
                title={dir.name}
                type="button"
              >
                {loading ? (
                  <Icon
                    className="animate-spin"
                    name="loader-circle"
                    size={11}
                  />
                ) : (
                  <Icon
                    name={expanded ? "chevron-down" : "chevron-right"}
                    size={11}
                  />
                )}
              </button>
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-0.5 text-left"
                onClick={() => onNameClick(dir.path)}
                title={dir.path}
                type="button"
              >
                <Icon
                  className="shrink-0 text-(--ui-text-tertiary)"
                  name={expanded ? "folder-open" : "folder"}
                  size={13}
                />
                <span className="min-w-0 truncate">{dir.name}</span>
              </button>
            </div>
            {expanded && (
              <TreeRows
                childrenOf={childrenOf}
                depth={depth + 1}
                dirs={(children ?? []).map((entry) => ({
                  name: entry.name,
                  path: joinRemoteFor(dir.path, entry.name),
                }))}
                expandedDirs={expandedDirs}
                loadingDirs={loadingDirs}
                onNameClick={onNameClick}
                onOpen={onOpen}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One file/directory row: grid of name/size/mtime; drag source for in-pane moves. */
function FileRow({
  entry,
  selected,
  cut,
  onClick,
  onKeyDown,
  onContextMenu,
}: {
  entry: SftpEntry;
  selected: boolean;
  cut: boolean;
  onClick: (event: React.MouseEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      aria-selected={selected}
      className={cx(
        "flex min-w-0 items-center gap-2 px-3 py-[3px] text-aux transition-colors",
        selected
          ? "bg-(--chrome-action-hover) text-fg"
          : "hover:bg-(--ui-row-hover-background) hover:text-fg",
        cut && "opacity-50",
      )}
      data-sftp-row={entry.name}
      data-sftp-kind={entry.kind}
      draggable
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragEnd={() => {
        rowRef.current?.classList.remove("opacity-40");
      }}
      onDragOver={(event) => {
        // Native in-pane drags move ONTO folder rows (the target dir); the pane background is
        // the general drop surface, but only folder rows highlight.
        if (entry.kind === "dir") event.preventDefault();
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData(SFTP_MOVE_MIME, entry.name);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDrop={() => {
        // No per-row drop: the event bubbles to the list container, whose handler drops into
        // the CURRENT directory (v1 scope — per-folder drop targets are a designer-pass want).
      }}
      onKeyDown={onKeyDown}
      ref={rowRef}
      role="option"
      tabIndex={0}
    >
      <span className="min-w-0 flex-1 truncate font-mono" title={entry.name}>
        {entry.name}
      </span>
      <span className="w-20 shrink-0 text-right text-meta tabular-nums text-fg-faint">
        {humanizeBytes(entry.size)}
      </span>
      <span className="w-36 shrink-0 text-right text-meta tabular-nums text-fg-faint">
        {humanizeMtime(entry.mtimeMs)}
      </span>
    </div>
  );
}

/** The sort header's direction mark (only visible on the active column). */
function SortMark({
  activeKey,
  headerKey,
  asc,
}: {
  activeKey: SftpSortKey;
  headerKey: SftpSortKey;
  asc: boolean;
}) {
  const { t } = useI18n();
  if (activeKey !== headerKey) return null;
  return (
    <Icon
      aria-label={t.sftp.list.sortDirectionLabel(asc)}
      name={asc ? "chevron-up" : "chevron-down"}
      size={10}
    />
  );
}

/** One transfer row: direction icon, name w/ progress fraction, cancel/retry. */
function TransferRow({
  transfer,
  onCancel,
  onRetry,
}: {
  transfer: SftpTransfer;
  onCancel: (id: string) => void;
  onRetry: (transfer: SftpTransfer) => void;
}) {
  const { t } = useI18n();
  const fraction = sftpTransferFraction(
    transfer.bytesDone,
    transfer.bytesTotal,
  );
  const failed = transfer.status === "failed";
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-3 py-1 text-aux"
      data-transfer-status={transfer.status}
    >
      <Icon
        name={
          transfer.direction === "upload"
            ? "arrow-up-right"
            : transfer.direction === "copy"
              ? "copy"
              : "arrow-up-right"
        }
        size={12}
      />
      <span
        className="min-w-0 flex-1 truncate font-mono"
        title={transfer.error ?? transfer.remotePath}
      >
        {transfer.name}
      </span>
      <div className="flex w-28 shrink-0 items-center justify-end gap-2">
        {transfer.status === "active" ? (
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-800">
            <div
              className={cx(
                "h-full rounded-full bg-primary",
                fraction === 0 && "animate-pulse",
              )}
              style={{ width: `${Math.max(4, Math.round(fraction * 100))}%` }}
            />
          </div>
        ) : (
          <span
            className={cx("text-meta", failed && "text-danger")}
            title={transfer.error}
          >
            {transfer.status === "done"
              ? t.sftp.transfers.done
              : transfer.status === "canceled"
                ? t.sftp.transfers.canceled
                : t.sftp.transfers.failed}
          </span>
        )}
      </div>
      {transfer.status === "active" ? (
        <button
          aria-label={t.sftp.transfers.cancel}
          className="shrink-0 rounded-sm p-0.5 hover:text-fg"
          onClick={() => onCancel(transfer.id)}
          title={t.sftp.transfers.cancel}
          type="button"
        >
          <Icon name="x" size={11} />
        </button>
      ) : failed ? (
        <button
          className="shrink-0 rounded-sm border border-ink-700 px-2 py-0.5 text-meta text-fg-muted hover:text-fg"
          onClick={() => onRetry(transfer)}
          type="button"
        >
          {t.sftp.transfers.retry}
        </button>
      ) : (
        <span className="w-3" />
      )}
    </div>
  );
}

/** The pane's bottom transfers strip: per DESIGN_NOTES, completed rows auto-dismiss after 3s
 *  (render-hidden state here — the registry keeps them until Clear finished / Clear all). */
function TransfersStrip({
  rows,
  onCancel,
  onRetry,
}: {
  rows: readonly SftpTransfer[];
  onCancel: (id: string) => void;
  onRetry: (transfer: SftpTransfer) => void;
}) {
  const { t } = useI18n();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const doneIds = rows
    .filter((row) => row.status === "done" || row.status === "canceled")
    .map((row) => row.id);
  useEffect(() => {
    if (doneIds.length === 0) return;
    const timer = setTimeout(() => {
      setHidden((prev) => {
        const next = new Set(prev);
        for (const id of doneIds) next.add(id);
        return next;
      });
    }, 3000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ids change drive the schedule
  }, [doneIds]);
  const visible = rows.filter((row) => !hidden.has(row.id));
  return (
    <div className="shrink-0 border-t border-(--ui-stroke-tertiary) bg-(--ui-editor-surface-background)">
      <div className="flex items-center justify-between px-3 pt-1.5">
        <span className="text-meta font-medium uppercase tracking-[0.12em] text-(--ui-text-tertiary)">
          {t.sftp.transfers.title}
        </span>
        <div className="flex gap-1">
          <button
            className="rounded-sm px-1.5 py-0.5 text-meta text-(--ui-text-tertiary) hover:text-fg"
            onClick={clearFinished}
            type="button"
          >
            {t.sftp.transfers.clearFinished}
          </button>
        </div>
      </div>
      <div className="max-h-40 overflow-y-auto pb-1.5">
        {visible.map((transfer) => (
          <TransferRow
            key={transfer.id}
            onCancel={onCancel}
            onRetry={onRetry}
            transfer={transfer}
          />
        ))}
      </div>
    </div>
  );

  function clearFinished(): void {
    setSftpTransfers(
      $sftpTransfers
        .get()
        .filter(
          (transfer) =>
            transfer.status === "active" || transfer.status === "failed",
        ),
    );
    setHidden(new Set());
  }
}

/** The pane's local context menu (the rail's pattern: a fixed card clamped, click-away closes). */
function SftpContextMenu({
  items,
  onClose,
  position,
}: {
  items: ReadonlyArray<{
    label: string;
    run: () => void;
    disabled?: boolean;
    separator?: boolean;
  }>;
  onClose: () => void;
  position: { x: number; y: number };
}) {
  const itemClass =
    "block w-full px-2.5 py-1 text-left text-[0.6875rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent";
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div
        className="fixed z-50 min-w-40 rounded-sm border border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background) py-1 shadow-lg"
        role="menu"
        style={{
          left: Math.min(position.x, window.innerWidth - 180),
          top: Math.min(position.y, window.innerHeight - 260),
        }}
      >
        {items.map((item, index) =>
          item.separator ? (
            <div
              className="mx-2 my-1 h-px bg-(--ui-stroke-tertiary)"
              key={`sep-${index}`}
            />
          ) : (
            <button
              className={itemClass}
              disabled={item.disabled}
              key={item.label}
              onClick={run(item.run)}
              role="menuitem"
              type="button"
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </>
  );
}
