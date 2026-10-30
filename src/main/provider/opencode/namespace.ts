/**
 * Remote opencode session ids are namespaced at the app level: `<serverId>:<raw-ses-id>` — the
 * same contract OPENCODE_REMOTE_DESIGN.md chose (it prevents cross-server id collisions in the
 * sessions DB and the managed registry, and gives the renderer a stable identity without schema
 * changes). Local rows stay bare. A serverId is the profile mint (`srv-…`), so it can never
 * contain the separator itself.
 */
export const NAMESPACE_SEP = ":";

/** The app-level compound id for a session that lives on a remote opencode serve. */
export function namespacedId(serverId: string, raw: string): string {
  return `${serverId}${NAMESPACE_SEP}${raw}`;
}

/** Split an app-level id into its server + raw halves. Null when bare — a LOCAL session, no
 *  prefix to strip (every remote id carries the server mint, which never looks like `ses_…`). */
export function parseNamespacedId(
  id: string,
): { serverId: string; raw: string } | null {
  const index = id.indexOf(NAMESPACE_SEP);
  if (index <= 0 || index === id.length - 1) return null;
  return { serverId: id.slice(0, index), raw: id.slice(index + 1) };
}

/** One remote source as the provider sees it: an ensured transport ({@link baseUrl} is the
 *  tunnel's loopback port or the directUrl) plus the serve password for the Basic header. */
export interface RemoteSource {
  serverId: string;
  baseUrl: string;
  password: string | null;
}
