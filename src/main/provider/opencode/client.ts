import { asRecord } from "../codex/rollout";

/** The typed, thin fetch layer over the v2 background service API. Injectable fetchFn (the
 *  composition root passes `net.fetch.bind(net)` — Chromium's stack) so tests hand over canned
 *  responses and main gets Electron's proxy/cert handling for free. Every request is bounded by a
 *  2s timeout: a wedged service must fail a poll, not stall it. Failures throw the typed
 *  `OpenCodeApiError` (HTTP-shape failures carry the status) — the provider catches them and
 *  degrades per the read arm's contract (empty sweep / error read), never crash-polling. */

/** Per-request bound. A local service answers in single-digit ms; 2s covers a cold warp-away. */
export const OPENCODE_REQUEST_TIMEOUT_MS = 2_000;

export interface OpenCodeApiError extends Error {
  kind: "connect" | "status" | "response";
  status?: number;
}

/** Insert the fields YOUR call site reads; everything else is tolerated as absent on the wire —
 *  v2 is young and the API reference (OPENCODE_PROVIDER_SPEC.md) lists more than any one row
 *  populated. Shape verified live on v2.0.28. */
export interface OpencodeModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface OpencodeSessionRow {
  id: string;
  /** Set on a subagent / child thread's own row (verified live) — those lanes are Pass 2+: pass-1
   *  enumeration SKIPS rows carrying one (a child of a tracked session must not become a second
   *  sidebar row). */
  parentID?: string;
  title?: string;
  agent?: string;
  model?: OpencodeModelRef | null;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  } | null;
  outcome?: string;
  time?: {
    created?: number;
    updated?: number;
    idle?: number;
    viewed?: number;
  } | null;
  location?: { directory?: string } | null;
}

/** GET /api/session/active → a map keyed by session id (only running rows so far). */
export type OpencodeActiveMap = Record<string, unknown>;

export interface OpencodeMessageRow {
  id: string;
  type: string;
  time?: { created?: number; streamed?: number; completed?: number } | null;
  content?: Array<Record<string, unknown>> | null;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  } | null;
  cost?: number;
  modelID?: string;
  providerID?: string;
}

export interface Paged<T> {
  data: T[];
  cursor: { previous?: string; next?: string } | null;
}

export interface OpenCodeClient {
  /** `GET /api/session?limit=&order=desc` — newest-first rows, cursor-paginated. */
  listSessions(
    limit: number,
    cursor?: string,
  ): Promise<Paged<OpencodeSessionRow>>;
  /** `GET /api/session/active` — the map's keys are running session ids. */
  listActive(): Promise<OpencodeActiveMap>;
  /** `GET /api/session/{id}/message` — newest-first message rows, cursor-paginated. */
  listMessages(
    sessionId: string,
    limit: number,
    cursor?: string,
  ): Promise<Paged<OpencodeMessageRow>>;
}

/** Typed error so call sites branch on failure KIND, not message text: `connect` (ECONNREFUSED /
 *  DNS / timeout — the trigger for service re-discovery), `status` (non-2xx), `response` (a 2xx
 *  whose body isn't the envelope — a torn/HTML response). */
export function opencodeError(
  kind: OpenCodeApiError["kind"],
  message: string,
  status?: number,
): OpenCodeApiError {
  const err: OpenCodeApiError = Object.assign(
    new Error(`opencode api ${kind}: ${message}`),
    { kind, ...(status !== undefined ? { status } : {}) },
  );
  return err;
}

/** Message pagination hard cap — an enormous history reads pages until here; transcripts past it
 *  simply show the most recent 3000 messages (the codex/claude readers' tail-window philosophy). */
export const OPENCODE_MESSAGE_CAP = 3000;

function authHeader(
  password: string | null,
): Record<string, string> | undefined {
  if (!password) return undefined;
  // The v2 service authenticates requests with HTTP Basic over the service.json password
  // (verified live: Bearer and password headers both 401, Basic 200). Username constant — the
  // service reads the password, not the user.
  const token = Buffer.from(`opencode:${password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

export interface OpenCodeClientDeps {
  baseUrl: string;
  password?: string | null;
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

export function createOpenCodeClient(deps: OpenCodeClientDeps): OpenCodeClient {
  const fetchFn = deps.fetchFn;
  const base = deps.baseUrl;
  const password = deps.password ?? null;

  const json = async (path: string): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        headers: {
          Accept: "application/json",
          ...authHeader(password),
        },
        signal: AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw opencodeError(
        "connect",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!res.ok)
      throw opencodeError(
        "status",
        `unexpected HTTP ${res.status}`,
        res.status,
      );
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw opencodeError(
        "response",
        err instanceof Error ? err.message : String(err),
        res.status,
      );
    }
    const r = asRecord(body);
    if (!r)
      throw opencodeError("response", "body is not a JSON object", res.status);
    return r;
  };

  return {
    async listSessions(limit: number, cursor?: string) {
      const params = new URLSearchParams({
        limit: String(limit),
        order: "desc",
      });
      if (cursor) params.set("cursor", cursor);
      const r = await json(`/api/session?${params}`);
      if (!Array.isArray(r.data))
        throw opencodeError("response", "session list has no data array");
      return {
        data: r.data as OpencodeSessionRow[],
        cursor: asCursor(r.cursor),
      };
    },
    async listActive() {
      const r = await json("/api/session/active");
      if (!r.data || typeof r.data !== "object")
        throw opencodeError("response", "active map has no data object");
      return r.data as OpencodeActiveMap;
    },
    async listMessages(sessionId: string, limit: number, cursor?: string) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set("cursor", cursor);
      const r = await json(
        `/api/session/${encodeURIComponent(sessionId)}/message?${params}`,
      );
      if (!Array.isArray(r.data))
        throw opencodeError("response", "message list has no data array");
      return {
        data: r.data as OpencodeMessageRow[],
        cursor: asCursor(r.cursor),
      };
    },
  };
}

function asCursor(v: unknown): Paged<unknown>["cursor"] {
  const r = asRecord(v);
  if (!r) return null;
  const out: { previous?: string; next?: string } = {};
  if (typeof r.previous === "string") out.previous = r.previous;
  if (typeof r.next === "string") out.next = r.next;
  return out;
}
