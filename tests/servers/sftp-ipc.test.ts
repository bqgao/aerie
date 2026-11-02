import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { SFTP, type SftpTransferSnapshot } from "../../src/shared/sftp";
import type { SftpService } from "../../src/main/servers/sftp-service";

// Same electron mock shape as tests/servers/servers-ipc.test.ts and tests/terminal/ssh-ipc.test.ts:
// capture the handler surface (invoke) and the send surface (cancel).
const { handlers, onHandlers, sendCalls, dialogCalls, windowHandlers } =
  vi.hoisted(() => ({
    handlers: new Map<string, (...a: unknown[]) => unknown>(),
    onHandlers: new Map<string, (...a: unknown[]) => void>(),
    sendCalls: new Map<string, unknown[]>(),
    dialogCalls: { save: vi.fn(), open: vi.fn() },
    windowHandlers: new Map<string, (...a: unknown[]) => void>(),
  }));

vi.mock("electron", () => ({
  app: { on: () => {}, removeListener: () => {} },
  dialog: {
    showSaveDialog: dialogCalls.save,
    showOpenDialog: dialogCalls.open,
  },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) =>
      handlers.set(channel, fn),
    on: (channel: string, fn: (...a: unknown[]) => void) =>
      onHandlers.set(channel, fn),
    removeAllListeners: (channel: string) => onHandlers.delete(channel),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { registerSftpIpc } from "../../src/main/servers/sftp-ipc";

/** Every service method is a vi.fn with a sane never-reject default; tests assert WHICH
 *  handlers route and with what shapes, not the service's logic (that's sftp-service's job). */
const serviceMock: SftpService = {
  list: vi.fn(() =>
    Promise.resolve({ ok: true as const, entries: [], path: "/x" }),
  ),
  stat: vi.fn(() => Promise.resolve({ ok: false as const, error: "no" })),
  home: vi.fn(() => Promise.resolve({ ok: true as const, path: "/home" })),
  mkdir: vi.fn(() => Promise.resolve({ ok: true as const })),
  createFile: vi.fn(() => Promise.resolve({ ok: true as const })),
  rename: vi.fn(() => Promise.resolve({ ok: true as const })),
  delete: vi.fn(() =>
    Promise.resolve({ ok: true as const, warnings: [] as string[] }),
  ),
  download: vi.fn(() =>
    Promise.resolve({ ok: true as const, skippedLocal: 0 }),
  ),
  upload: vi.fn(() => Promise.resolve({ ok: true as const, skippedLocal: 0 })),
  copy: vi.fn(() => Promise.resolve({ ok: true as const, skippedLocal: 0 })),
  cancel: vi.fn(),
  transfers: vi.fn((): SftpTransferSnapshot => []),
  setPush: vi.fn(),
  noteDown: vi.fn(),
  disposeAll: vi.fn(),
};

function wire() {
  const window = {
    isDestroyed: () => false,
    on: (channel: string, fn: (...a: unknown[]) => void) => {
      windowHandlers.set(channel, fn);
    },
    webContents: {
      send: (...args: unknown[]) => {
        sendCalls.set(args[0] as string, args.slice(1));
      },
    },
  };
  registerSftpIpc({
    window: window as never,
    service: serviceMock as unknown as SftpService,
  });
}

const call = (channel: string, ...args: unknown[]): unknown => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(undefined, ...args);
};

const fire = (channel: string, ...args: unknown[]): void => {
  const fn = onHandlers.get(channel);
  fn?.(undefined, ...args);
};

describe("registerSftpIpc", () => {
  beforeEach(() => {
    handlers.clear();
    onHandlers.clear();
    sendCalls.clear();
    dialogCalls.save.mockReset();
    dialogCalls.open.mockReset();
    vi.clearAllMocks();
  });

  it("delegates list/stat/home with normalized guards: bad input answers in-band without the service", async () => {
    wire();
    await expect(call(SFTP.list, "", "/x")).resolves.toMatchObject({
      ok: false,
    });
    await expect(call(SFTP.list, "srv-1", 42)).resolves.toMatchObject({
      ok: false,
    });
    expect(serviceMock.list).not.toHaveBeenCalled();
    await expect(call(SFTP.rename, "srv-1", "/a", 42)).resolves.toMatchObject({
      ok: false,
    });
    expect(serviceMock.rename).not.toHaveBeenCalled();
    await expect(call(SFTP.list, "srv-1", "/x")).resolves.toMatchObject({}); // passthrough service result
    expect(serviceMock.list).toHaveBeenCalledWith("srv-1", "/x");
  });

  it("download uses the save dialog for a single file; cancel = typed success with nothing queued", async () => {
    wire();
    dialogCalls.save.mockResolvedValue({ canceled: true, filePath: "" });
    await expect(call(SFTP.download, "srv-1", ["/x/a.txt"])).resolves.toEqual({
      ok: true,
      skippedLocal: 0,
      canceled: true,
    });
    expect(dialogCalls.save).toHaveBeenCalled();
    expect(serviceMock.download).not.toHaveBeenCalled();
    dialogCalls.save.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/dl/a-rename.txt",
    });
    await expect(
      call(SFTP.download, "srv-1", ["/x/a.txt"]),
    ).resolves.toMatchObject({ ok: true });
    expect(serviceMock.download).toHaveBeenCalledWith(
      "srv-1",
      ["/x/a.txt"],
      "/tmp/dl",
      "/tmp/dl/a-rename.txt",
    );
  });

  it("download uses the folder picker for a multi-selection", async () => {
    wire();
    dialogCalls.open.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/dl"],
    });
    await expect(
      call(SFTP.download, "srv-1", ["/x/a.txt", "/x/b.txt"]),
    ).resolves.toMatchObject({ ok: true });
    // Multi-select: no saveAs arg at all — the service names each file after its remote basename.
    expect(serviceMock.download).toHaveBeenCalledWith(
      "srv-1",
      ["/x/a.txt", "/x/b.txt"],
      "/tmp/dl",
    );
  });

  it("upload with empty localPaths opens the file picker; drag-drop paths pass through untouched", async () => {
    wire();
    dialogCalls.open.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(call(SFTP.upload, "srv-1", "/x", [])).resolves.toMatchObject({
      ok: true,
      skippedLocal: 0,
      canceled: true,
    });
    expect(serviceMock.upload).not.toHaveBeenCalled();
    await expect(
      call(SFTP.upload, "srv-1", "/x", ["/a.txt"], { overwrite: true }),
    ).resolves.toMatchObject({ ok: true });
    expect(dialogCalls.open).not.toHaveBeenCalledTimes(2);
    expect(serviceMock.upload).toHaveBeenCalledWith("srv-1", "/x", ["/a.txt"], {
      overwrite: true,
    });
  });

  it("copy/delete/cancel/transfers ride straight through; the push mirrors the service", async () => {
    wire();
    await call(SFTP.copy, "srv-1", ["", 42, { from: "/a", to: "/b" }]);
    expect(serviceMock.copy).toHaveBeenCalledWith("srv-1", [
      { from: "/a", to: "/b" },
    ]);
    await call(SFTP.deleteFn, "srv-1", ["/x", 42]);
    expect(serviceMock.delete).toHaveBeenCalledWith("srv-1", ["/x"]);
    fire(SFTP.cancel, "xfer-1");
    expect(serviceMock.cancel).toHaveBeenCalledWith("xfer-1");
    await call(SFTP.transfers);
    expect(serviceMock.transfers).toHaveBeenCalled();
  });

  it("the transfer push rides window.webContents.send with the snapshot only", async () => {
    wire();
    const push = (serviceMock.setPush as unknown as Mock).mock.calls.at(
      -1,
    )?.[0] as ((snapshot: unknown) => void) | undefined;
    expect(push).toBeTruthy();
    push?.([{ id: "t1" }]);
    expect(sendCalls.get(SFTP.event)).toHaveLength(1);
  });

  it("window close detaches the push and drops every handler", () => {
    wire();
    const closed = windowHandlers.get("closed");
    closed?.();
    expect(handlers.size).toBe(0);
    expect(onHandlers.size).toBe(0);
  });
});
