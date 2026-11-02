/**
 * The ⌘⇧O Quick palette's pure logic (B2, SEARCH_QUICKJUMP_SPEC run B2). Kept JSX-free and
 * window-free so it loads under both tsconfig passes and the jsdom/node test envs — the
 * quick-palette split. This file owns the STATE RULES: the no-dependency fuzzy scorer
 * (subsequence over code points with word-boundary/consecutive-run/start bonuses, merged
 * with the plain case-insensitive substring filter so literal CJK queries never lose to
 * fuzzy latin), source aggregation (the App's sessions + project groups, $serverProfiles,
 * $editorTabs) into one ranked, kind-capped row list, the ↑↓ navigation reducer, the
 * chord matcher, and the open/close atom. QuickPalette.tsx owns the React wiring, the
 * modal chrome, and the actual actions.
 */
import { atom } from "nanostores";
import type { AgentId } from "@shared/agents";
import type { Session } from "@shared/types";
import type { ServerProfile, ServerStatus } from "@shared/servers";
import { groupSessionsByProject, sessionRepoLabel } from "./session-list-model";
import type { SessionGroup } from "./session-list-model";
import { isDirty, type EditorTab } from "./editor/editor-model";

// ── the open/close atom ──────────────────────────────────────────────────────

/** Whether the palette is mounted (ModalShell). App.tsx only renders one component; the
 *  state lives here so the window keybind (bubble phase) can toggle without threading
 *  props, exactly like the other shell stores. */
export const $quickPaletteOpen = atom(false);

export function openQuickPalette(): void {
  $quickPaletteOpen.set(true);
}

export function closeQuickPalette(): void {
  $quickPaletteOpen.set(false);
}

/** A structural `role="dialog"[aria-modal]` probe — every modal in the app is ModalShell,
 *  so "any dialog in the DOM" is the gate for "don't stack the palette over it" (the
 *  dirty-close confirm included: same ModalShell chrome). */
export function paletteOpenAllowed(root: {
  querySelector(selector: string): Element | null;
}): boolean {
  return root.querySelector('[role="dialog"][aria-modal="true"]') === null;
}

// ── the chord matcher ────────────────────────────────────────────────────────

/** The event shape is narrowed deliberately so the matcher stays pure and testable. */
export interface PaletteChordEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  code: string;
}

/** (⌘|Ctrl)+⇧+O, any Alt combination out. `code === "KeyO"` pins the physical key so an
 *  international layout's `key` value ("ö" etc.) can't break the chord. */
export function isQuickPaletteChord(event: PaletteChordEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.code === "KeyO"
  );
}

// ── the scorer ───────────────────────────────────────────────────────────────

/** Per-matched-code-point baseline; bonuses are multiples of it. */
const MATCH_POINTS = 2;
/** A run bonus per matched code point that directly continues the previous match — set
 *  above the boundary reward so a tight contiguous run always outranks the same letters
 *  spread across word breaks (VS Code-style alignment behavior). */
const CONSECUTIVE_BONUS = 9;
/** A match landing after a word break (a non-letter/digit, or the string's start). CJK
 *  counts as a break — like the rail's search box, Chinese needs no pseudo-words. */
const BOUNDARY_BONUS = 5;
/** Every unmatched code point crossed between matches, capped so a long haystack's
 *  scattered tail can't outweigh a shorter candidate's alignment. */
const GAP_PENALTY_CAP = 8;
/** Literal `q…` prefix / elsewhere-substring boosts — prefix > substring > scattered
 *  (the run/boundary bonuses above rank the scattered tier), and the substring path is
 *  what keeps a plain CJK query (推理) above dispersed latin. */
const SUBSTRING_BONUS = 50;
const PREFIX_BONUS = 80;

function isWordChar(ch: string): boolean {
  return /^[a-z0-9]$/i.test(ch);
}

/** Subsequence match over code points (never UTF-16 units, so astral emoji and the
 *  surrogate-heavy part of a repo name stay aligned): scores alignment, or null when the
 *  query is not a subsequence. */
function subsequenceScore(query: string, haystack: string): number | null {
  const q = [...query];
  const s = [...haystack];
  let qi = 0;
  let score = 0;
  // -2 = "no previous match yet": the first match charges only its own leading gap,
  // never a phantom inter-match span.
  let prev = -2;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] !== q[qi]) continue;
    if (qi === 0 && si === 0) {
      score += MATCH_POINTS + BOUNDARY_BONUS; // start-of-string match
    } else {
      score += MATCH_POINTS;
      // The gap charge: capped, and for the first match it's the string-leading span.
      score -= Math.min(
        Math.max(0, si - (prev < 0 ? 0 : prev) - 1),
        GAP_PENALTY_CAP,
      );
      if (prev === si - 1) score += CONSECUTIVE_BONUS;
      else if (si > 0 && !isWordChar(s[si - 1])) score += BOUNDARY_BONUS;
    }
    prev = si;
    qi++;
  }
  if (qi < q.length) return null;
  return score;
}

/**
 * The palette's one scorer: a query's score against a candidate's text, null when no
 * match. Case-fold both sides first; the literal-substring boost then rides whatever the
 * subsequence pass already returned, so 推理 over 会话记录·推理 hits the substring bonus
 * and outranks a scattered long-title latin match. An empty (blank) query has no score —
 * callers short-circuit to the recency list.
 */
export function scoreMatch(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const s = text.toLowerCase();
  const base = subsequenceScore(q, s);
  if (base === null) return null;
  if (s.startsWith(q)) return base + PREFIX_BONUS;
  if (s.includes(q)) return base + SUBSTRING_BONUS;
  return base;
}

// ── rows ─────────────────────────────────────────────────────────────────────

export type PaletteKind = "session" | "project" | "server" | "tab";

/** The action payload each row carries to QuickPalette.tsx — the component switches on
 *  `kind` and runs the existing select/openServerTerminal/activate actions verbatim. */
export type PaletteSource =
  | { kind: "session"; session: Session }
  /** The group's most-recent session is pre-resolved here so the component's action is
   *  a plain id handoff. */
  | { kind: "project"; sessionId: string; group: SessionGroup }
  | { kind: "server"; profile: ServerProfile }
  | { kind: "tab"; tab: EditorTab };

export interface PaletteRow {
  /** Unique within one build (kind prefix + the source's own id). */
  id: string;
  source: PaletteSource;
  /** The primary label (scored, truncated by CSS). */
  title: string;
  /** The dimmed tail: worktree hint / parent hint / host / path. */
  hint: string | null;
  /** The agent brand mark (rail rows carry one; servers and tabs don't). */
  agent: AgentId | null;
  /** The editor-tab grammar's dirty dot (false for every other kind). */
  dirty: boolean;
  /** The right-edge chip (server's group / project's session count). */
  badge: string | null;
}

/** Rank input the builder pairs with each row before the caps. */
type Candidate = { row: PaletteRow; score: number };

interface PaletteInput {
  query: string;
  sessions: Session[];
  homeDir: string;
  servers: readonly ServerProfile[];
  serverStatus: Readonly<Record<string, { status: ServerStatus }>>;
  tabs: readonly EditorTab[];
}

/** Per-kind caps, then one total — "max ~12 visible rows" (spec). */
export const PALETTE_CAPS: Record<PaletteKind, number> = {
  session: 4,
  project: 3,
  server: 3,
  tab: 3,
};
export const PALETTE_ROW_CAP = 12;

/** The ServerRailSection row lamp's own hue chain, verbatim (no new design language). */
export function serverLampClass(status: ServerStatus): string {
  return status === "connected"
    ? "h-2 w-2 rounded-full bg-working shadow-[0_0_0.375rem_rgba(45,212,191,0.5)]"
    : status === "connecting"
      ? "h-2 w-2 animate-pulse rounded-full bg-accent"
      : status === "error"
        ? "h-2 w-2 rounded-full bg-danger"
        : "h-2 w-2 rounded-full bg-ink-600";
}

function sessionRow(s: Session): PaletteRow {
  return {
    id: `session:${s.id}`,
    source: { kind: "session", session: s },
    title: s.title,
    hint: s.worktree?.name ?? null,
    agent: s.agent,
    dirty: false,
    badge: null,
  };
}

/**
 * One build = the palette's whole list. Kind order is fixed (Sessions → Projects →
 * Servers → Editor tabs); within a kind, score-first with the input order as the stable
 * tie-break (sessions arrive recency-sorted from the App, groups are recency-sorted by
 * groupSessionsByProject, servers keep the profile order, tabs keep the open order).
 * The scored text is `title + hint` composite so a query like "web flas" matches through
 * both halves the way the rail's search box matches title+label.
 */
export function buildPaletteRows(input: PaletteInput): PaletteRow[] {
  const q = input.query.trim();

  const pick = (
    kind: PaletteKind,
    candidates: Array<{ row: PaletteRow; text: string }>,
  ): Candidate[] => {
    const ranked = candidates
      .map(({ row, text }) => ({
        row,
        score: q ? (scoreMatch(q, text) ?? -Infinity) : 0,
      }))
      .filter((c) => c.score > -Infinity);
    return ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, PALETTE_CAPS[kind]);
  };

  const groups = groupSessionsByProject(input.sessions, input.homeDir);
  const sessionsRanked = pick(
    "session",
    input.sessions.map((s) => {
      const row = sessionRow(s);
      return { row, text: `${s.title} ${sessionRepoLabel(s)}` };
    }),
  );

  const projectsRanked = pick(
    "project",
    groups
      .map((group) => {
        const first = group.sessions[0];
        if (!first) return null;
        const row: PaletteRow = {
          id: `project:${group.key}`,
          source: { kind: "project", sessionId: first.id, group },
          title: group.label,
          hint: group.hint ?? null,
          agent: null,
          dirty: false,
          badge: String(group.sessions.length),
        };
        return { row, text: `${group.label} ${group.hint ?? ""}` };
      })
      // Empty groups cannot occur (every session lands in some bucket) — a guard type
      // needs no special-casing beyond this filter.
      .filter((entry): entry is { row: PaletteRow; text: string } => !!entry),
  );

  const serversRanked = pick(
    "server",
    input.servers.map((profile) => {
      const row: PaletteRow = {
        id: `server:${profile.id}`,
        source: { kind: "server", profile },
        title: profile.name,
        hint: `${profile.username}@${profile.host}`,
        agent: null,
        dirty: false,
        badge: profile.group || null,
      };
      return {
        row,
        text: `${profile.name} ${profile.group} ${profile.username}@${profile.host}`,
      };
    }),
  );

  const tabsRanked = pick(
    "tab",
    input.tabs.map((tab) => {
      const row: PaletteRow = {
        id: `tab:${tab.id}`,
        source: { kind: "tab", tab },
        title: tab.name,
        hint: tab.origin.path,
        agent: null,
        dirty: isDirty(tab),
        badge: null,
      };
      return { row, text: `${tab.name} ${tab.origin.path}` };
    }),
  );

  return [...sessionsRanked, ...projectsRanked, ...serversRanked, ...tabsRanked]
    .slice(0, PALETTE_ROW_CAP)
    .map((c) => c.row);
}

/** The pinned "Search transcripts…" row's visibility rule: blank query, or the query
 *  fuzzy-matches the row's own (locale-rendered) label. `label` is passed in by the
 *  component so the model never hard-codes English. */
export function shouldShowSearchRowsRow(query: string, label: string): boolean {
  return !query.trim() || scoreMatch(query, label) !== null;
}

// ── navigation ───────────────────────────────────────────────────────────────

/** The list's selection: `index` into the rendered flat row order, `count` the render's
 *  row count (passed in by the component, kept here so the reducer stays pure). */
export interface PaletteNav {
  index: number;
  count: number;
}

export type PaletteNavEvent =
  | { type: "up" }
  | { type: "down" }
  | { type: "jump"; index: number }
  | { type: "home" };

/** Arrow navigation with wrap; jump/home clamp (the click/set paths). An empty list
 *  pins at 0 whatever happens. */
export function reducePaletteNav(
  nav: PaletteNav,
  event: PaletteNavEvent,
): PaletteNav {
  if (nav.count <= 0) return { index: 0, count: nav.count };
  switch (event.type) {
    case "up":
      return { ...nav, index: (nav.index - 1 + nav.count) % nav.count };
    case "down":
      return { ...nav, index: (nav.index + 1) % nav.count };
    case "jump":
      return {
        ...nav,
        index: Math.max(0, Math.min(event.index, nav.count - 1)),
      };
    case "home":
      return { ...nav, index: 0 };
  }
}
