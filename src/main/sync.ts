import type { PersistedSession } from "@shared/types";
import type { Provider } from "./provider/types";
import { transaction, type SqliteDb } from "./db/driver";
import {
  getPersisted,
  upsertSessions,
  pruneSessions,
  readDismissedSessions,
  undismissSessions,
} from "./db/store";

export interface SyncResult {
  /** Ids whose transcript was (re)parsed this pass. */
  parsedIds: string[];
  /** Ids dropped from the index (aged out of the window and not live). */
  prunedIds: string[];
}

/**
 * One incremental sync pass. Reads the indexed snapshots once, enumerates candidates cheaply, then
 * for each: reparse only if its transcript's mtime advanced past what's stored; otherwise reuse the
 * stored snapshot, refreshing just its state from fresh liveness (this is how a finished session
 * becomes Ended without ever touching its transcript again). Upsert the result and prune whatever's
 * no longer recent or live. Re-running with no file changes parses nothing and leaves the rows
 * identical.
 */
export async function syncSessions(
  db: SqliteDb,
  provider: Provider,
): Promise<SyncResult> {
  const stored = new Map(getPersisted(db).map((s) => [s.id, s]));
  const dismissed = readDismissedSessions(db);
  // A dismissed session stays hidden — UNLESS its transcript woke back up after dismissal (the
  // user resumed it from the CLI). Live-again work must reappear, so the tombstone flips back
  // off and the row re-enters the index like any other candidate.
  const revivedIds: string[] = [];
  const candidates = (await provider.listCandidates()).filter((c) => {
    const dismissedAt = dismissed.get(c.id);
    if (dismissedAt === undefined) return true;
    if (c.transcriptMtimeMs > dismissedAt) {
      revivedIds.push(c.id);
      return true;
    }
    return false;
  });
  undismissSessions(db, revivedIds);

  const snapshots: PersistedSession[] = [];
  const parsedIds: string[] = [];
  for (const c of candidates) {
    const prev = stored.get(c.id);
    const changed =
      c.transcriptMtimeMs > 0 &&
      (!prev || c.transcriptMtimeMs > prev.transcriptMtimeMs);
    if (changed) {
      snapshots.push(await provider.summarize(c)); // new or advanced transcript → parse
      parsedIds.push(c.id);
    } else if (prev) {
      snapshots.push(provider.restate(c, prev)); // unchanged → reuse, refresh state only, no parse
    } else {
      snapshots.push(await provider.summarize(c)); // first sight, no transcript → registry skeleton, no parse
    }
  }

  const keep = new Set(candidates.map((c) => c.id));
  const prunedIds = [...stored.keys()].filter((id) => !keep.has(id));

  // One transaction so the pass is all-or-nothing: a crash or throw between the upsert and the
  // prune can't leave the index holding both fresh snapshots and rows that should have aged out.
  transaction(db, () => {
    upsertSessions(db, snapshots);
    pruneSessions(db, [...keep]);
  });

  return { parsedIds, prunedIds };
}
