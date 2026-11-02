/**
 * Remote (POSIX) path helpers for the SFTP file manager — the ONLY module that builds remote
 * paths. DESIGN_NOTES §F note 4: path normalization is SERVER-side of the renderer (this file),
 * which never assembles paths by raw string concat. Guards: reject NUL (SFTPv3 paths are C
 * strings), collapse `//` and `/./`/`/x/../` lexically (a lexical normalize is safe for path
 * SHAPES; the real server resolution remains the authoritative `stat` answer), and preserve
 * absolute-ness. Windows local paths never appear in these helpers — these are REMOTE paths only.
 */

/** Normalize a remote path the user/renderer provided. Returns null on NUL or an empty result. */
export function normalizeRemotePath(input: string): string | null {
  if (typeof input !== "string") return null;
  if (!input.trim()) return null;
  if (input.includes("\0")) return null;
  const absolute = input.startsWith("/") || input.startsWith("~");
  const collapsed: string[] = [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Pop lexically; popping past the root clamps (a normalized path stays normalized).
      if (collapsed.length > 0 && collapsed[collapsed.length - 1] !== "..")
        collapsed.pop();
      else if (!absolute) collapsed.push("..");
      continue;
    }
    collapsed.push(seg);
  }
  if (collapsed.length === 0) return absolute ? "/" : null;
  const out = (absolute ? "/" : "") + collapsed.join("/");
  return out;
}

/** Join a directory and a bare child name into a remote path (the only path builder the
 *  service uses for children). The name must be a BARE segment (no `/`, no `\0`): enforced, so
 *  a renderer can never smuggle a traversal into a "child" name. */
export function joinRemote(dir: string, name: string): string | null {
  if (!name || name.includes("/") || name.includes("\0")) return null;
  if (!dir) return null;
  const base = normalizeRemotePath(dir);
  if (!base) return null;
  if (base === "/") return `/${name}`;
  return `${base}/${name}`;
}

/** The bare name of a remote path (the transfer label). */
export function remoteBasename(path: string): string {
  const segments = path.split("/");
  const last = segments[segments.length - 1];
  if (!last) return path;
  return last || "/";
}

/** The parent directory of a remote path ("/" for root children; null for a bare segment). */
export function remoteDirname(path: string): string | null {
  if (!path.includes("/")) return null;
  if (path === "/") return "/";
  const withoutTrailing = path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = withoutTrailing.lastIndexOf("/");
  if (cut <= 0) return "/";
  return normalizeRemotePath(withoutTrailing.slice(0, cut)) ?? "/";
}

/** The breadcrumb segments, root-first, absolute only ("/" → []). */
export function remotePathSegments(path: string): string[] {
  const normalized = normalizeRemotePath(path);
  if (!normalized || normalized === "/") return [];
  if (!normalized.startsWith("/")) return [normalized];
  return normalized.slice(1).split("/");
}

/** A `name-2`-style auto-suffix for rename-conflicts: file.ext → file-2.ext. Dot-leading names
 *  ("dotfiles") never split their ext (".profile-2"); un-adorned names suffix bare. */
export function conflictRenameCandidate(name: string, exists: (candidate: string) => boolean): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${stem}-${Date.now().toString(36)}${ext}`;
}
