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
import { readGit } from "../../git/read-git";
import { readPr } from "../../git/read-pr";
import { MAX_SESSION_TITLE_LEN } from "@shared/title-override";
import { asRecord } from "../codex/rollout";
import { buildTranscriptDoc, type OpencodeMessage } from "./transcript-events";
import { extractToolResult } from "./tool-result";
import { speedFromMessages, usageFromRow, ZERO_USAGE } from "./usage";
import {
  createOpenCodeClient,
  OPENCODE_MESSAGE_CAP,
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

export interface OpenCodeProviderDeps {
  /** Base-URL discovery (service.ts). The provider is inert — empty candidate lists, `absent`
   *  reads — while this resolves null (CLI missing, service not running). */
  service: ServiceDiscovery;
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
}

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
  const activeAlive = new Set<string>();

  // Same signal split as the codex signalsFor: a row fresh as of swept time is "busy";
  // deriveSessionState maps alive+busy → working, alive → idle, dead → ended.
  const signalsFor = (row: OpencodeSessionRow, isManaged: boolean) => {
    const updated = row.time?.updated;
    const fresh =
      updated !== undefined && now() - updated < OPENCODE_WORKING_WINDOW_MS;
    return {
      alive: isManaged || activeAlive.has(row.id) || fresh,
      status: fresh ? "busy" : undefined,
      awaitingUser: false,
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
   *  a second look. Null when the API doesn't know the id. */
  const rowFor = async (id: string): Promise<OpencodeSessionRow | null> => {
    const cached = rowCache.get(id);
    if (cached) return cached;
    await sweepRows();
    return rowCache.get(id) ?? null;
  };

  /** All messages for one session, oldest-first. Null after retries exhausted (transient). */
  const messagesFor = async (id: string): Promise<OpencodeMessage[] | null> => {
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

  const titleFor = (
    row: OpencodeSessionRow | null,
    fallback: string,
  ): string => {
    const native = row?.title?.trim();
    return native ? native.slice(0, MAX_SESSION_TITLE_LEN) : fallback;
  };

  const modelRawFor = (row: OpencodeSessionRow | null): string | undefined => {
    const model = row?.model;
    if (!model?.id) return undefined;
    // `provider/model` is the honest compound retained id (e.g. "nanhu/GLM-5.3"); the family
    // overlay normalizes it (no opencode model matches an alias — deliberate).
    return `${model.providerID ?? ""}/${model.id}`;
  };

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
        awaitingUser: false,
      }),
      management: managed.has(candidate.id) ? "managed" : "observed",
      model: normalizeModelId(modelRaw),
      modelRaw,
      lastActivityMs: updated || 0,
      createdMs: row?.time?.created ?? candidate.updatedAt ?? 0,
      awaitingUser: false,
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
      // pass evaluates — signalsFor and the Resume gate read the same set.
      const [rows, active] = await Promise.all([
        sweepRows(),
        withClientRetry(false, (cl) => cl.listActive()),
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
        const sig = signalsFor(row, managed.has(row.id));
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
      return out;
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
          awaitingUser: false,
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
      const cwd = row.location?.directory ?? "";
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
  };
}
