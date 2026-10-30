import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServiceDiscovery,
  parseServiceStatus,
  readServicePassword,
  resolveOpencodeConfigDir,
  OPENCODE_REDISCOVERY_INTERVAL_MS,
} from "../../src/main/provider/opencode/service";

describe("parseServiceStatus", () => {
  it("extracts the URL from the CLI's status output, trailing slash trimmed", () => {
    expect(parseServiceStatus("http://127.0.0.1:49374\n")).toBe(
      "http://127.0.0.1:49374",
    );
  });
  it("tolerates prose around it and empty output", () => {
    expect(parseServiceStatus("service url: https://host:1234/")).toBe(
      "https://host:1234",
    );
    expect(parseServiceStatus("")).toBeNull();
    expect(parseServiceStatus("no url here")).toBeNull();
  });
});

describe("readServicePassword", () => {
  it("reads the CLI's service.json password; absent or malformed files read null", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocsvc-"));
    writeFileSync(
      join(dir, "service.json"),
      JSON.stringify({ password: "sekret" }),
    );
    expect(readServicePassword(dir)).toBe("sekret");
    expect(readServicePassword(join(dir, "missing"))).toBeNull();
    writeFileSync(join(dir, "service.json"), "{ broken");
    expect(readServicePassword(dir)).toBeNull();
  });
});

describe("resolveOpencodeConfigDir", () => {
  it("honors OPENCODE_CONFIG_DIR and otherwise reads $HOME/.config/opencode", () => {
    expect(
      resolveOpencodeConfigDir({ OPENCODE_CONFIG_DIR: "/x", HOME: "/h" }),
    ).toBe("/x");
    expect(resolveOpencodeConfigDir({ HOME: "/h" })).toBe(
      "/h/.config/opencode",
    );
  });
});

function fakeSpawnFactory() {
  let started = false;
  let statusCalls = 0;
  let startCalls = 0;
  let fail = false;
  return {
    statusCalls: () => statusCalls,
    startCalls: () => startCalls,
    setFail: (v: boolean) => {
      fail = v;
    },
    spawn: (
      args: string[],
    ): Promise<{ code: number | null; stdout: string } | null> => {
      if (args[0] === "service" && args[1] === "start") {
        startCalls++;
        if (fail) return Promise.resolve({ code: 1, stdout: "" });
        started = true;
        return Promise.resolve({ code: 0, stdout: "started" });
      }
      if (args[0] === "service" && args[1] === "status") {
        statusCalls++;
        if (fail || !started)
          return Promise.resolve({ code: 1, stdout: "not running" });
        return Promise.resolve({ code: 0, stdout: "http://127.0.0.1:49374\n" });
      }
      return Promise.resolve({ code: 1, stdout: "" });
    },
  };
}

describe("createServiceDiscovery", () => {
  it("caches one resolution; a start attempt happens once when status says not running", async () => {
    const spawn = fakeSpawnFactory();
    const svc = createServiceDiscovery({
      configDir: mkdtempSync(join(tmpdir(), "ocsvc-d-")),
      now: () => 0,
      spawnFn: spawn.spawn,
    });
    const a = await svc.resolve();
    expect(a?.baseUrl).toBe("http://127.0.0.1:49374");
    expect(spawn.startCalls()).toBe(1);
    expect(spawn.statusCalls()).toBe(2);
    // Cached — no further spawns.
    await svc.resolve();
    expect(spawn.statusCalls()).toBe(2);
  });

  it("a failed resolve stays null and re-attempts only after the throttle (once per minute)", async () => {
    const spawn = fakeSpawnFactory();
    const clock = 0;
    const svc = createServiceDiscovery({
      configDir: mkdtempSync(join(tmpdir(), "ocsvc-f-")),
      now: () => clock,
      spawnFn: spawn.spawn,
    });
    spawn.setFail(true);
    expect(await svc.resolve()).toBeNull();
    expect(await svc.resolve()).toBeNull(); // throttled within a minute
    expect(spawn.statusCalls()).toBe(2); // initial + post-start retry
    // invalidate() un-throttles regardless of the clock.
    spawn.setFail(false);
    svc.invalidate();
    expect((await svc.resolve())?.baseUrl).toBe("http://127.0.0.1:49374");
  });

  it("an expired throttle allows one fresh failed resolve, then locks for the interval", async () => {
    const spawn = fakeSpawnFactory();
    let clock = 0;
    const svc = createServiceDiscovery({
      configDir: mkdtempSync(join(tmpdir(), "ocsvc-t-")),
      now: () => clock,
      spawnFn: spawn.spawn,
    });
    spawn.setFail(true);
    expect(await svc.resolve()).toBeNull();
    clock += OPENCODE_REDISCOVERY_INTERVAL_MS - 1;
    expect(await svc.resolve()).toBeNull();
    expect(spawn.statusCalls()).toBe(2); // still throttled (failures cached)
    clock += 1;
    expect(await svc.resolve()).toBeNull(); // allowed through: one fresh attempt
    // The fresh attempt is just a single status probe — the start attempt fires once per
    // process, so no post-start retry happens here.
    expect(spawn.statusCalls()).toBe(3);
  });
});
