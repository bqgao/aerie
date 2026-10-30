/**
 * The server-profile registry's cross-process types (SSH server accounts this app can connect to).
 * Lives in @shared so the renderer gets the shapes for free through the preload bridge, like every
 * other IPC payload. NOTE: NO credential material lives here — passwords/passphrases travel only
 * through dedicated one-shot calls (see ServerCredentialsInput) and are never round-tripped.
 */

/** How the profile authenticates: a stored password, a key file (optionally passphrase-protected),
 *  or the host's ssh-agent (SSH_AUTH_SOCK). */
export type ServerAuthMode = "password" | "key" | "agent";

/** One saved SSH server account. The profile is the SAFE half of the pair — its JSON file must
 *  never carry credential material, and its only secrets-adjacent field is a local key path. */
export interface ServerProfile {
  id: string;
  /** Required, non-empty — the renderer enforces it before save; the store validates too. */
  name: string;
  /** Free text foldering; "" = ungrouped. */
  group: string;
  host: string;
  port: number;
  username: string;
  authMode: ServerAuthMode;
  /** key mode: path to the private key file on THIS machine. */
  keyPath?: string;
  createdAtMs: number;
  /** When a connection last reached ready (stamped by the connection manager). Absent = never. */
  lastConnectedMs?: number;
}

/** A create/update as the renderer sends it: the safe fields; main decides identity and keeps
 *  lifecycle stamps (id minted here on create; createdAtMs preserved on update; lastConnectedMs
 *  owned by the connection manager, never the form). */
export type ServerProfileInput = Omit<
  ServerProfile,
  "id" | "createdAtMs" | "lastConnectedMs"
> & { id?: string };

/** Credential material for one profile, sent once at save time. Supports both secret kinds so a
 *  key-mode switch can clear the stale password (empty/missing field = no change; `null` clears). */
export interface ServerCredentialsInput {
  password?: string | null;
  passphrase?: string | null;
}

/** The failure type every servers call resolves to — handlers never reject (the app-wide IPC
 *  contract), so save/remove/connect failures surface as `{ ok: false, error }`. */
export type ServerFailure = { ok: false; error: string };

export type ServerSaveResult =
  | { ok: true; profile: ServerProfile }
  | ServerFailure;
export type ServerConnectResult = { ok: true } | ServerFailure;
export type ServerSetCredentialResult = { ok: true } | ServerFailure;

/** Per-profile connection state from the pool. Absent from the map = offline. */
export type ServerStatus = "connecting" | "connected" | "error" | "offline";

export interface ServerStatusEntry {
  status: ServerStatus;
  /** The last dial/connection failure, for the row's inline readout. Cleared on the next attempt
   *  or an explicit disconnect. */
  lastError?: string;
}

/** status(): every saved profile gets an entry (absent id = offline-safe answer anyway, but the
 *  full record keeps the card's polling simple). */
export type ServerStatusMap = Record<string, ServerStatusEntry>;

/** The unsaved-form test input: the profile's connection fields plus raw credential values —
 *  so the Test button works before anything is saved. Credentials enter here and die here;
 *  test() never touches the credential store.
 *  Saved-row test: include `id` and leave the credential fields undefined — MAIN samples the
 *  stored credentials (which never travel to the renderer) and fills them in. Both flavors dial
 *  the same way; the distinction is only who owns the secrets at call time. */
export interface ServerTestInput {
  /** Include for a saved-row test; omit on an unsaved form. */
  id?: string;
  host: string;
  port: number;
  username: string;
  authMode: ServerAuthMode;
  /** key mode: the private key file path; read fresh at dial time. */
  keyPath?: string;
  password?: string;
  passphrase?: string;
}

export type ServerTestResult = { ok: true } | ServerFailure;
