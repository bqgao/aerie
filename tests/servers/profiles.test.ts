import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServerProfileStore,
  mintServerId,
  SERVERS_FILE_VERSION,
} from "../../src/main/servers/profiles";

describe("createServerProfileStore", () => {
  const dirs: string[] = [];
  let clock = 1_000;
  const store = (dir: string) =>
    createServerProfileStore({ dir, now: () => clock });
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "cbw-srv-"));
    dirs.push(d);
    return d;
  };
  const base = {
    name: "web-1",
    group: "prod",
    host: "web1.example.com",
    port: 22,
    username: "deploy",
    authMode: "password" as const,
  };

  beforeEach(() => {
    clock = 1_000;
  });
  afterEach(() => {
    rmSync(dirs.splice(0).join("/"), { recursive: true, force: true });
    for (const d of []) rmSync(d, { recursive: true, force: true });
  });

  it("an absent file reads as an empty registry; the first write stamps version 1", () => {
    const d = dir();
    expect(store(d).list()).toEqual([]); // no file, no rows, no crash
    store(d).save({ ...base, name: "seed" });
    expect(
      JSON.parse(readFileSync(join(d, "servers.json"), "utf8")).version,
    ).toBe(SERVERS_FILE_VERSION);
  });

  it("saves a profile: id minted server-side, createdAtMs stamped, no credential in the file", () => {
    const d = dir();
    const r = store(d).save(base);
    if (!r.ok) throw new Error(r.error);
    expect(r.profile.id).toMatch(/^srv-/);
    expect(r.profile.createdAtMs).toBe(1000);
    expect(store(d).list()).toHaveLength(1);
    const raw = readFileSync(join(d, "servers.json"), "utf8");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain('password":');
  });

  it("update keeps identity and lifecycle stamps, replaces fields, drops a stale keyPath on a mode switch", () => {
    const d = dir();
    const s = store(d);
    const r = s.save({ ...base, authMode: "key", keyPath: "/keys/id_ed25519" });
    if (!r.ok) throw new Error(r.error);
    const before = r.profile;
    clock = 2_000;
    s.setLastConnected(before.id, 1500);
    const u = s.save({
      ...base,
      id: before.id,
      authMode: "password",
      name: "web-2",
    });
    if (!u.ok) throw new Error(u.error);
    expect(u.profile.id).toBe(before.id);
    expect(u.profile.createdAtMs).toBe(1000); // preserved — the form never carries it
    expect(u.profile.lastConnectedMs).toBe(1500); // manager's stamp survives an update
    expect(u.profile.name).toBe("web-2");
    expect(u.profile.keyPath).toBeUndefined(); // mode switched away → stale path dropped
  });

  it("validates: empty name/host/username, bad port, unknown auth mode, key mode without a path", () => {
    const d = dir();
    const s = store(d);
    expect(s.save({ ...base, name: "   " }).ok).toBe(false);
    expect(s.save({ ...base, host: "" }).ok).toBe(false);
    expect(s.save({ ...base, username: "" }).ok).toBe(false);
    expect(s.save({ ...base, port: 0 }).ok).toBe(false);
    const r = s.save({ ...base, authMode: "key", keyPath: undefined });
    expect(r.ok).toBe(false);
    const unknowable = store(d).save({
      ...base,
      authMode: "ldap" as never,
    });
    expect(unknowable.ok).toBe(false);
  });

  it("remove() reports whether it removed; unknown ids are a clean no-op", () => {
    const d = dir();
    const s = store(d);
    const r = s.save(base);
    if (!r.ok) throw new Error(r.error);
    expect(s.remove(r.profile.id)).toBe(true);
    expect(s.remove(r.profile.id)).toBe(false);
    expect(s.list()).toEqual([]);
  });

  it("a corrupt servers.json reads empty rather than crashing", () => {
    const d = dir();
    writeFileSync(join(d, "servers.json"), "{ not json");
    expect(store(d).list()).toEqual([]);
    // and a subsequent save heals the file
    const r = store(d).save(base);
    expect(r.ok).toBe(true);
  });

  it("a rolled-back (non-array servers) file reads empty", () => {
    const d = dir();
    writeFileSync(
      join(d, "servers.json"),
      JSON.stringify({ version: 1, servers: "nope" }),
    );
    expect(store(d).list()).toEqual([]);
  });

  it("setLastConnected on an unknown id is a no-op (no phantom rows)", () => {
    const d = dir();
    store(d).setLastConnected("srv-nope", 99);
    expect(store(d).list()).toEqual([]);
  });

  it("profile ids are unique across mints (pool keys rely on it)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(mintServerId());
    expect(seen.size).toBe(50);
  });
});
