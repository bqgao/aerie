// Node >= 25 ships a global `localStorage` (experimental webstorage) that is
// enabled by default. In vitest's jsdom environment it shadows jsdom's own
// Storage implementation, and on machines where the storage file cannot be
// resolved it is a degenerate object with no methods at all — every test that
// touches localStorage fails with "localStorage.clear is not a function".
// Redirect the broken global to the jsdom window's real implementation.
if (typeof globalThis.localStorage !== "undefined" && typeof globalThis.localStorage.clear !== "function") {
  const win = globalThis as { window?: { localStorage?: Storage } };
  const jsdomStorage = win.window?.localStorage;
  if (jsdomStorage && typeof jsdomStorage.clear === "function") {
    Object.defineProperty(globalThis, "localStorage", {
      get: () => jsdomStorage,
      configurable: true,
    });
  } else {
    // No jsdom window (or it is broken too): fall back to a minimal in-memory
    // Storage so renderer-tested code paths still behave deterministically.
    const store = new Map<string, string>();
    const memory: Storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      removeItem: (key: string) => void store.delete(key),
      setItem: (key: string, value: string) => void store.set(key, String(value)),
    };
    Object.defineProperty(globalThis, "localStorage", {
      value: memory,
      configurable: true,
      writable: true,
    });
  }
}
