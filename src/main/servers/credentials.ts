import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { ServerCredentialsInput } from "@shared/servers";
import { readTextOrNull } from "../claude-config";
import type { ServersFs } from "./profiles";

/** The seam Electron's safeStorage is injected through — tests mock it with reversible base64 so
 *  the shipping path (safeStorage buffers, base64 in JSON) is exercised end-to-end without Electron.
 *  Matches only the three members this module touches. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** One profile's decrypted secret triple (never rendered anywhere — S1 hands password/passphrase
 *  straight to ssh2, Pass R hands the serve password to its fetch layer and the spawn env). A
 *  triple with all members absent reads as null ("credential missing"). */
export interface ServerCredentials {
  password?: string;
  passphrase?: string;
  /** The remote `opencode serve` password (Pass R) — the Basic auth half for the tunnel-following
   *  client and the OPENCODE_PASSWORD env of every managed remote spawn. */
  opencodePassword?: string;
}

export type CredentialSetResult = { ok: true } | { ok: false; error: string };

export interface ServerCredentialStore {
  /** The decrypted pair for id, or null — absent file, absent entry, corrupt blob, or a safeStorage
   *  that lost its OS key. "Credential missing", never a crash. */
  get(id: string): ServerCredentials | null;
  set(id: string, value: ServerCredentialsInput): CredentialSetResult;
  remove(id: string): void;
  path(): string;
}

export interface ServerCredentialStoreDeps {
  dir: string;
  safeStorage: SafeStorageLike;
  /** Same tolerant fs seam profiles.ts uses; tests hand over an in-memory map. */
  fs?: ServersFs;
}

/** The on-device credential file (servers-credentials.json, sibling to servers.json): profile id →
 *  safeStorage-encrypted blobs, stored as base64 in a versioned envelope. A rewrite carries every
 *  OTHER profile's entries intact, so saving one never drops the user's saved secrets. */
export function createServerCredentialStore(
  deps: ServerCredentialStoreDeps,
): ServerCredentialStore {
  const fs = deps.fs ?? {
    read: (path) => readTextOrNull(path),
    write: (path, content) => {
      writeFileSync(path, content);
    },
  };
  const file = join(deps.dir, "servers-credentials.json");

  interface Entry {
    v: 1;
    /** base64(safeStorage.encryptString(value)). */
    password?: string;
    /** base64(safeStorage.encryptString(value)). */
    passphrase?: string;
    /** base64(safeStorage.encryptString(value)) — the remote opencode serve password (Pass R). */
    opencodePassword?: string;
  }

  function read(): Record<string, Entry> {
    const raw = fs.read(file);
    if (raw === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {}; // corrupt file: "no credentials", never a crash
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // Keep only shape-valid entries; malformed rows are skipped, not fatal.
    const out: Record<string, Entry> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = (v ?? {}) as Partial<Entry>;
      if (
        (typeof e.password === "string" && e.password.length > 0) ||
        (typeof e.passphrase === "string" && e.passphrase.length > 0) ||
        (typeof e.opencodePassword === "string" &&
          e.opencodePassword.length > 0)
      )
        out[id] = {
          v: 1,
          password: e.password,
          passphrase: e.passphrase,
          opencodePassword: e.opencodePassword,
        };
    }
    return out;
  }

  function write(next: Record<string, Entry>): CredentialSetResult {
    try {
      fs.write(file, `${JSON.stringify(next, null, 2)}\n`);
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't save the credential." };
    }
  }

  function decrypt(blob: string | undefined): string | undefined {
    if (!blob) return undefined;
    try {
      return deps.safeStorage.decryptString(Buffer.from(blob, "base64"));
    } catch {
      // Undecryptable (a different OS keyring / version skew) reads as "credential missing";
      // exactly the spec's degrade, so the card shows "not set" instead of crashing.
      return undefined;
    }
  }

  const encrypt = (value: string): string =>
    deps.safeStorage.encryptString(value).toString("base64");

  return {
    get(id) {
      const entry = read()[id];
      if (!entry) return null;
      const password = decrypt(entry.password);
      const passphrase = decrypt(entry.passphrase);
      const opencodePassword = decrypt(entry.opencodePassword);
      if (!password && !passphrase && !opencodePassword) return null;
      const out: ServerCredentials = {};
      if (password) out.password = password;
      if (passphrase) out.passphrase = passphrase;
      if (opencodePassword) out.opencodePassword = opencodePassword;
      return out;
    },
    set(id, value) {
      // safeStorage is touching-after-app-ready is guaranteed by lazy construction at the
      // composition root; this availability guard is the last line of defense. No keyring
      // (some Linux setups) → REFUSE to store; never fall back to plaintext — the file's whole
      // value is that it can't be read without the keyring.
      if (!deps.safeStorage.isEncryptionAvailable())
        return {
          ok: false,
          error:
            "Safe storage is unavailable on this machine; the secret was not saved.",
        };
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
        return { ok: false, error: "Unknown profile." };
      // undefined = leave the kind untouched (the form's blank field for a secret it never
      // round-trips); null or "" = clear it (a mode switch drops the stale secret); non-empty
      // string = replace. Recorded here so the renderer contract has a single home.
      const map = read();
      const prev = map[id] ?? { v: 1 as const };
      const next: Entry = { v: 1 };
      if (value.password === undefined) {
        if (prev.password) next.password = prev.password;
      } else if (value.password === null || value.password === "") {
        // cleared — no password entry survives the rewrite
      } else {
        next.password = encrypt(value.password);
      }
      if (value.passphrase === undefined) {
        if (prev.passphrase) next.passphrase = prev.passphrase;
      } else if (value.passphrase === null || value.passphrase === "") {
        // cleared
      } else {
        next.passphrase = encrypt(value.passphrase);
      }
      if (value.opencodePassword === undefined) {
        if (prev.opencodePassword)
          next.opencodePassword = prev.opencodePassword;
      } else if (
        value.opencodePassword === null ||
        value.opencodePassword === ""
      ) {
        // cleared — a profile losing its opencode section must not hold a dead secret
      } else {
        next.opencodePassword = encrypt(value.opencodePassword);
      }
      if (!next.password && !next.passphrase && !next.opencodePassword)
        delete map[id];
      else map[id] = next;
      return write(map);
    },
    remove(id) {
      const map = read();
      if (!(id in map)) return;
      delete map[id];
      write(map);
    },
    path: () => file,
  };
}
