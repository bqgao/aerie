import { describe, it, expect, vi, beforeEach } from "vitest";
import { FILEIO } from "../../src/shared/fileio";
import type { FileIoService } from "../../src/main/fileio/fileio-service";

// Same electron mock shape as tests/servers/sftp-ipc.test.ts: capture the handler surface and
// the dialog surface.
const { handlers, dialogCalls, windowHandlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  dialogCalls: { open: vi.fn() },
  windowHandlers: new Map<string, (...a: unknown[]) => void>(),
}));

vi.mock("electron", () => ({
  dialog: { showOpenDialog: dialogCalls.open },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) =>
      handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

import { registerFileIoIpc } from "../../src/main/fileio/fileio-ipc";

// The raw vi.fn surface (kept OUTSIDE the SftpService-typed object: the interface's method
// signatures make property access an unbound-method error — assert through these plain fns).
const fns = {
  read: vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      content: "x",
      bytes: 1,
      capped: false,
    }),
  ),
  write: vi.fn(() => Promise.resolve({ ok: true as const, bytes: 1 })),
};
const serviceMock = {
  read: fns.read,
  write: fns.write,
} as unknown as FileIoService;

function wire() {
  const window = {
    on: (channel: string, fn: (...a: unknown[]) => void) => {
      windowHandlers.set(channel, fn);
    },
  };
  registerFileIoIpc({
    window: window as never,
    service: serviceMock,
  });
}

const call = (channel: string, ...args: unknown[]): unknown => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(undefined, ...args);
};

describe("registerFileIoIpc", () => {
  beforeEach(() => {
    handlers.clear();
    windowHandlers.clear();
    dialogCalls.open.mockReset();
    vi.clearAllMocks();
  });

  it("delegates read/write straight through (the service owns every rule)", async () => {
    wire();
    await expect(call(FILEIO.read, "/notes/a.md")).resolves.toMatchObject({
      ok: true,
    });
    expect(fns.read).toHaveBeenCalledWith("/notes/a.md");
    await expect(
      call(FILEIO.write, "/notes/a.md", "body"),
    ).resolves.toMatchObject({ ok: true });
    expect(fns.write).toHaveBeenCalledWith("/notes/a.md", "body");
  });

  it("the picker uses the native open dialog; cancel is a typed success", async () => {
    wire();
    dialogCalls.open.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(call(FILEIO.pick)).resolves.toEqual({
      ok: true,
      canceled: true,
    });
    expect(dialogCalls.open).toHaveBeenCalled();
    dialogCalls.open.mockResolvedValue({
      canceled: false,
      filePaths: ["/notes/pick.md"],
    });
    await expect(call(FILEIO.pick)).resolves.toEqual({
      ok: true,
      path: "/notes/pick.md",
    });
  });

  it("window close drops every handler", () => {
    wire();
    const closed = windowHandlers.get("closed");
    closed?.();
    expect(handlers.size).toBe(0);
  });
});
