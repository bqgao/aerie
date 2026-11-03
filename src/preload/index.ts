import {
  contextBridge,
  ipcRenderer,
  webFrame,
  webUtils,
  type IpcRendererEvent,
} from "electron";
import { IPC, type AppApi } from "@shared/ipc";
import type { SessionExportInput } from "@shared/session-export";
import {
  fromTranscriptWire,
  type TranscriptReadWire,
} from "@shared/transcript";
import { TERMINAL } from "@shared/terminal";
import { SHELL_TERMINAL } from "@shared/shell-terminal";
import { SSH_TERMINAL } from "@shared/ssh-terminal";
import { SFTP } from "@shared/sftp";
import { FILEIO } from "@shared/fileio";
import { PDFTEMP } from "@shared/pdftemp";

const api: AppApi = {
  overview: () => ipcRenderer.invoke(IPC.overview),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  modelDefaults: () => ipcRenderer.invoke(IPC.modelDefaults),
  readStats: (agent, range, calendarYear, since) =>
    ipcRenderer.invoke(IPC.readStats, agent, range, calendarYear, since),
  pumpStats: () => ipcRenderer.invoke(IPC.pumpStats),
  pumpSearch: () => ipcRenderer.invoke(IPC.pumpSearch),
  readSearch: (since) => ipcRenderer.invoke(IPC.searchRead, since),
  searchQuery: (q, limit) => ipcRenderer.invoke(IPC.searchQuery, q, limit),
  dbInfo: () => ipcRenderer.invoke(IPC.dbInfo),
  recheckCli: (agent) => ipcRenderer.invoke(IPC.recheckCli, agent),
  resetAnalytics: () => ipcRenderer.invoke(IPC.resetAnalytics),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  revealPath: (path) => ipcRenderer.invoke(IPC.revealPath, path),
  openIn: (id, target) => ipcRenderer.invoke(IPC.openIn, id, target),
  diagnosticReport: (id) => ipcRenderer.invoke(IPC.diagnosticReport, id),
  saveDiagnosticReport: (fileName, markdown) =>
    ipcRenderer.invoke(IPC.saveDiagnosticReport, { fileName, markdown }),
  saveSessionExport: (input: SessionExportInput) =>
    ipcRenderer.invoke(IPC.saveSessionExport, input),
  clipboardWriteText: (text) =>
    ipcRenderer.invoke(IPC.clipboardWriteText, text),
  clipboardReadText: (type) => ipcRenderer.invoke(IPC.clipboardReadText, type),
  renameSession: (id, title) =>
    ipcRenderer.invoke(IPC.renameSession, id, title),
  setSessionPinned: (id, pinned) =>
    ipcRenderer.invoke(IPC.setSessionPinned, id, pinned),
  opencodeFork: (sourceId) => ipcRenderer.invoke(IPC.opencodeFork, sourceId),
  opencodePrompt: (sessionId, text) =>
    ipcRenderer.invoke(IPC.opencodePrompt, sessionId, text),
  getLaunchPresets: () => ipcRenderer.invoke(IPC.launchPresetsGet),
  setLaunchPresets: (presets) =>
    ipcRenderer.invoke(IPC.launchPresetsSet, presets),
  setProjectPlacement: (key, placement) =>
    ipcRenderer.invoke(IPC.setProjectPlacement, key, placement),
  // Transcript docs cross IPC in wire form (one JSON string) so main only relays a memcpy-cheap
  // string; the parse back into a doc happens here, on the renderer's own thread, where it lands.
  readTranscript: async (id, sinceMtimeMs) =>
    fromTranscriptWire(
      (await ipcRenderer.invoke(
        IPC.readTranscript,
        id,
        sinceMtimeMs,
      )) as TranscriptReadWire,
    ),
  getToolResult: (id, toolUseId, agentId) =>
    ipcRenderer.invoke(IPC.getToolResult, id, toolUseId, agentId),
  getUpdateState: () => ipcRenderer.invoke(IPC.updateGetState),
  checkForUpdate: () => ipcRenderer.invoke(IPC.updateCheck),
  downloadUpdate: () => ipcRenderer.invoke(IPC.updateDownload),
  installUpdate: () => {
    void ipcRenderer.invoke(IPC.updateInstall);
  },
  getAutoCheckUpdates: () => ipcRenderer.invoke(IPC.updateGetAutoCheck),
  setAutoCheckUpdates: (enabled) =>
    ipcRenderer.invoke(IPC.updateSetAutoCheck, enabled),
  getAppTheme: () => ipcRenderer.invoke(IPC.appearanceGetAppTheme),
  setAppTheme: (theme) => ipcRenderer.invoke(IPC.appearanceSetAppTheme, theme),
  getTerminalTheme: () => ipcRenderer.invoke(IPC.appearanceGetTerminalTheme),
  setTerminalTheme: (theme) =>
    ipcRenderer.invoke(IPC.appearanceSetTerminalTheme, theme),
  getLocale: () => ipcRenderer.invoke(IPC.appearanceGetLocale),
  setLocale: (locale) => ipcRenderer.invoke(IPC.appearanceSetLocale, locale),
  getStatuslineStatus: () => ipcRenderer.invoke(IPC.statuslineGetStatus),
  setStatuslineEnabled: (enabled) =>
    ipcRenderer.invoke(IPC.statuslineSetEnabled, enabled),
  setStatuslineRefreshInterval: (seconds) =>
    ipcRenderer.invoke(IPC.statuslineSetRefreshInterval, seconds),
  repairStatusline: () => ipcRenderer.invoke(IPC.statuslineRepair),
  getCaffeinate: () => ipcRenderer.invoke(IPC.caffeinateGet),
  setCaffeinate: (on) => ipcRenderer.invoke(IPC.caffeinateSet, on),
  // Settings → Servers. No credential value ever crosses back — save/credential calls return
  // verdicts only, and list() carries the profile fields, never stored secrets.
  serversList: () => ipcRenderer.invoke(IPC.serversList),
  serversSave: (input) => ipcRenderer.invoke(IPC.serversSave, input),
  serversRemove: (id) => ipcRenderer.invoke(IPC.serversRemove, id),
  serversSetCredential: (id, value) =>
    ipcRenderer.invoke(IPC.serversSetCredential, id, value),
  serversConnect: (id) => ipcRenderer.invoke(IPC.serversConnect, id),
  serversDisconnect: (id) => ipcRenderer.invoke(IPC.serversDisconnect, id),
  serversStatus: () => ipcRenderer.invoke(IPC.serversStatus),
  serversTest: (input) => ipcRenderer.invoke(IPC.serversTest, input),
  readSubagentTranscript: async (id, agentId, sinceMtimeMs) =>
    fromTranscriptWire(
      (await ipcRenderer.invoke(
        IPC.readSubagentTranscript,
        id,
        agentId,
        sinceMtimeMs,
      )) as TranscriptReadWire,
    ),
  readTasks: (id, sinceMtimeMs) =>
    ipcRenderer.invoke(IPC.readTasks, id, sinceMtimeMs),
  readShells: (id, sinceMtimeMs) =>
    ipcRenderer.invoke(IPC.readShells, id, sinceMtimeMs),
  readShellOutput: (id, shellId, sinceMtimeMs) =>
    ipcRenderer.invoke(IPC.readShellOutput, id, shellId, sinceMtimeMs),
  readMonitors: (id, sinceMtimeMs) =>
    ipcRenderer.invoke(IPC.readMonitors, id, sinceMtimeMs),
  readMonitorOutput: (id, monitorId, sinceMtimeMs) =>
    ipcRenderer.invoke(IPC.readMonitorOutput, id, monitorId, sinceMtimeMs),
  readMetrics: (id, sinceMtimeMs) =>
    ipcRenderer.invoke(IPC.readMetrics, id, sinceMtimeMs),
  platform: process.platform,
  getZoomFactor: () => webFrame.getZoomFactor(),
  onFullscreenChange: (cb) => {
    const handler = (_e: IpcRendererEvent, isFullscreen: boolean) =>
      cb(isFullscreen);
    ipcRenderer.on(IPC.fullscreen, handler);
    return () => ipcRenderer.removeListener(IPC.fullscreen, handler);
  },
  onUpdateState: (cb) => {
    const handler = (
      _e: IpcRendererEvent,
      state: import("@shared/ipc").UpdateState,
    ) => cb(state);
    ipcRenderer.on(IPC.updateState, handler);
    return () => ipcRenderer.removeListener(IPC.updateState, handler);
  },
  terminal: {
    spawn: (req) => ipcRenderer.invoke(TERMINAL.spawn, req),
    resume: (req) => ipcRenderer.invoke(TERMINAL.resume, req),
    fork: (req) => ipcRenderer.invoke(TERMINAL.fork, req),
    write: (id, data) => ipcRenderer.send(TERMINAL.write, id, data),
    resize: (id, cols, rows) =>
      ipcRenderer.send(TERMINAL.resize, id, cols, rows),
    ack: (id, charCount) => ipcRenderer.send(TERMINAL.ack, id, charCount),
    kill: (id) => ipcRenderer.send(TERMINAL.kill, id),
    reattach: (id, cols, rows) =>
      ipcRenderer.invoke(TERMINAL.reattach, id, cols, rows),
    pickDirectory: () => ipcRenderer.invoke(TERMINAL.pickDirectory),
    // The two PUSH channels. Each returns an unsubscribe fn so a React effect can detach its exact
    // handler on cleanup — without it, every remount would stack another listener (a classic leak).
    onData: (cb) => {
      const handler = (
        _e: IpcRendererEvent,
        id: string,
        data: string,
        offset: number,
      ) => cb(id, data, offset);
      ipcRenderer.on(TERMINAL.data, handler);
      return () => ipcRenderer.removeListener(TERMINAL.data, handler);
    },
    onExit: (cb) => {
      const handler = (_e: IpcRendererEvent, id: string, code: number) =>
        cb(id, code);
      ipcRenderer.on(TERMINAL.exit, handler);
      return () => ipcRenderer.removeListener(TERMINAL.exit, handler);
    },
    onRename: (cb) => {
      const handler = (_e: IpcRendererEvent, from: string, to: string) =>
        cb(from, to);
      ipcRenderer.on(TERMINAL.rename, handler);
      return () => ipcRenderer.removeListener(TERMINAL.rename, handler);
    },
  },
  shellTerminal: {
    spawn: (req) => ipcRenderer.invoke(SHELL_TERMINAL.spawn, req),
    write: (id, data) => ipcRenderer.send(SHELL_TERMINAL.write, id, data),
    resize: (id, cols, rows) =>
      ipcRenderer.send(SHELL_TERMINAL.resize, id, cols, rows),
    ack: (id, charCount) => ipcRenderer.send(SHELL_TERMINAL.ack, id, charCount),
    kill: (id) => ipcRenderer.send(SHELL_TERMINAL.kill, id),
    onData: (cb) => {
      const handler = (
        _e: IpcRendererEvent,
        id: string,
        data: string,
        offset: number,
      ) => cb(id, data, offset);
      ipcRenderer.on(SHELL_TERMINAL.data, handler);
      return () => ipcRenderer.removeListener(SHELL_TERMINAL.data, handler);
    },
    onExit: (cb) => {
      const handler = (_e: IpcRendererEvent, id: string, code: number) =>
        cb(id, code);
      ipcRenderer.on(SHELL_TERMINAL.exit, handler);
      return () => ipcRenderer.removeListener(SHELL_TERMINAL.exit, handler);
    },
  },
  terminalSsh: {
    spawn: (req) => ipcRenderer.invoke(SSH_TERMINAL.spawn, req),
    write: (id, data) => ipcRenderer.send(SSH_TERMINAL.write, id, data),
    resize: (id, cols, rows) =>
      ipcRenderer.send(SSH_TERMINAL.resize, id, cols, rows),
    ack: (id, charCount) => ipcRenderer.send(SSH_TERMINAL.ack, id, charCount),
    close: (id) => ipcRenderer.send(SSH_TERMINAL.close, id),
    onData: (cb) => {
      const handler = (
        _e: IpcRendererEvent,
        id: string,
        data: string,
        offset: number,
      ) => cb(id, data, offset);
      ipcRenderer.on(SSH_TERMINAL.data, handler);
      return () => ipcRenderer.removeListener(SSH_TERMINAL.data, handler);
    },
    onExit: (cb) => {
      const handler = (
        _e: IpcRendererEvent,
        id: string,
        code: number,
        reason: import("@shared/ssh-terminal").SshTerminalExitReason,
      ) => cb(id, code, reason);
      ipcRenderer.on(SSH_TERMINAL.exit, handler);
      return () => ipcRenderer.removeListener(SSH_TERMINAL.exit, handler);
    },
  },
  sftp: {
    list: (serverId, dir) => ipcRenderer.invoke(SFTP.list, serverId, dir),
    stat: (serverId, path) => ipcRenderer.invoke(SFTP.stat, serverId, path),
    readFile: (serverId, path) =>
      ipcRenderer.invoke(SFTP.readFile, serverId, path),
    writeFile: (serverId, path, content) =>
      ipcRenderer.invoke(SFTP.writeFile, serverId, path, content),
    home: (serverId) => ipcRenderer.invoke(SFTP.home, serverId),
    mkdir: (serverId, path) => ipcRenderer.invoke(SFTP.mkdir, serverId, path),
    createFile: (serverId, path) =>
      ipcRenderer.invoke(SFTP.createFile, serverId, path),
    rename: (serverId, from, to) =>
      ipcRenderer.invoke(SFTP.rename, serverId, from, to),
    delete: (serverId, paths) =>
      ipcRenderer.invoke(SFTP.deleteFn, serverId, paths),
    download: (serverId, remotePaths) =>
      ipcRenderer.invoke(SFTP.download, serverId, remotePaths),
    upload: (serverId, dir, localPaths, opts) =>
      ipcRenderer.invoke(SFTP.upload, serverId, dir, localPaths, opts),
    copy: (serverId, items) => ipcRenderer.invoke(SFTP.copy, serverId, items),
    cancel: (transferId) => ipcRenderer.send(SFTP.cancel, transferId),
    transfers: () => ipcRenderer.invoke(SFTP.transfers),
    onEvent: (cb) => {
      const handler = (
        _e: IpcRendererEvent,
        snapshot: import("@shared/sftp").SftpTransferSnapshot,
      ) => cb(snapshot);
      ipcRenderer.on(SFTP.event, handler);
      return () => ipcRenderer.removeListener(SFTP.event, handler);
    },
  },
  fileio: {
    read: (path) => ipcRenderer.invoke(FILEIO.read, path),
    write: (path, content) => ipcRenderer.invoke(FILEIO.write, path, content),
    pick: () => ipcRenderer.invoke(FILEIO.pick),
  },
  pdfTemp: {
    openPdfServer: (serverId, path) =>
      ipcRenderer.invoke(PDFTEMP.open, serverId, path),
  },
  getPathForFile: (file) => webUtils.getPathForFile(file as File),
};

contextBridge.exposeInMainWorld("api", api);
