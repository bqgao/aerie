import { beforeEach, describe, expect, it } from "vitest";
import {
  planServerTerminalOpen,
  reconnectSshTerminal,
  ridingSshTabOf,
  setSshTabState,
  sshDialAttemptOf,
  clearSshTabState,
  sshStateLampClass,
  $sshTabState,
  type SshTabState,
} from "../../src/renderer/src/shell-terminal/ssh-model";
import {
  $activeTerminalId,
  $terminals,
  closeTerminal,
  createSshTerminal,
  createTerminal,
} from "../../src/renderer/src/shell-terminal/terminals";

const TAB = (id: string, serverId: string): LocalEntryLike => ({
  id,
  title: id,
  auto: false,
  cwd: "",
  kind: "ssh",
  serverId,
});
type LocalEntryLike = NonNullable<
  Parameters<typeof planServerTerminalOpen>[0]["tabs"][number]
>;

beforeEach(() => {
  $terminals.set([]);
  $activeTerminalId.set(null);
  $sshTabState.set(new Map<string, SshTabState>());
});

describe("planServerTerminalOpen (the double-click reducer)", () => {
  it("creates a new tab when the server has none riding", () => {
    expect(
      planServerTerminalOpen({
        serverId: "srv-1",
        tabs: [],
        tabStates: new Map(),
      }),
    ).toEqual({ action: "new" });
    // Existing tabs to OTHER servers never match: an ssh tab's window...
    const other = TAB("t-ssh-x", "other");
    expect(
      planServerTerminalOpen({
        serverId: "srv-1",
        tabs: [other, createLocalEntry("t-pty")],
        tabStates: new Map(),
      }),
    ).toEqual({ action: "new" });
  });

  it("revives a dropped tab in place (DESIGN_NOTES: reconnects REUSE the dropped tab)", () => {
    const a = TAB("t-1", "srv-1");
    const stuck = TAB("t-2", "srv-1");
    expect(
      planServerTerminalOpen({
        serverId: "srv-1",
        tabs: [a, stuck],
        tabStates: new Map([
          ["t-1", "connected" as const],
          ["t-2", "dropped" as const],
        ]),
      }),
    ).toEqual({ action: "revive", tabId: "t-2" });
  });

  it("focuses instead of stacking: connected/mid-dial tabs absorb the double-click", () => {
    const a = TAB("t-1", "srv-1");
    expect(
      planServerTerminalOpen({
        serverId: "srv-1",
        tabs: [a],
        tabStates: new Map([["t-1", "connected" as const]]),
      }),
    ).toEqual({ action: "focus", tabId: "t-1" });
    // Unknown tab states (e.g. before the first status report) read as connecting.
    expect(
      planServerTerminalOpen({
        serverId: "srv-1",
        tabs: [a],
        tabStates: new Map(),
      }),
    ).toEqual({ action: "focus", tabId: "t-1" });
  });
});

describe("the ssh tab store", () => {
  it("createSshTerminal appends a kind:'ssh' entry bound to the server, focused", () => {
    const id = createSshTerminal({ id: "srv-1", name: "web-1" });
    expect($terminals.get()).toEqual([
      {
        id,
        title: "web-1",
        auto: false,
        cwd: "",
        kind: "ssh",
        serverId: "srv-1",
      },
    ]);
    expect($activeTerminalId.get()).toBe(id);
  });

  it("reconnect bumps the dial epoch and re-arms as connecting", () => {
    const id = createSshTerminal({ id: "srv-1", name: "web-1" });
    expect(sshDialAttemptOf(id)).toBe(0);
    expect(reconnectSshTerminal(id)).toBe(1);
    expect(sshDialAttemptOf(id)).toBe(1);
    expect(reconnectSshTerminal(id)).toBe(2);
    expect(sshDialAttemptOf(id)).toBe(2);
    expect($sshTabState.get().get(id)).toBe("connecting");
  });

  it("ridingSshTabOf prefers the dropped tab and returns null with no riding tabs", () => {
    const a = createSshTerminal({ id: "srv-1", name: "web-1" });
    expect(ridingSshTabOf("srv-1")).toBe(a); // not dropped yet → the only riding tab
    setSshTabState(a, "connected");
    const b = createSshTerminal({ id: "srv-1", name: "web-1" });
    setSshTabState(b, "dropped");
    expect(ridingSshTabOf("srv-1")).toBe(b); // dropped wins
    expect(ridingSshTabOf("never-connected")).toBeNull();

    // Keyed by serverId: a second server's tab never leaks into the first's plan.
    const c = createSshTerminal({ id: "srv-2", name: "db-1" });
    expect(ridingSshTabOf("srv-2")).toBe(c);
    closeTerminal(c);
    expect(ridingSshTabOf("srv-2")).toBeNull();
  });

  it("clearSshTabState removes exactly one entry (no stale lamps or revive matches)", () => {
    const a = createSshTerminal({ id: "srv-1", name: "web-1" });
    setSshTabState(a, "connected");
    clearSshTabState(a);
    expect($sshTabState.get().has(a)).toBe(false);
    expect(ridingSshTabOf("srv-1")).toBe(a); // the tab still exists until closed
  });

  it("closeTerminal removes the ssh entry with neighbor-slide focus intact", () => {
    const a = createSshTerminal({ id: "srv-1", name: "web-1" });
    const b = createTerminal();
    closeTerminal(a);
    expect($terminals.get().map((t) => t.id)).toEqual([b]);
    expect($activeTerminalId.get()).toBe(b);
  });
});

describe("sshStateLampClass (the shared ServerCard lamp grammar)", () => {
  it("connected = teal steady + glow, connecting = pulsing accent, dropped = danger red", () => {
    expect(sshStateLampClass("connected")).toContain("bg-working");
    expect(sshStateLampClass("connected")).not.toContain("animate-pulse");
    expect(sshStateLampClass("connecting")).toContain("animate-pulse");
    expect(sshStateLampClass("connecting")).toContain("bg-accent");
    expect(sshStateLampClass("dropped")).toContain("bg-danger");
  });
});

function createLocalEntry(id: string): LocalEntryLike {
  // The literal local entry shape (kind omitted → reads as local)
  return {
    id,
    title: id,
    auto: true,
    cwd: "/repo",
  };
}
