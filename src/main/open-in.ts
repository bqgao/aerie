import {
  OPEN_IN_FAILED_MESSAGE,
  type OpenInTarget,
  type OpenInResult,
} from "@shared/ipc";

/** The slice of Electron's `shell` openIn needs. Narrowed to an interface so tests can inject a spy. */
export interface OpenInShell {
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

export interface OpenInDeps {
  /** Resolve a session's working directory from its id, or null when none can be found. */
  resolveCwd: (id: string) => string | null;
  /** True when `path` is an existing directory. */
  statDir: (path: string) => boolean;
  shell: OpenInShell;
}

/** Build VS Code's "open this path" URL: `vscode://file<absolutePath>` is the scheme VS Code registers.
 *  We encode segment by segment (spaces, `#`, `?`, unicode all become safe) and keep `/` literal. We avoid
 *  `pathToFileURL` on purpose: it resolves a drive-less path against the process's current drive on Windows,
 *  so the same input would yield a different URL depending on the host. This keeps `vscodeUrl` a pure
 *  function of its argument. A leading Windows drive letter's colon is restored — VS Code wants it raw. */
export function vscodeUrl(cwd: string): string {
  const path = cwd
    .replace(/\\/g, "/")
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/^\/?([A-Za-z])%3A\//, "/$1:/");
  return `vscode://file${path.startsWith("/") ? path : `/${path}`}`;
}

/** Resolve the session's folder and open it in `target`. Never throws: every failure is an
 *  `{ ok: false, error }` the renderer can surface. The path is resolved and validated here, so the
 *  renderer never supplies or sees a filesystem path. */
export async function openInTarget(
  deps: OpenInDeps,
  id: string,
  target: OpenInTarget,
): Promise<OpenInResult> {
  const cwd = deps.resolveCwd(id);
  if (!cwd) return { ok: false, error: "No folder found for this session." };
  if (!deps.statDir(cwd))
    return { ok: false, error: "Folder no longer exists." };
  try {
    switch (target) {
      case "finder": {
        const err = await deps.shell.openPath(cwd);
        return err ? { ok: false, error: err } : { ok: true };
      }
      case "vscode": {
        await deps.shell.openExternal(vscodeUrl(cwd));
        return { ok: true };
      }
      default: {
        // Unreachable for a well-typed OpenInTarget; the `never` assignment makes a new target a compile
        // error here rather than a silent fall-through to one of the branches. At the IPC boundary, where
        // a buggy renderer could send anything, this turns a bad value into an honest failure.
        const unknown: never = target;
        return { ok: false, error: `Unknown target: ${String(unknown)}` };
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : OPEN_IN_FAILED_MESSAGE,
    };
  }
}

/** The folder-level sibling of openInTarget: the sidebar's project row opens its own working
 *  directory, which no session id resolves from. `isKnownProject` keeps the renderer from handing
 *  main an arbitrary path — only a cwd the session index lists may be revealed. Never throws. */
export interface RevealProjectDeps {
  /** True when `cwd` belongs to (or contains) at least one indexed session. */
  isKnownProject: (cwd: string) => boolean;
  statDir: (path: string) => boolean;
  shell: OpenInShell;
}

/** The sidebar groups by repository root, which is usually an ANCESTOR of the folder a session
 *  recorded as its cwd — equality against the stored cwds would refuse most real projects. Accept
 *  a known cwd, any ancestor of one (the repo root case), or any descendant (a folder opened into),
 *  comparing on path boundaries so `/repo-old` never matches `/repo`. */
export function isProjectWithinKnownDirs(
  dir: string,
  knownCwds: readonly string[],
): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+$/, "");
  const d = norm(dir);
  if (!d) return false;
  return knownCwds.some((raw) => {
    const c = norm(raw);
    if (!c) return false;
    return (
      c === d ||
      c.startsWith(`${d}/`) ||
      c.startsWith(`${d}\\`) ||
      d.startsWith(`${c}/`) ||
      d.startsWith(`${c}\\`)
    );
  });
}

export async function revealProjectFolder(
  deps: RevealProjectDeps,
  cwd: unknown,
): Promise<OpenInResult> {
  if (typeof cwd !== "string" || cwd.length === 0)
    return { ok: false, error: "No folder found for this project." };
  if (!deps.isKnownProject(cwd))
    return { ok: false, error: "Unknown project." };
  if (!deps.statDir(cwd))
    return { ok: false, error: "Folder no longer exists." };
  try {
    const err = await deps.shell.openPath(cwd);
    return err ? { ok: false, error: err } : { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : OPEN_IN_FAILED_MESSAGE,
    };
  }
}

/** Select a session's transcript file in the OS file manager. The path is resolved here and never
 *  crosses IPC; `exists` turns a pruned file into an honest failure instead of a silent no-op. */
export interface RevealTranscriptDeps {
  resolveTranscriptPath: (id: string) => string | null;
  exists: (path: string) => boolean;
  shell: OpenInShell;
}

export function revealSessionTranscript(
  deps: RevealTranscriptDeps,
  id: unknown,
): OpenInResult {
  if (typeof id !== "string" || id.length === 0)
    return { ok: false, error: "No session given." };
  const path = deps.resolveTranscriptPath(id);
  if (!path)
    return { ok: false, error: "No transcript file for this session." };
  if (!deps.exists(path))
    return { ok: false, error: "Transcript file no longer exists." };
  try {
    deps.shell.showItemInFolder(path);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : OPEN_IN_FAILED_MESSAGE,
    };
  }
}
