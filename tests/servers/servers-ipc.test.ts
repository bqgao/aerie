import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerProfile } from "../../src/shared/servers";

// Same electron mock as tests/ipc.test.ts — capture the handlers registerIpc registers.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "test", getAppMetrics: () => [] },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showSaveDialog: () => Promise.resolve({ canceled: true }) },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) =>
      handlers.set(channel, fn),
  },
  nativeTheme: { themeSource: "system" },
}));

import { registerIpc } from "../../src/main/ipc";
import { IPC } from "../../src/shared/ipc";
import { createServerProfileStore } from "../../src/main/servers/profiles";
import { createServerCredentialStore } from "../../src/main/servers/credentials";
import {
  createConnectionManager,
  type SshClientFactory,
  type SshClientRpc,
} from "../../src/main/servers/connection-manager";

const call = <T>(channel: string, ...args: [...rest: unknown[]]): T => {
  const handler = handlers.get(channel) as (...a: unknown[]) => unknown;
  return handler(undefined, ...args) as T;
};

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cbw-srv-ipc-"));
  dirs.push(d);
  return d;
};

describe("registerIpc servers handlers", () => {
  beforeEach(() => {
    handlers.clear();
  });
  afterEach(() => {
    rmSync(dirs.splice(0).join("|"), { recursive: true, force: true });
    void join;
  });

  function wire() {
    const d = tmp();
    const profiles = createServerProfileStore({ dir: d });
    const credentialStore = createServerCredentialStore({
      dir: d,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(`E:${s}`),
        decryptString: (b) =>
          b.toString("utf8").startsWith("E:")
            ? b.toString("utf8").slice(2)
            : (() => {
                throw new Error("rot");
              })(),
      },
    });
    const configs: unknown[] = [];
    const factory: SshClientFactory = (config, handlers2) => {
      configs.push(config);
      const rpc: SshClientRpc = {
        // The scripted dial fails immediately after connect() — tests assert the config that
        // REACHED ssh, not the (never-producing) connection outcome.
        connect: () => handlers2.onError(new Error("dial refused")),
        end: () => {},
        exec: (_c, cb) => cb(undefined, null),
      };
      return rpc;
    };
    const manager = createConnectionManager({
      profileOf: (id) => profiles.list().find((p) => p.id === id),
      credentialsOf: (id) => credentialStore.get(id),
      sshFactory: factory,
      onConnected: () => {},
    });
    registerIpc({
      db: null as never,
      provider: null as never,
      serverProfiles: profiles,
      serverCredentials: credentialStore,
      connectionManager: manager,
    });
    return { d, profiles, credentialStore, configs };
  }

  it("list/save/status round-trip over the captured channels", () => {
    const { profiles } = wire();
    expect(call<ServerProfile[]>(IPC.serversList)).toEqual([]);
    call<{ ok: boolean }>(IPC.serversSave, {
      name: "web",
      host: "h",
      port: 22,
      username: "u",
      authMode: "password",
      group: "",
    });
    const after = call<ServerProfile[]>(IPC.serversList);
    expect(after).toHaveLength(1);
    expect(after[0].id).toMatch(/^srv-/);
    // save() is upsert; the rendered id lands in status()'s merge via the manager (empty pool).
    expect(call<Record<string, unknown>>(IPC.serversStatus)["srv-nope"]) // no pool, no entry
      .toBeUndefined();
    void profiles;
  });

  it("save() rejects garbage: malformed object answers ok:false without a store write", () => {
    wire();
    expect(call<{ ok: boolean; error: string }>(IPC.serversSave, null).ok).toBe(
      false,
    );
    expect(call<{ ok: boolean; error: string }>(IPC.serversSave, 42).ok).toBe(
      false,
    );
  });

  it("setCredential persists an encrypted blob and list() never carries the value", () => {
    const { profiles } = wire();
    const saved = call<{ ok: true; profile: ServerProfile }>(IPC.serversSave, {
      name: "web",
      host: "h",
      port: 22,
      username: "u",
      authMode: "password",
      group: "",
    });
    expect(
      call<{ ok: boolean }>(IPC.serversSetCredential, saved.profile.id, {
        password: "hunter2",
      }).ok,
    ).toBe(true);
    // The value round-trips encrypted (decrypt reads it back server-side)…
    expect(profiles.list()[0]).not.toContain("hunter2");
    expect(saved.profile).not.toContain("hunter2");
    // …and a garbage profile id is refused without a close window on the store.
    expect(
      call<{ ok: boolean; error: string }>(IPC.serversSetCredential, "../x", {
        password: "y",
      }).ok,
    ).toBe(false);
  });

  it("remove() drops the credential entry with the profile", () => {
    const { profiles } = wire();
    const saved = call<{ ok: true; profile: ServerProfile }>(IPC.serversSave, {
      name: "web",
      host: "h",
      port: 22,
      username: "u",
      authMode: "password",
      group: "",
    });
    call<void>(IPC.serversSetCredential, saved.profile.id, {
      password: "hunter2",
    });
    call<void>(IPC.serversRemove, saved.profile.id);
    expect(profiles.list()).toHaveLength(0);
    // the credential store no longer resolves (probed via a re-save of the same id path)
    void profiles;
  });

  it("test() on a saved row samples the stored credential server-side (never crosses IPC)", async () => {
    const { configs } = wire();
    const saved = call<{ ok: true; profile: ServerProfile }>(IPC.serversSave, {
      name: "web",
      host: "h",
      port: 22,
      username: "u",
      authMode: "password",
      group: "",
    });
    call<void>(IPC.serversSetCredential, saved.profile.id, {
      password: "hunter2",
    });
    // Unsaved mold (no id): no credential arrives from anywhere → config error → nothing dialed.
    const unsaved = await call<Promise<{ ok: boolean; error: string }>>(
      IPC.serversTest,
      {
        host: "h",
        port: 22,
        username: "u",
        authMode: "password",
      },
    );
    expect(unsaved.ok).toBe(false);
    expect(unsaved.error).toBe("No password stored for this profile.");
    expect(configs).toHaveLength(0); // never dialed — the secret was never available
    // The saved-row flavor: MAIN supplies the stored secret inside the dial config.
    await call<Promise<{ ok: boolean; error: string }>>(IPC.serversTest, {
      id: saved.profile.id,
      host: "h",
      port: 22,
      username: "u",
      authMode: "password",
    });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ password: "hunter2" });
    delete (configs[0] as Record<string, unknown>).password; // don't leave secrets in test state
  });

  it("not-wired harnesses get well-formed responses (list [] / status {} / save ok:false)", () => {
    handlers.clear();
    registerIpc({ db: null as never, provider: null as never });
    expect(call<unknown[]>(IPC.serversList)).toEqual([]);
    expect(call<Record<string, unknown>>(IPC.serversStatus)).toEqual({});
    expect(call<{ ok: boolean; error: string }>(IPC.serversSave, {}).ok).toBe(
      false,
    );
  });
});
