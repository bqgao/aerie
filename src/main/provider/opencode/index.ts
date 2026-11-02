import type { Provider } from "../types";
import type {
  PersistedSession,
  Session,
  SessionCandidate,
} from "@shared/types";
import type { TranscriptReadWire, ToolResultDetail } from "@shared/transcript";
import { normalizeModelId } from "@shared/models";
import { toTranscriptWire } from "@shared/transcript";
import { metricsToken } from "../metrics-token";
import { SPEED_WINDOW_MS } from "../claude/transcript-speed";
import { deriveSessionState } from "../claude/state";
import { projectFromCwd } from "../../project-name";
import { hydrate } from "../../db/store";
import { readGit } from "../../git/read-git";
import { readPr } from "../../git/read-pr";
import { MAX_SESSION_TITLE_LEN } from "@shared/title-override";
import { asRecord } from "../codex/rollout";
import {
  namespacedId,
  parseNamespacedId,
  type RemoteSource,
} from "./namespace";
import { buildTranscriptDoc, type OpencodeMessage } from "./transcript-events";
import { extractToolResult } from "./tool-result";
import { speedFromMessages, usageFromRow, ZERO_USAGE } from "./usage";
import {
  createOpenCodeClient,
  OPENCODE_MESSAGE_CAP,
  opencodeError,
  type OpenCodeClient,
  type OpencodeMessageRow,
  type OpencodeSessionRow,
} from "./client";
import type { OpenCodeServiceEndpoint, ServiceDiscovery } from "./service";

/** A session whose row touched the API within this window counts as "producing output right now"
 *  (codex parity — the mtime-freshness analog). The service updates `time.updated` as the agent
 *  works and stops when the session idles or ends, so this is exactly the fresh/stale split that
 *  claims busy/idle/ended. A row also seen in /session/active is alive regardless of freshness —
 *  a freshly pinned session may not have produced tokens yet. */
export const OPENCODE_WORKING_WINDOW_MS = 10_000;

const DEFAULT_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows per list page (the API's own default for a `limit=100` query). */
const SESSION_LIST_LIMIT = 100;

/** Hard cap on rows accumulated across cursor pages in one sweep — a runaway cursor must degrade
 *  to "recent window covered", never hang the poll. Sessions older than the cap read idle/ended;
 *  a working session always has a fresh `time.updated`, so it can't slip past. */
const SESSION_LIST_ROW_CAP = 500;

/** Messages per message-list page. */
const MESSAGE_LIST_LIMIT = 100;

/** The waiting reason A5 assigns at row level: an opencode session signals waiting when its last
 *  message is the assistant's (agent turn complete) and /active no longer owns it — a constant,
 *  generic reason at row level; the transcript read's verbatim reason (if any) rides the doc. */
export const OPENCODE_WAITING_REASON = "Turn complete";

/** In-band reason for the fork op when nothing answered it (no service, unreachable source,
 *  or a non-2xx). Renderer renders it verbatim — handlers never reject (tier-1 cross-cutting). */
export const OPENCODE_FORK_UNAVAILABLE =
  "The OpenCode service did not complete the fork.";

/** Same contract, prompt arm (tier-1 Run 2 / A4): a connect-shaped failure (no service, no
 *  source, unreachable) reads as this; an HTTP-level failure's own reason rides verbatim. */
export const OPENCODE_PROMPT_UNAVAILABLE =
  "The OpenCode service could not be reached to deliver the prompt.";

/** The prompt arm's display reason from a typed client failure: the status/response envelope
 *  carries the service's own words (e.g. `_tag: "InvalidRequestError"`) — pass a trimmed text
 *  through; a connect error collapses to the generic refusal. */
export function promptErrorText(err: unknown): string {
  const apiErr = err as { kind?: string; message?: string } | null;
  if (
    apiErr &&
    typeof apiErr === "object" &&
    typeof apiErr.message === "string" &&
    apiErr.kind !== "connect"
  ) {
    const text = apiErr.message.replace(/^opencode api [a-z]+: /, "").trim();
    if (text !== "") return text;
  }
  return OPENCODE_PROMPT_UNAVAILABLE;
}

/**
 * The optimistic Managed-style draft the fork ipc returns the renderer, built exactly like the
 * spawn/resume drafts (zero-context formatting through hydrate) — but from the fork response ROW
 * so the id, title, tokens, and `fork` provenance are the service's own values (tier-1 Run 2 /
 * A3). A draft carves no cost/context/age from the source. Management stays "observed": no pty
 * was spawned (fork v1 never opens a terminal), so the row reads as every other observed row.
 */
export function opencodeForkDraft(row: OpencodeSessionRow): Session {
  const cwd = row.location?.directory ?? "";
  const project = projectFromCwd(cwd);
  return hydrate({
    id: row.id,
    agent: "opencode",
    title: rowTitleFor(row, project),
    project,
    cwd,
    originCwd: cwd,
    branch: undefined,
    state: "idle",
    management: "observed",
    model: normalizeModelId(rowModelRaw(row)),
    modelRaw: rowModelRaw(row),
    forkSourceId: row.fork?.sessionID,
    lastActivityMs: row.time?.updated ?? Date.now(),
    createdMs: row.time?.created ?? Date.now(),
    awaitingUser: false,
    transcriptMtimeMs: row.time?.updated ?? 0,
    usage: row.tokens ? usageFromRow(row.tokens) : ZERO_USAGE,
    usageByModel: [],
    contextTokens: 0,
  });
}

/** Standalone title resolution the draft builder shares with the provider's sweep closures —
 *  the native title, trimmed and capped; the supplied fallback otherwise. */
export function rowTitleFor(row: OpencodeSessionRow, fallback: string): string {
  const native = row.title?.trim();
  return native ? native.slice(0, MAX_SESSION_TITLE_LEN) : fallback;
}

/** `provider/model` is the honest compound retained id (e.g. "nanhu/GLM-5.3"); the family
 *  overlay normalizes it (no opencode model matches an alias — deliberate). Undefined when the
 *  row's model ref carries no id. */
export function rowModelRaw(
  row: OpencodeSessionRow | null,
): string | undefined {
  const model = row?.model;
  if (!model?.id) return undefined;
  return `${model.providerID ?? ""}/${model.id}`;
}

/** One remote source for this pass: an ensured transport (baseUrl = the tunnel's loopback port
 *  or the profile's directUrl) plus the serve password for the Basic header. */
export interface OpenCodeRemoteSources {
  /** The REMOTE sources the provider should enumerate this pass — upstream (the composition
   *  root via remote-transport) has already resolved tunnels/direct URLs and carries only the
   *  reachable ones; a source that failed its ensure simply doesn't appear. */
  sources(): Promise<RemoteSource[]>;
  /** Remote Managed sessions always run their TUI from the user's HOME (the real directory
   *  lives server-side — OPENCODE_REMOTE_DESIGN.md), so never suggest a remote path as a pty cwd. */
  homeDir: string;
}

export interface OpenCodeProviderDeps {
  /** Base-URL discovery (service.ts). The provider is inert — empty candidate lists, `absent`
   *  reads — while this resolves null (CLI missing, service not running). */
  service: ServiceDiscovery;
  /** Remote serve sources (Pass R). Omitted = local-only (every Pass 1 test path). */
  remote?: OpenCodeRemoteSources;
  /** The bare fetch surface for the API transport — `net.fetch.bind(net)` at the composition
   *  root (Chromium stack: proxy, OS certs), canned responders in tests. */
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  /** Same default as the codex/claude providers; the composition root passes the shared value. */
  recentWindowMs?: number;
  /** The managed registry facade: which ids belong to a live app-spawned pty (a managed opencode
   *  stays alive at its prompt even when row updates go stale), plus the cwd fallback. */
  managed?: {
    has(id: string): boolean;
    cwdOf?(id: string): string | undefined;
  };
}

/** The OpenCode provider plus its overview-time cost overlay (the session row's own $ accounting →
 *  costUsd; the codex analog of the telemetry overlay — see provider/codex/index.ts). */
export interface OpenCodeProvider extends Provider {
  overlaySessions(sessions: Session[]): Session[];
  /** Tier-1 Run 2 / A3: the fork service-op (local + remote-namepaced sources). */
  forkSession: OpenCodeForkSessionArm;
  /** Tier-1 Run 2 / A4: the prompt deliver op (same source routing as the fork arm). */
  promptSession: (sessionId: string, text: string) => Promise<OpenCodeOpResult>;
}

/** Tier-1 Run 2 / A3 + A4: the two service-op arms riding the same client — fail in band
 *  (handlers never reject), so the renderer renders the reason it gets instead of a catch. */
export type OpenCodeOpResult =
  | {
      ok: true;
      /** The optimistic draft main built from the fork response row (A3 only). */
      session?: Session;
    }
  | { ok: false; error: string };

/** Tier-1 Run 2 / A3: opencode's fork arm. Sources: the roster the composite routes by id —
 *  `id` may be a remote namespaced id, resolved per its own swept source. */
export type OpenCodeForkSessionArm = (
  sessionId: string,
) => Promise<OpenCodeOpResult>;

/** v2's message list serves newest-first, cursor pages walk back in time; a walk accumulates
 *  newest→oldest and the transcript wants oldest-first — the single sort below is the turn-around. */
function createdAtOf(message: OpencodeMessage): number {
  const t = asRecord(message)?.time as { created?: unknown } | undefined;
  return typeof t?.created === "number" ? t.created : 0;
}

/**
 * The OpenCode v2 read-side provider. It talks to the local background service's HTTP API — no
 * transcript files exist — so every read arm is an HTTP fetch: listCandidates = bounded list calls,
 * readTranscript = the session's message list → the shared TranscriptDoc, getToolResult = the same
 * list scanned for one tool part (v2 keeps input/output/state on ONE tool part, so no call/output
 * pairing like codex). The change token is the session row's `time.updated` — a non-file-backed
 * provider is free to mint its own (see ReadSettled). Rows are cached from the last sweep;
 * summarize/restate/read arms consult the cache and do a bounded re-list on a miss. Every fetch
 * failure re-discovers (throttled 60s inside the service) and retries once, then degrades per the
 * read arm's contract: inert sweep, `error` for transient reads, `absent` for unknown ids.
 */
export function createOpenCodeProvider(
  deps: OpenCodeProviderDeps,
): OpenCodeProvider {
  const now = deps.now ?? ((): number => Date.now());
  const recentWindowMs = deps.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const managed = deps.managed ?? { has: () => false };

  // One client per base URL; discovery is the slow, rare operation — clients are cheap and swap
  // transparently after re-discovery changes nothing else.
  let client: OpenCodeClient | null = null;
  let clientUrl: string | null = null;
  const clientFor = (endpoint: OpenCodeServiceEndpoint): OpenCodeClient => {
    if (client && clientUrl === endpoint.baseUrl) return client;
    client = createOpenCodeClient({
      baseUrl: endpoint.baseUrl,
      password: endpoint.password,
      fetchFn: deps.fetchFn,
    });
    clientUrl = endpoint.baseUrl;
    return client;
  };

  // Rows from the most recent sweep — summarize/overlay/cwd-resolve's source of truth (id → row).
  const rowCache = new Map<string, OpencodeSessionRow>();

  // The /session/active keys, repopulated by each candidate sweep (shared with
  // resolveResumeTarget so the Resume refusal gate and the displayed state can never disagree
  // about liveness — codex's isFresh sharing rule, generalized to the second liveness signal).
  // LOCAL keys are bare (raw session ids); REMOTE keys are namespaced per server below.
  const activeAlive = new Set<string>();
  const activeRemote = new Map<string, Set<string>>();

  const isRemoteActive = (serverId: string, raw: string): boolean =>
    activeRemote.get(serverId)?.has(raw) ?? false;

  // Which remote servers answered their last sweep — the Resume gate's sync availability hint
  // (the real tunnel/serve gate re-verifies on demand at spawn time; see terminal/ipc.ts).
  const remoteKnown = new Set<string>();

  // Managed-but-not-active rows are sent ONE bounded probe per row version (limit=1 message read)
  // to decide waiting (tier-1 spec Run 2 / A5): the last message being from the assistant means
  // the agent's turn ended and the session now needs the user. Cached by the row's own change
  // token (`time.updated`), so each row version probes once however many passes watch it; a
  // failed probe is never cached — it repeats next pass. Remote rows are never probed (their
  // aliveness comes from the active map / freshness only).
  const lastMessageType = new Map<
    string,
    { updated: number; type: "user" | "assistant" | null }
  >();
  const probeLastMessage = async (
    row: OpencodeSessionRow,
  ): Promise<"user" | "assistant" | null> => {
    const updated = row.time?.updated ?? 0;
    const cached = lastMessageType.get(row.id);
    if (cached && cached.updated === updated) return cached.type;
    const page = await withClientRetry(false, (cl) =>
      cl.listMessages(row.id, 1),
    );
    if (!page) {
      lastMessageType.delete(row.id); // transient failure — never cache, never wedge waiting
      return null;
    }
    const first = page.data[0];
    const type =
      first && (first.type === "user" || first.type === "assistant")
        ? first.type
        : null;
    lastMessageType.set(row.id, { updated, type });
    return type;
  };

  const isRowFresh = (row: OpencodeSessionRow): boolean => {
    const updated = row.time?.updated;
    return (
      updated !== undefined && now() - updated < OPENCODE_WORKING_WINDOW_MS
    );
  };

  // Same signal split as the codex signalsFor, extended with the managed waiting signal
  // (tier-1 spec Run 2 / A5): a row fresh as of swept time is "busy"; a managed row that is
  // neither fresh nor in /active and whose last message is the assistant's is "waiting" —
  // the agent's turn is complete and the session needs its user; deriveSessionState maps
  // alive+busy → working, alive+waiting → waiting, alive → idle, dead → ended.
  const signalsFor = (
    row: OpencodeSessionRow,
    isManaged: boolean,
    remote?: { serverId: string; rawId: string },
  ) => {
    const active = remote
      ? isRemoteActive(remote.serverId, remote.rawId)
      : activeAlive.has(row.id);
    const fresh = isRowFresh(row);
    const waiting =
      isManaged &&
      !active &&
      !fresh &&
      lastMessageType.get(row.id)?.type === "assistant";
    return {
      alive: isManaged || active || fresh,
      status: fresh ? "busy" : waiting ? "waiting" : undefined,
      awaitingUser: waiting,
    };
  };

  /** Run the body against a client, re-discovering once on a typed failure. Returns the body's
   *  value, or the `fallback` when the retry failed too (the caller's degrade contract applies). */
  const withClientRetry = async <T>(
    failNotice: boolean,
    run: (cl: OpenCodeClient) => Promise<T>,
  ): Promise<T | null> => {
    const endpoint = await deps.service.resolve();
    if (!endpoint) return null;
    try {
      return await run(clientFor(endpoint));
    } catch {
      if (!failNotice) return null;
      deps.service.invalidate();
      const retryEndpoint = await deps.service.resolve();
      if (!retryEndpoint) return null;
      try {
        return await run(clientFor(retryEndpoint));
      } catch {
        return null;
      }
    }
  };

  /** One bounded cursor walk over the session list, newest first, stopping at the recent-window
   *  horizon. Rows land into rowCache (the sweep IS the cache fill). Null → inert pass. */
  const sweepRows = async (): Promise<OpencodeSessionRow[] | null> => {
    const rows = await withClientRetry(true, async (cl) => {
      const all: OpencodeSessionRow[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await cl.listSessions(SESSION_LIST_LIMIT, cursor);
        all.push(...page.data);
        const oldest = all[all.length - 1]?.time?.updated;
        if (
          !page.cursor?.next ||
          all.length >= SESSION_LIST_ROW_CAP ||
          (oldest !== undefined && now() - oldest > recentWindowMs)
        )
          break;
        cursor = page.cursor.next;
      }
      return all;
    });
    if (rows) {
      rowCache.clear();
      for (const row of rows) rowCache.set(row.id, row);
    }
    return rows;
  };

  /** Row for id from the sweep cache; on a miss, a bounded re-list (which refills the cache) and
   *  a second look — for a remote id, the re-list rides that id's own source. Null when the API
   *  doesn't know the id (or the source is unreachable this pass). */
  const rowFor = async (id: string): Promise<OpencodeSessionRow | null> => {
    const cached = rowCache.get(id);
    if (cached) return cached;
    const ns = parseNamespacedId(id);
    if (ns) {
      const source = remoteState.get(ns.serverId);
      if (source) {
        await sweepSource(source);
        return rowCache.get(id) ?? null;
      }
      return null; // the server went away between sweeps — absent, not a local re-list
    }
    await sweepRows();
    return rowCache.get(id) ?? null;
  };

  /** All messages for one session, oldest-first. Null after retries exhausted (transient). */
  const messagesFor = async (id: string): Promise<OpencodeMessage[] | null> => {
    const ns = parseNamespacedId(id);
    if (ns) {
      const source = remoteState.get(ns.serverId);
      if (!source) return null; // source unreachable/unresolved — the read degrades, not rethrown
      try {
        const client = createOpenCodeClient({
          baseUrl: source.baseUrl,
          password: source.password,
          fetchFn: deps.fetchFn,
        });
        const all: OpencodeMessageRow[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await client.listMessages(
            ns.raw,
            MESSAGE_LIST_LIMIT,
            cursor,
          );
          all.push(...page.data);
          if (!page.cursor?.next || all.length >= OPENCODE_MESSAGE_CAP) break;
          cursor = page.cursor.next;
        }
        return all
          .map((m) => m as unknown as OpencodeMessage)
          .sort((a, b) => createdAtOf(a) - createdAtOf(b));
      } catch {
        return null; // transient per the read-arm contract (keep the last value, retry)
      }
    }
    const rows = await withClientRetry(
      true,
      async (cl): Promise<OpencodeMessage[]> => {
        const all: OpencodeMessageRow[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await cl.listMessages(id, MESSAGE_LIST_LIMIT, cursor);
          all.push(...page.data);
          if (!page.cursor?.next || all.length >= OPENCODE_MESSAGE_CAP) break;
          cursor = page.cursor.next;
        }
        // The client rows are the same record the parser reads defensively (asRecord); the cast is
        // the typed rows → loose-record handoff, not a shape cheat.
        return all
          .map((m) => m as unknown as OpencodeMessage)
          .sort((a, b) => createdAtOf(a) - createdAtOf(b));
      },
    );
    return rows;
  };

  // Message rows per session from the last transcript read — getToolResult/readMetrics's source
  // when the.messages are already in hand. Codex's head/telemetry caches play this role for files.
  const messagesCache = new Map<string, OpencodeMessage[]>();

  // ── Pass R: remote sources ────────────────────────────────────────────────────────────────
  // serverId → its last-ensured source (base/password). Refreshed every candidate sweep; reads
  // between sweeps use the last-known client — a stale tunnel URL fails a read with `error`
  // (transient contract) and the next sweep re-resolves. Never holds secrets in logs.
  const remoteState = new Map<string, RemoteSource>();

  /** One bounded sweep for ONE remote source: rows namespace into the shared rowCache, active ids
   *  namespace into activeRemote, candidates come back namespaced. A fetch failure just yields
   *  no rows this sweep (the source drops out of sources() upstream anyway). */
  const sweepSource = async (
    source: RemoteSource,
  ): Promise<SessionCandidate[]> => {
    remoteState.set(source.serverId, source);
    remoteKnown.add(source.serverId);
    if (!activeRemote.has(source.serverId))
      activeRemote.set(source.serverId, new Set());
    const actives = activeRemote.get(source.serverId)!;
    actives.clear();
    try {
      const client = createOpenCodeClient({
        baseUrl: source.baseUrl,
        password: source.password,
        fetchFn: deps.fetchFn,
      });
      const all: OpencodeSessionRow[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await client.listSessions(SESSION_LIST_LIMIT, cursor);
        all.push(...page.data);
        const oldest = all[all.length - 1]?.time?.updated;
        if (
          !page.cursor?.next ||
          all.length >= SESSION_LIST_ROW_CAP ||
          (oldest !== undefined && now() - oldest > recentWindowMs)
        )
          break;
        cursor = page.cursor.next;
      }
      const active = await client.listActive();
      for (const raw of Object.keys(active)) actives.add(raw);
      const cutoff = now() - recentWindowMs;
      const out: SessionCandidate[] = [];
      for (const row of all) {
        if (row.parentID) continue; // subagent lanes stay Pass 2+, as on the local side
        const appId = namespacedId(source.serverId, row.id);
        if ((row.time?.updated ?? 0) < cutoff && !managed.has(appId)) continue;
        const sig = signalsFor(row, managed.has(appId), {
          serverId: source.serverId,
          rawId: row.id,
        });
        rowCache.set(appId, row);
        out.push({
          id: appId,
          agent: "opencode",
          alive: sig.alive,
          status: sig.status,
          // The server-side cwd, verbatim — the remote project IS a project (design doc); no
          // local path assumption is layered on (the sidebar reads it as a label).
          cwd: row.location?.directory ?? "",
          transcriptPath: undefined,
          transcriptMtimeMs: row.time?.updated ?? 0,
          updatedAt: row.time?.updated ?? row.time?.created ?? 0,
        });
      }
      return out;
    } catch {
      return []; // source offline this sweep — its candidates simply don't appear
    }
  };

  /** Sweep every configured remote source in parallel; fills the ns caches and returns their
   *  candidates. Inert when the composition root wired no remote side. */
  const sweepRemotes = async (): Promise<SessionCandidate[]> => {
    if (!deps.remote) return [];
    const sources = await deps.remote.sources().catch(() => []);
    if (sources.length === 0) return [];
    return (await Promise.all(sources.map((s) => sweepSource(s)))).flat();
  };

  const titleFor = (
    row: OpencodeSessionRow | null,
    fallback: string,
  ): string => {
    const native = row?.title?.trim();
    return native ? native.slice(0, MAX_SESSION_TITLE_LEN) : fallback;
  };

  /** Tier-1 Run 2 / A3: fork through the service — local source or its own remote source (the
   *  id's namespace picks). Returns the NEW raw session row; the draft session it turns into is
   *  `opencodeForkDraft`. Null = the op is unavailable (no service/source, or the service said
   *  no) — the ipc handler degrades that into an in-band error, never a rejection. */
  const forkRowFor = async (id: string): Promise<OpencodeSessionRow | null> => {
    const ns = parseNamespacedId(id);
    if (ns) {
      const source = remoteState.get(ns.serverId);
      if (!source) return null; // source gone between sweeps — in-band failure, no throw
      try {
        const client = createOpenCodeClient({
          baseUrl: source.baseUrl,
          password: source.password,
          fetchFn: deps.fetchFn,
        });
        return await client.forkSession(ns.raw);
      } catch {
        return null;
      }
    }
    return await withClientRetry(true, (cl) => cl.forkSession(id));
  };

  const forkSession: OpenCodeForkSessionArm = async (sessionId) => {
    const row = await forkRowFor(sessionId);
    if (!row)
      return {
        ok: false,
        error: OPENCODE_FORK_UNAVAILABLE,
      };
    return { ok: true, session: opencodeForkDraft(row) };
  };

  /** Tier-1 Run 2 / A4: deliver one prompt to a session — the same per-id source routing as the
   *  fork arm (namespaced remote ids ride their own swept source). The typed client failure is
   *  turned into a display-grade reason; a service probe failure reads as the generic refusal,
   *  an HTTP 400's reason text rides verbatim. */
  /** The prompt arm's local-path delivery, mirroring withClientRetry's re-discovery contract but
   *  RETHROWING the typed failure (the caller turns it into the in-band reason — a 400's status
   *  failure carries the server's own words, which the generic null-collapse would erase). */
  const sendPromptWithReDiscovery = async (
    sessionId: string,
    text: string,
  ): Promise<{ ok: true }> => {
    const endpoint = await deps.service.resolve();
    if (!endpoint) throw opencodeError("connect", "the service is not running");
    try {
      await clientFor(endpoint).promptSession(sessionId, text);
      return { ok: true };
    } catch (err) {
      deps.service.invalidate();
      const retryEndpoint = await deps.service.resolve();
      if (!retryEndpoint) throw err;
      await clientFor(retryEndpoint).promptSession(sessionId, text);
      return { ok: true };
    }
  };

  const promptSession = async (
    sessionId: string,
    text: string,
  ): Promise<OpenCodeOpResult> => {
    // Same per-id source routing as the fork arm; the typed client failure becomes a
    // display-grade reason (a connect failure reads as the generic refusal, an HTTP 400's
    // server reason rides the result verbatim). Never rejects.
    try {
      const ns = parseNamespacedId(sessionId);
      if (ns) {
        const source = remoteState.get(ns.serverId);
        if (!source) return { ok: false, error: OPENCODE_PROMPT_UNAVAILABLE };
        const client = createOpenCodeClient({
          baseUrl: source.baseUrl,
          password: source.password,
          fetchFn: deps.fetchFn,
        });
        await client.promptSession(ns.raw, text);
        return { ok: true };
      }
      const sent = await sendPromptWithReDiscovery(sessionId, text);
      return sent;
    } catch (err) {
      return { ok: false, error: promptErrorText(err) };
    }
  };

  const modelRawFor = rowModelRaw;

  const summarizeRow = async (
    candidate: SessionCandidate,
  ): Promise<PersistedSession> => {
    const row = await rowFor(candidate.id);
    const cwd = row?.location?.directory ?? candidate.cwd ?? "";
    const fallbackName = projectFromCwd(cwd);
    const modelRaw = modelRawFor(row);
    const updated = row?.time?.updated ?? candidate.transcriptMtimeMs;
    return {
      id: candidate.id,
      agent: "opencode",
      title: titleFor(row, fallbackName),
      project: fallbackName,
      cwd,
      // The row's location is where the session started and stays for its lifetime (the API
      // doesn't update it after `cd`), so live and frozen cwd coincide — codex's originCwd parity.
      originCwd: cwd,
      branch: undefined,
      state: deriveSessionState({
        alive: candidate.alive,
        status: candidate.status,
        awaitingUser: candidate.status === "waiting",
      }),
      // The A5 waiting signal's reason: a session signaling waiting finished its agent turn —
      // "Turn complete". Everything else carries no row-level reason (the transcript read that
      // computes the verbatim one is on-demand, never a rail poll).
      waitingReason:
        candidate.status === "waiting" ? OPENCODE_WAITING_REASON : undefined,
      management: managed.has(candidate.id) ? "managed" : "observed",
      model: normalizeModelId(modelRaw),
      modelRaw,
      lastActivityMs: updated || 0,
      createdMs: row?.time?.created ?? candidate.updatedAt ?? 0,
      awaitingUser: candidate.status === "waiting",
      // Tier-1 Run 2 / A3: fork provenance rides the row (the fork field the service minted
      // with), so the rail's fork badge survives draft supersede.
      forkSourceId: row?.fork?.sessionID,
      transcriptMtimeMs: candidate.transcriptMtimeMs,
      usage: row?.tokens ? usageFromRow(row.tokens) : ZERO_USAGE,
      usageByModel: [], // per-model attribution needs the message's own modelID — Pass 2
      // The prompt-size context split lives in the transcript doc (readTranscript's context), not
      // the row — so the persisted contextTokens stays 0 unless a read fills it.
      contextTokens: 0,
      effortLevel: undefined,
      compactionCount: undefined,
    };
  };

  return {
    id: "opencode",
    listCandidates: async (): Promise<SessionCandidate[]> => {
      // The active map rides the same sweep, before the filter, so liveness covers every row this
      // pass evaluates — signalsFor and the Resume gate read the same set. Remote sources sweep
      // in the same pass (each ensures its own transport upstream); a failed source yields no rows.
      const [rows, active, remoteCands] = await Promise.all([
        sweepRows(),
        withClientRetry(false, (cl) => cl.listActive()),
        sweepRemotes(),
      ]);
      activeAlive.clear();
      if (active) for (const key of Object.keys(active)) activeAlive.add(key);
      const cutoff = now() - recentWindowMs;
      const out: SessionCandidate[] = [];
      for (const row of rows ?? []) {
        // Child (subagent) thread rows — subagent lanes are Pass 2 (see client.ts note). A child
        // of a tracked session must not become a second sidebar row.
        if (row.parentID) continue;
        if ((row.time?.updated ?? 0) < cutoff && !managed.has(row.id)) continue;
        // The waiting probes are bounded: a managed row past its freshness window that /active
        // doesn't own is the only shape the probe decides for — at most one last-message read per
        // unchanged row version, per the cache.
        const isManaged = managed.has(row.id);
        if (isManaged && !activeAlive.has(row.id) && !isRowFresh(row))
          await probeLastMessage(row);
        const sig = signalsFor(row, isManaged);
        out.push({
          id: row.id,
          agent: "opencode",
          alive: sig.alive,
          status: sig.status,
          cwd: row.location?.directory ?? "",
          transcriptPath: undefined,
          transcriptMtimeMs: row.time?.updated ?? 0,
          updatedAt: row.time?.updated ?? row.time?.created ?? 0,
        });
      }
      // The remote arms' candidates merge with the local service's here — the rail reads one
      // flat candidate list and knows nothing about which source produced a row.
      return out.concat(remoteCands);
    },
    summarize: summarizeRow,
    restate: (c, prev) => {
      // Titling rest is synchronous in codex. Here it goes to an (asynchronous-restated) message
      // title from rowCache only — no fetch in the hot path. The row's own restate refreshes
      // state/management, which is what survives a re-render.
      const row = rowCache.get(c.id) ?? null;
      return {
        ...prev,
        title: titleFor(row, prev.project),
        management: managed.has(c.id) ? "managed" : "observed",
        state: deriveSessionState({
          alive: c.alive,
          status: c.status,
          awaitingUser: c.status === "waiting",
        }),
      };
    },
    readTranscript: async (id, sinceMtimeMs): Promise<TranscriptReadWire> => {
      const row = await rowFor(id);
      if (!row) {
        // Not in the API: never was, or deleted while the app was closed — settle `absent`, not
        // `error`: `error` means transient (keep the last doc); a deleted session must empty out.
        return { status: "absent" };
      }
      const token = row.time?.updated ?? 0;
      if (sinceMtimeMs !== undefined && sinceMtimeMs === token)
        return { status: "unchanged", mtimeMs: token };
      // Stale-token caveat accepted and documented (spec): the token is the row's `time.updated`
      // from the last sweep, so transcript freshness tracks sweep cadence, not second-by-second.
      const messages = await messagesFor(id);
      if (!messages) return { status: "error" }; // transient service/read failure — keep the last
      messagesCache.set(id, messages);
      return toTranscriptWire({
        status: "changed",
        mtimeMs: token,
        doc: { ...buildTranscriptDoc(messages), subagents: [] },
      });
    },
    getToolResult: async (id, toolUseId): Promise<ToolResultDetail> => {
      const cached = messagesCache.get(id);
      const messages =
        cached && cached.length > 0 ? cached : await messagesFor(id);
      if (messages) messagesCache.set(id, messages);
      if (!messages || messages.length === 0) return { found: false };
      return extractToolResult(messages, toolUseId);
    },
    readMetrics: async (id, sinceMtimeMs) => {
      const row = await rowFor(id);
      if (!row) return { status: "absent" };
      // Remote sessions carry a SERVER-side path that local git cannot see — their metric is the
      // token-speed arm only (design doc + spec). The null git/pr guarantees the merge skips gh.
      const isRemote = parseNamespacedId(id) !== null;
      const cwd = isRemote ? "" : (row.location?.directory ?? "");
      const git = cwd ? readGit(cwd) : null;
      // Same skip rule as codex's readMetrics: no browsable remote → no gh spawn.
      const pr = cwd && git && git.remoteUrl ? readPr(cwd, git.branch) : null;
      // Same composite change token as every provider (mtime + git/pr/voice/remote), over the
      // row's time.updated in place of a transcript mtime.
      const token = metricsToken(row.time?.updated ?? 0, {
        git,
        pr,
        voice: null,
        remote: null,
      });
      if (sinceMtimeMs !== undefined && sinceMtimeMs === token)
        return { status: "unchanged", mtimeMs: token };
      const cachedMessages = messagesCache.get(id);
      const messages =
        cachedMessages && cachedMessages.length > 0
          ? cachedMessages
          : await messagesFor(id);
      if (messages) messagesCache.set(id, messages);
      return {
        status: "changed",
        mtimeMs: token,
        metrics: {
          tokenSpeed: messages
            ? speedFromMessages(messages, SPEED_WINDOW_MS)
            : null,
          git,
          pr,
          voiceEnabled: null,
          remoteControl: null,
        },
      };
    },
    resolveResumeTarget: (id) => {
      const ns = parseNamespacedId(id);
      if (ns) {
        // Remote Managed session: the TUI runs from HOME (never a remote path — OPENCODE_REMOTE_
        // DESIGN.md), and the real gate (tunnel + serve) re-verifies on demand in the resume
        // flow. Availability here = the server answered a sweep at least once.
        if (!remoteKnown.has(ns.serverId)) return null;
        return { alive: true, cwd: deps.remote?.homeDir ?? "" };
      }
      const row = rowCache.get(id);
      if (!row) return null;
      const cwd = row.location?.directory;
      if (!cwd) return null;
      // Alive = the pty owns it, it was seen in /session/active, or it's mtime-fresh — the exact
      // same signals signalsFor paints "working" with (claude's registry-pid analog).
      const updated = row.time?.updated;
      return {
        alive:
          managed.has(id) ||
          activeAlive.has(id) ||
          (updated !== undefined &&
            now() - updated < OPENCODE_WORKING_WINDOW_MS),
        cwd,
      };
    },
    resolveSessionCwd: (id) =>
      rowCache.get(id)?.location?.directory ?? managed.cwdOf?.(id) ?? null,
    // No file — the source is the service's own storage; diagnostics carry that shape instead.
    resolveTranscriptPath: () => null,
    // Still capability-gated off (hasSubagents/hasActivity false): the read arms settle absent
    // cheaply if a poll slips through, exactly like the codex stubs above.
    readSubagentTranscript: () => ({ status: "absent" }),
    readTasks: () => ({ status: "absent" }),
    readShells: () => ({ status: "absent" }),
    readShellOutput: () => ({ status: "absent" }),
    readMonitors: () => ({ status: "absent" }),
    readMonitorOutput: () => ({ status: "absent" }),
    // Static cost overlay at overview time (the Spend panel's $): the row's own accounting,
    // attached exactly like the codex overlay's context fields. Non-opencode rows pass untouched.
    overlaySessions: (sessions: Session[]): Session[] =>
      sessions.map((s) => {
        if (s.agent !== "opencode") return s;
        const cost = rowCache.get(s.id)?.cost;
        if (
          typeof cost !== "number" ||
          !Number.isFinite(cost) ||
          s.costUsd === cost
        )
          return s;
        return { ...s, costUsd: cost };
      }),
    // Tier-1 Run 2 / A3 + A4: the fork and prompt service-ops over the local service or the
    // id's own remote source.
    forkSession,
    promptSession,
  };
}
