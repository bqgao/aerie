/**
 * Pure renderer-side logic for the SFTP file-manager pane (pass F), kept lib-free and
 * window-free so it loads under both tsconfig passes and the node/jsdom test envs. The pane
 * component owns the React wiring; this file owns the STATE RULES: list sorting (dirs first),
 * the selection reducer (⌘ toggle / Shift range / ⌘A), clipboard semantics (copy vs cut,
 * server-scoped), conflict resolution with rename auto-suffixes, the humanizers, and the
 * transfer-progress fraction re-export. Remotepath math lives in @shared/sftp-paths (the one
 * module that builds remote paths, shared with main).
 */
import {
  conflictRenameCandidate,
  remotePathSegments,
} from "@shared/sftp-paths";
import type { SftpEntry } from "@shared/sftp";
import { sftpTransferFraction } from "@shared/sftp";

export type { sftpTransferFraction };

/** One list row's sort key + the header's cycle direction. */
export type SftpSortKey = "name" | "size" | "mtimeMs";

const DIR_RANK = (entry: SftpEntry): 0 | 1 => (entry.kind === "dir" ? 0 : 1);

/** Dirs first (both directions — the Finder convention), then the key with name as the tiebreak. */
export function compareEntries(
  a: SftpEntry,
  b: SftpEntry,
  key: SftpSortKey,
  dir: 1 | -1,
): number {
  const dirs = DIR_RANK(a) - DIR_RANK(b);
  if (dirs !== 0) return dirs;
  if (key === "name") {
    const byName = a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
    });
    return byName * dir;
  }
  const byNumber = a[key] - b[key];
  return (byNumber === 0 ? a.name.localeCompare(b.name) : byNumber) * dir;
}

/** Sorting is pure over the payload (stats ride the list already — no network sort). */
export function sortEntries(
  entries: readonly SftpEntry[],
  key: SftpSortKey,
  asc: boolean,
): SftpEntry[] {
  return [...entries].sort((a, b) => compareEntries(a, b, key, asc ? 1 : -1));
}

/** Humanize bytes the Finder-ish way (each unit grows past 1000, not 1024). */
export function humanizeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  if (i === 0) return `${Math.round(value)} ${units[0]}`;
  const round = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${round.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[i]}`;
}

/** Locale short time for the mtime column (never crashes on a weird clock). */
export function humanizeMtime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return "—";
  }
}

// ── selection (list-scoped; the tree is navigation only) ─────────────────────

export type SelectionEdit =
  | { op: "set-one"; name: string }
  | { op: "toggle"; name: string }
  | { op: "range"; from: string; to: string }
  | { op: "all" }
  | { op: "clear" };

/** The set-edit reducer: plain click replaces; ⌘ toggles; Shift fills the CONTIGUOUS slice
 *  between the anchor and the hit row in the GIVEN display order. */
export function reduceSelection(
  current: ReadonlySet<string>,
  rows: readonly string[],
  edit: SelectionEdit,
): Set<string> {
  const next = new Set(current);
  switch (edit.op) {
    case "clear":
      next.clear();
      return next;
    case "all":
      rows.forEach((name) => next.add(name));
      return next;
    case "set-one":
      next.clear();
      next.add(edit.name);
      return next;
    case "toggle":
      if (next.has(edit.name)) next.delete(edit.name);
      else next.add(edit.name);
      return next;
    case "range":
      next.clear();
      {
        const from = rows.indexOf(edit.from);
        const to = rows.indexOf(edit.to);
        if (from >= 0 && to >= 0) {
          const lo = Math.min(from, to);
          const hi = Math.max(from, to);
          for (let i = lo; i <= hi; i++) next.add(rows[i]);
        } else if (from >= 0) {
          next.add(edit.from);
        } else if (to >= 0) {
          next.add(edit.to);
        }
      }
      return next;
  }
}

// ── clipboard (server-scoped; the pane clears it on server switch) ───────────

export type SftpClipboard = { mode: "copy" | "cut"; paths: string[] } | null;

/** Paste targets for one directory: cut clears the clipboard (a one-shot move), copy keeps it
 *  (paste many). Names that would collide land in `conflicts` — the user resolves them via
 *  ConfirmDialog (overwrite/skip/rename) BEFORE main is called. */
export function pasteTargets(
  clipboard: SftpClipboard,
  targetDir: string,
  namesInTarget: ReadonlySet<string>,
): {
  pairs: Array<{ from: string; to: string }>;
  /** clearClipboard after a successful paste (cut = yes, copy = no). */
  cleared: boolean;
  conflicts: Array<{ from: string; to: string }>;
} {
  if (!clipboard || clipboard.paths.length === 0) {
    return { pairs: [], cleared: false, conflicts: [] };
  }
  const pairs: Array<{ from: string; to: string }> = [];
  const conflicts: Array<{ from: string; to: string }> = [];
  for (const from of clipboard.paths) {
    const segments = from.split("/").filter(Boolean);
    const name = segments[segments.length - 1] ?? from;
    if (name === from && !from.includes("/")) {
      // Malformed entry (not a path) — skip rather than fabricate a target.
      continue;
    }
    const to = joinRemoteFor(targetDir, name);
    if (namesInTarget.has(name)) conflicts.push({ from, to });
    else pairs.push({ from, to });
  }
  return { pairs, cleared: clipboard.mode === "cut", conflicts };
}

/** The rename candidate for a conflict's rename choice, re-exported so the rule lives in one
 *  module tree (sftp-paths). */
export function renameSuggestion(
  name: string,
  exists: (candidate: string) => boolean,
): string {
  return conflictRenameCandidate(name, exists);
}

/** Apply a conflict decision across one transfer batch: skip drops the row, overwrite passes
 *  the original target, rename rewrites to the suffixed candidate — the same rule for uploads
 *  (target = dir/name) and pastes (per-pair). */
export function applyConflict(
  name: string,
  target: string,
  choice: "overwrite" | "skip" | "rename",
  exists: (candidate: string) => boolean,
): { action: "skip" | "overwrite" | "rename"; target: string } {
  if (choice === "skip") return { action: "skip", target };
  if (choice === "rename") {
    // The rename lands BESIDE the original target (same parent dir), never a bare name.
    const cut = target.lastIndexOf("/");
    const parent = cut <= 0 ? "/" : target.slice(0, cut);
    return {
      action: "rename",
      target: `${parent}/${renameSuggestion(name, exists)}`,
    };
  }
  return { action: "overwrite", target };
}

// ── breadcrumb ───────────────────────────────────────────────────────────────

/** The absolute path after clicking breadcrumb segment index (root click = "/"). */
export function pathUpTo(path: string, index: number): string {
  const segments = remotePathSegments(path);
  if (index < 0 || index >= segments.length) return "/";
  return `/${segments.slice(0, index + 1).join("/")}`;
}

/** The bare last segment of a path with either separator (the pane's row/cut-label math). */
export function basenameRemoteish(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

/** The pane-side join (the builder of child paths for MAIN's normalized input; the remote
 *  canonicalization still happens main-side through sftp-paths). */
export function joinRemoteFor(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}
