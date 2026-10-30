import { describe, it, expect } from "vitest";
import { createServerCredentialStore } from "../../src/main/servers/credentials";
import type {
  ServerCredentialStoreDeps,
  SafeStorageLike,
} from "../../src/main/servers/credentials";

/** A reversible safeStorage stand-in: base64("SS:<plain>") — byte-orss store so tests can also
 *  assert the FORM of the store (blob present, plaintext absent). An invalid blob decrypts to a
 *  throw to exercise the corrupt-entry path. */
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`SS:${plain}`, "utf8"),
  decryptString: (blob) => {
    const s = blob.toString("utf8");
    if (!s.startsWith("SS:")) throw new Error("undecryptable blob");
    return s.slice(3);
  },
};

function make(overrides: Partial<ServerCredentialStoreDeps> = {}) {
  const files = new Map<string, string>();
  const store = createServerCredentialStore({
    dir: "/u",
    safeStorage: overrides.safeStorage ?? safeStorage,
    fs: {
      read: (path) => files.get(path) ?? null,
      write: (path, content) => void files.set(path, content),
    },
  });
  return { store, files };
}
const FILE = "/u/servers-credentials.json";

describe("createServerCredentialStore", () => {
  it("round-trips a password and a passphrase via the encrypted store", () => {
    const { store } = make();
    expect(
      store.set("srv-1", { password: "hunter2", passphrase: "zap" }),
    ).toEqual({ ok: true });
    expect(store.get("srv-1")).toEqual({
      password: "hunter2",
      passphrase: "zap",
    });
  });

  it("encrypts at rest: the file carries safeStorage blobs, never plaintext", () => {
    const m = make();
    m.store.set("srv-1", { password: "hunter2" });
    const raw = m.files.get(FILE) ?? "";
    expect(raw).not.toContain("hunter2");
    // The blob is base64(SS:plain) — decode and confirm the safeStorage-at-rest form.
    const blob = JSON.parse(raw)["srv-1"].password;
    expect(Buffer.from(blob, "base64").toString("utf8")).toBe("SS:hunter2");
  });

  it("an undecryptable entry reads as credential-missing (null), and its siblings survive", () => {
    const { store, files } = make();
    store.set("srv-1", { password: "good" });
    store.set("srv-2", { password: "rotted" });
    // Maul srv-1's blob into bare JSON (an entry the reader keeps but can't decrypt).
    const data = JSON.parse(files.get(FILE)!);
    data["srv-2"].password = Buffer.from("no-SS-prefix", "utf8").toString(
      "base64",
    );
    files.set(FILE, JSON.stringify(data));
    expect(store.get("srv-2")).toBeNull(); // rotted → credential missing
    expect(store.get("srv-1")).toEqual({ password: "good" }); // sibling intact
  });

  it("absent file / absent id / corrupt JSON all read null", () => {
    const { store, files } = make();
    expect(store.get("srv-x")).toBeNull();
    files.set(FILE, "{ not json");
    expect(store.get("srv-x")).toBeNull();
  });

  it("set preserves untouched kinds, and null/empty clears only the kind sent", () => {
    const { store } = make();
    store.set("srv-1", { password: "hunter2", passphrase: "zap" });
    store.set("srv-1", { password: "newpass" }); // undefined passphrase survives
    expect(store.get("srv-1")).toEqual({
      password: "newpass",
      passphrase: "zap",
    });
    store.set("srv-1", { password: null }); // explicit clear
    expect(store.get("srv-1")).toEqual({ passphrase: "zap" });
    expect(store.get("srv-1")?.password).toBeUndefined();
    store.set("srv-1", { passphrase: null, password: "" });
    expect(store.get("srv-1")).toBeNull(); // both cleared → the whole entry goes
  });

  it("an empty string in a set keeps the stored value only when the kind is omitted — empty means CLEAR", () => {
    const { store } = make();
    store.set("srv-1", { password: "old" });
    store.set("srv-1", { password: "" }); // "" = clear (the renderer contracts it)
    expect(store.get("srv-1")).toBeNull();
  });

  it("removing an unknown id is a no-op; removing a known one drops the entry", () => {
    const { store, files } = make();
    store.remove("srv-never"); // no crash
    store.set("srv-1", { password: "x" });
    store.remove("srv-1");
    expect(store.get("srv-1")).toBeNull();
    expect(files.get(FILE)).not.toContain("srv-1");
  });

  it("a safeStorage that lost the OS key refusing to store is an ERROR, not plaintext", () => {
    const { store, files } = make({
      safeStorage: {
        ...safeStorage,
        isEncryptionAvailable: () => false,
      },
    });
    const r = store.set("srv-1", { password: "should-not-land" });
    expect(r.ok).toBe(false);
    expect(files.get(FILE)).toBeUndefined(); // nothing written AT ALL
    expect(store.get("srv-1")).toBeNull();
  });

  it("writing preserves other profiles' entries (per-profile rewrite never drops siblings)", () => {
    const { store } = make();
    store.set("srv-1", { password: "one" });
    store.set("srv-2", { password: "two" });
    store.set("srv-3", { passphrase: "three" });
    expect(store.get("srv-2")).toEqual({ password: "two" });
    expect(store.get("srv-3")).toEqual({ passphrase: "three" });
  });
});
