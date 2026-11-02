/**
 * The transcript→editor link resolver (pass I-b) as a pure function: source resolution per
 * agent×location (over the session row's id + cwd and the path candidate), plus every
 * "not offered" case — non-absolute and foreign (outside the session dir) candidates, bare
 * fragments, multi-token commands, NUL bytes. The session's REMOTENESS comes from its
 * app-level id: a remote opencode session carries `srv-…:<raw>` (opencode/namespace.ts's
 * mint), local sessions of every agent stay bare.
 */
import { describe, expect, it } from "vitest";
import {
  serverIdOfSessionId,
  toolFileTarget,
  type ToolFileSource,
} from "../../src/renderer/src/workspace/tool-file-link";

const src = (over: Partial<ToolFileSource> = {}): ToolFileSource => ({
  sessionId: "a1b2c3d4-uuid",
  cwd: "/home/mary/proj",
  platform: "darwin",
  ...over,
});

describe("serverIdOfSessionId", () => {
  it("splits a namespaced remote opencode id and nulls the bare local ids", () => {
    expect(serverIdOfSessionId("srv-acme:ses_9f3")).toBe("srv-acme");
    expect(serverIdOfSessionId("ses-bare-id")).toBeNull();
    expect(serverIdOfSessionId("")).toBeNull();
  });
});

describe("local session targets (every agent)", () => {
  it("offers an absolute path under the session directory → local", () => {
    expect(toolFileTarget(src(), "/home/mary/proj/src/app.ts")).toEqual({
      kind: "local",
      path: "/home/mary/proj/src/app.ts",
    });
  });

  it("keeps the session directory itself offerable (equality, not just children)", () => {
    expect(toolFileTarget(src(), "/home/mary/proj")).toEqual({
      kind: "local",
      path: "/home/mary/proj",
    });
  });

  it("rejects a foreign absolute path — outside the session dir", () => {
    expect(toolFileTarget(src(), "/etc/hosts")).toBeNull();
    expect(toolFileTarget(src(), "/home/mary/other/file.ts")).toBeNull();
  });

  it("rejects the sibling spelled through ../ — containment is not search", () => {
    expect(toolFileTarget(src(), "/home/mary/proj/../other/secret")).toBeNull();
  });

  it("rejects relative paths even when they'd join under the cwd", () => {
    expect(toolFileTarget(src(), "src/app.ts")).toBeNull();
    expect(toolFileTarget(src(), "./src/app.ts")).toBeNull();
  });

  it("rejects commands, NUL, blanks and non-strings", () => {
    expect(toolFileTarget(src(), "grep -r pattern src/")).toBeNull();
    expect(toolFileTarget(src(), "\0/etc/hosts")).toBeNull();
    expect(toolFileTarget(src(), "   ")).toBeNull();
    expect(toolFileTarget(src(), 42)).toBeNull();
  });

  it("folds case on Windows and honors drive:/mixed-separator spellings", () => {
    const win = src({ cwd: "C:\\Users\\mary\\proj", platform: "win32" });
    expect(toolFileTarget(win, "c:/Users/MARY/proj/src/app.ts")).toEqual({
      kind: "local",
      path: "c:/Users/MARY/proj/src/app.ts",
    });
  });

  it("keeps Windows drives case SENSITIVE outside win32", () => {
    expect(
      toolFileTarget(src({ platform: "darwin" }), "c:/Users/mary/proj/x.ts"),
    ).toBeNull();
  });
});

describe("remote opencode targets (srv-… session ids)", () => {
  it("resolves a posix absolute path under the remote cwd → server", () => {
    const remote = src({ sessionId: "srv-acme:ses_9f3", cwd: "/srv/work/app" });
    expect(toolFileTarget(remote, "/srv/work/app/src/app.ts")).toEqual({
      kind: "server",
      serverId: "srv-acme",
      path: "/srv/work/app/src/app.ts",
    });
  });

  it("refuses a foreign remote path and any Windows-spelled candidate", () => {
    const remote = src({ sessionId: "srv-acme:ses_9f3", cwd: "/srv/work/app" });
    expect(toolFileTarget(remote, "/etc/hosts")).toBeNull();
    expect(toolFileTarget(remote, "C:\\work\\app\\src\\app.ts")).toBeNull();
  });

  it("rejects the ../ smuggled sibling on the remote side too", () => {
    expect(
      toolFileTarget(
        src({ sessionId: "srv-acme:ses_9f3", cwd: "/srv/work/app" }),
        "/srv/work/other/key.material",
      ),
    ).toBeNull();
  });
});

describe("not offered at all", () => {
  it("a session with no directory never offers", () => {
    expect(
      toolFileTarget(src({ cwd: "" }), "/home/mary/proj/src/app.ts"),
    ).toBeNull();
  });
});
