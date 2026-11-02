/**
 * The transcript→editor link resolver (pass I-b). A pure function over (session id, session
 * directory, transcript path candidate) that answers WHICH tab to open — a local file tab or
 * a server file tab — or that the affordance is NOT offered. Lives in the workspace tree as a
 * JSX-free module (loads under both tsconfig passes and the node test env, like editor-model).
 *
 * Rules (the binding scope, no heuristics):
 * - The candidate must ITSELF be one path — the resolution never searches a command string for
 *   path-shaped substrings. Callers hand it the tool part's entire path-carrying field (the
 *   drill-in modal's `command`, or a diff event's `file`); anything else (a shell command, a
 *   glob pattern) simply doesn't resolve and the affordance isn't rendered.
 * - Absolute paths only, under the session's own directory (Windows compare folds case, the
 *   same "spell it two ways" rule fileio's gate uses). A relative path is never joined onto
 *   the session dir — the spec refuses the ambiguity, not just the foreign hits.
 * - Source by agent×location: the session id decides REMOTENESS (a remote opencode session's
 *   app-level id is `<serverId>:<raw>` — the same contract opencode/namespace.ts mints;
 *   local sessions of every agent stay bare). Local → `local:<path>`; remote →
 *   `srv:<serverId>:<path>` (the file lives on the remote host; the SFTP read family handles
 *   it and the tab badge keeps the server origin). The server prefix is the profile mint
 *   (`srv-…`), which can never contain the separator.
 */

/** Mirror of opencode/namespace.ts's parseNamespacedId (kept value-identical; the main-side
 *  module stays main-only so the renderer never imports across the layer). */
export function serverIdOfSessionId(sessionId: string): string | null {
  const index = sessionId.indexOf(":");
  if (index <= 0 || index === sessionId.length - 1) return null;
  return sessionId.slice(0, index);
}

export type ToolFileTarget =
  | { kind: "local"; path: string }
  | { kind: "server"; serverId: string; path: string };

export interface ToolFileSource {
  /** The session's app-level id (remote opencode ids carry the `srv-…:` prefix). */
  sessionId: string;
  /** The session's directory — the containment base for local (and remote) candidates. */
  cwd: string;
  /** The host platform (`process.platform`), so Windows paths fold their case like main's
   *  path gates do. The renderer passes `window.api.platform`; tests pass the fixture's. */
  platform: string;
}

/** One path separator backslash for the posix check: REMOTE paths are always posix, but a
 *  local Windows session's candidates are backslashed — both spellings must parse. */
const isAbsoluteCandidate = (path: string, platform: string): boolean => {
  if (!path) return false;
  if (path.startsWith("/") || path.startsWith("\\\\")) return true;
  if (platform === "win32") {
    return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\?\\");
  }
  return false;
};

/** Collapse `.`/`..`/duplicate separators on the ONE spelling the platform folds to (both
 *  paths fold case on win32 first, `/` = `\` there; elsewhere slashes). A leading drive
 *  segment keeps its colon and the collapsed root keeps its leading slash. */
function collapsePath(path: string, platform: string): string {
  const sep = platform === "win32" ? "\\" : "/";
  const fold = (p: string) =>
    platform === "win32" ? p.replace(/\//g, sep).toLowerCase() : p;
  const parts = fold(path)
    .split(sep)
    .filter((p) => p !== "" && p !== ".");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else out.push(part);
  }
  const joined = out.join(sep);
  if (platform === "win32") return joined;
  return fold(path).startsWith(sep) ? `/${joined}` : joined;
}

/** Under the session's directory (case-folded on Windows, where `/` and `\` are the same
 *  separator; BOTH sides are collapsed first, so a `../sibling` spelling can't smuggle a
 *  foreign path under the check). Equality passes too — the candidate may BE the session
 *  directory itself. */
const underDir = (
  candidate: string,
  dir: string,
  platform: string,
): boolean => {
  if (!dir) return false;
  const sep = platform === "win32" ? "\\" : "/";
  const base = collapsePath(dir, platform).replace(/[\\/]+$/, "");
  const child = collapsePath(candidate, platform);
  return child === base || child.startsWith(`${base}${sep}`);
};

export function toolFileTarget(
  source: ToolFileSource,
  rawCandidate: unknown,
): ToolFileTarget | null {
  if (typeof rawCandidate !== "string") return null;
  const candidate = rawCandidate.trim();
  if (!candidate || candidate.includes("\0")) return null;
  if (!isAbsoluteCandidate(candidate, source.platform)) return null;
  const serverId = serverIdOfSessionId(source.sessionId);
  if (serverId) {
    if (!candidate.startsWith("/")) return null; // remote paths are always posix absolute
    return underDir(candidate, source.cwd, "darwin")
      ? { kind: "server", serverId, path: candidate }
      : null;
  }
  return underDir(candidate, source.cwd, source.platform)
    ? { kind: "local", path: candidate }
    : null;
}

/** The session row + tool input => target (the affordance's single wiring point: both the
 *  tool drill-in and the diff modals funnel here; a null means DON'T render the button). */
export function toolFileTargetOf(
  source: ToolFileSource | null,
  candidate: string | null | undefined,
): ToolFileTarget | null {
  if (!source || !candidate) return null;
  return toolFileTarget(source, candidate);
}
