import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTextOrNull } from "../claude-config";
import type { ServerProfile, ServerProfileInput } from "@shared/servers";

/** The profile registry's versioned on-disk schema (servers.json in userData). Credentials live in
 *  the SEPARATE credentials file (see credentials.ts) — this file must never carry secret material
 *  so nothing reads it for a reason other than the card. */
export interface ServersFile {
  version: 1;
  servers: ServerProfile[];
}
export const SERVERS_FILE_VERSION = 1;

/** Tolerant fs seam: the default is the real thing; tests hand over an in-memory map. */
export interface ServersFs {
  read(path: string): string | null;
  write(path: string, content: string): void;
}

const realFs: ServersFs = {
  read: (path) => readTextOrNull(path),
  write: (path, content) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  },
};

export interface ServerProfileStoreDeps {
  dir: string;
  now?: () => number;
  fs?: ServersFs;
}

/** Validation: name/host/username non-empty, port an integer in range, authMode exercises only the
 *  fields its mode uses (keyPath required for key mode). Returns the first problem or null. */
export function validateProfileInput(input: ServerProfileInput): string | null {
  if (typeof input.name !== "string" || !input.name.trim())
    return "Name is required.";
  if (typeof input.host !== "string" || !input.host.trim())
    return "Host is required.";
  if (typeof input.username !== "string" || !input.username.trim())
    return "Username is required.";
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
    return "Port must be an integer between 1 and 65535.";
  if (
    input.authMode !== "password" &&
    input.authMode !== "key" &&
    input.authMode !== "agent"
  )
    return "Auth mode must be password, key, or agent.";
  if (
    input.authMode === "key" &&
    (typeof input.keyPath !== "string" || !input.keyPath.trim())
  )
    return "A key path is required for key auth.";
  return null;
}

/** Mint a profile id: nanoid-style short opaque token, namespaced so diagnostics can tell where an
 *  id came from. randomUUID would work, but the short form fits a `profileId` column in dialogs. */
export function mintServerId(): string {
  return `srv-${randomBytes(8).toString("base64url")}`;
}

export interface ServerProfileStore {
  list(): ServerProfile[];
  save(
    input: ServerProfileInput,
  ): { ok: true; profile: ServerProfile } | { ok: false; error: string };
  remove(id: string): boolean;
  /** Stamp a successful handshake, raised by the connection manager (persisted server-side). */
  setLastConnected(id: string, atMs: number): void;
  /** The bare file path — the databases-style location readout. */
  path(): string;
}

export function createServerProfileStore(
  deps: ServerProfileStoreDeps,
): ServerProfileStore {
  const fs = deps.fs ?? realFs;
  const file = join(deps.dir, "servers.json");
  const now = deps.now ?? ((): number => Date.now());

  function read(): ServersFile {
    const raw = fs.read(file);
    if (raw === null) return { version: SERVERS_FILE_VERSION, servers: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { version: SERVERS_FILE_VERSION, servers: [] }; // corrupt → empty, app-settings' rule
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { version: SERVERS_FILE_VERSION, servers: [] };
    }
    // Tolerant schema: unknown extra fields dropped on write; missing fields caught by validation
    // at use time (every dial validates its own fields again — the file is not trusted).
    const servers = Array.isArray((parsed as Record<string, unknown>).servers)
      ? ((parsed as { servers: unknown[] }).servers as ServerProfile[])
      : [];
    return {
      version: SERVERS_FILE_VERSION,
      servers: Array.isArray(servers)
        ? servers.filter((s) => s && typeof s.id === "string")
        : [],
    };
  }

  function write(next: ServersFile): void {
    fs.write(file, `${JSON.stringify(next, null, 2)}\n`);
  }

  return {
    list: () => read().servers,
    save(input) {
      const invalid = validateProfileInput(input);
      if (invalid) return { ok: false, error: invalid };
      const store = read();
      const trimmedKeyPath =
        typeof input.keyPath === "string" && input.keyPath.trim()
          ? input.keyPath.trim()
          : undefined;
      const base = {
        name: input.name.trim(),
        group: typeof input.group === "string" ? input.group.trim() : "",
        host: input.host.trim(),
        port: input.port,
        username: input.username.trim(),
        authMode: input.authMode,
        // keyPath is allowed ONLY in key mode — a mode switch away would otherwise leave a stale
        // path pointing at a file the profile no longer reads.
        keyPath: input.authMode === "key" ? trimmedKeyPath : undefined,
      };
      const existing = input.id
        ? store.servers.find((p) => p.id === input.id)
        : undefined;
      if (existing) {
        // Update preserves identity and lifecycle stamps; the form never carries them.
        const updated: ServerProfile = {
          ...existing,
          ...base,
        };
        write({
          version: SERVERS_FILE_VERSION,
          servers: store.servers.map((p) =>
            p.id === updated.id ? updated : p,
          ),
        });
        return { ok: true, profile: updated };
      }
      const created: ServerProfile = {
        ...base,
        id: mintServerId(),
        createdAtMs: now(),
      };
      write({
        version: SERVERS_FILE_VERSION,
        servers: [...store.servers, created],
      });
      return { ok: true, profile: created };
    },
    remove(id) {
      const store = read();
      const before = store.servers.length;
      const after = store.servers.filter((p) => p.id !== id);
      if (after.length === before) return false; // unknown id — nothing to do
      write({ version: SERVERS_FILE_VERSION, servers: after });
      return true;
    },
    setLastConnected(id, atMs) {
      const store = read();
      if (!store.servers.some((p) => p.id === id)) return;
      write({
        version: SERVERS_FILE_VERSION,
        servers: store.servers.map((p) =>
          p.id === id ? { ...p, lastConnectedMs: atMs } : p,
        ),
      });
    },
    path: () => file,
  };
}
