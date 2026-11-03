import type {
  Session,
  Account,
  Task,
  BackgroundShell,
  ShellOutput,
  Monitor,
} from "./types";
export type ProjectPlacement = "pinned" | "hidden" | "ordinary";
export type ProjectState = Record<
  string,
  { pinnedAtMs?: number; hiddenAtMs?: number }
>;

/** The app chrome's theme SETTING (the persisted user choice). "system" follows the OS; the
 *  renderer resolves it to a concrete "dark" | "light" for the DOM (data-theme), and the main
 *  process feeds it straight to Electron's nativeTheme.themeSource, which accepts all three. */
export type AppThemeSetting = "dark" | "light" | "system";
import type {
  TranscriptRead,
  ReadSettled,
  ToolResultDetail,
} from "./transcript";
import type { TerminalApi } from "./terminal";
import type { ShellTerminalApi } from "./shell-terminal";
import type { SshTerminalApi } from "./ssh-terminal";
import type { SftpApi } from "./sftp";
import type { FileIoApi } from "./fileio";
import type { PdfTempApi } from "./pdftemp";
import type { MetricsRead } from "./metrics";
import type { ModelDefaults } from "./models";
import type { StatsSnapshot, StatsRange, ScanProgress } from "./stats";
import type { SearchProgress, SearchQueryResult, SearchRead } from "./search";
import type { CliStatus, CliStatusByAgent } from "./cli-status";
import type { AgentId } from "./agents";
import type { UpdateState } from "./update";
import type { StatuslineStatus } from "./statusline-status";
import type { Locale } from "./locale";
import type {
  ServerConnectResult,
  ServerCredentialsInput,
  ServerProfile,
  ServerProfileInput,
  ServerSaveResult,
  ServerSetCredentialResult,
  ServerStatusMap,
  ServerTestInput,
  ServerTestResult,
} from "./servers";
import type { LaunchPresets } from "./extra-args";
import type {
  DiagnosticReportResult,
  SaveDiagnosticReportResult,
} from "./diagnostic-report";
import type {
  SessionExportInput,
  SaveSessionExportResult,
} from "./session-export";
export { type UpdateState };
export { type FileIoApi } from "./fileio";
export { type PdfTempApi } from "./pdftemp";
export const IPC = {
  overview: "overview:get",
  refresh: "sessions:refresh",
  readTranscript: "transcript:read",
  readSubagentTranscript: "subagentTranscript:read",
  readTasks: "tasks:read",
  readShells: "shells:read",
  readShellOutput: "shellOutput:read",
  readMonitors: "monitors:read",
  readMonitorOutput: "monitorOutput:read",
  readMetrics: "metrics:read",
  fullscreen: "window:fullscreen",
  modelDefaults: "model:defaults",
  readStats: "stats:read",
  pumpStats: "stats:pump",
  /** B1 transcript search: progress read (with a change token), one bounded scan step, and a
   *  full-text query. Handlers never reject (in-band failures on the query + read shapes). */
  searchRead: "search:read",
  pumpSearch: "search:pump",
  searchQuery: "search:query",
  dbInfo: "db:info",
  recheckCli: "cli:recheck",
  resetAnalytics: "analytics:reset",
  openExternal: "shell:openExternal",
  revealPath: "shell:revealPath",
  openIn: "shell:openIn",
  projectReveal: "project:reveal",
  sessionRevealTranscript: "session:revealTranscript",
  diagnosticReport: "session:diagnosticReport",
  saveDiagnosticReport: "session:saveDiagnosticReport",
  saveSessionExport: "session-export:save",
  clipboardWriteText: "clipboard:writeText",
  clipboardReadText: "clipboard:readText",
  renameSession: "session:rename",
  setSessionPinned: "session:setPinned",
  /** Tier-1 Run 2 / A3: fork an opencode session through its service API. */
  opencodeFork: "opencode:fork",
  /** Tier-1 Run 2 / A4: deliver one queued prompt to an opencode session's service API. */
  opencodePrompt: "opencode:prompt",
  setProjectPlacement: "project:setPlacement",
  deleteSessions: "sessions:delete",
  getToolResult: "toolResult:get",
  updateGetState: "update:getState",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateInstall: "update:install",
  updateGetAutoCheck: "update:getAutoCheck",
  updateSetAutoCheck: "update:setAutoCheck",
  appearanceGetAppTheme: "appearance:getAppTheme",
  appearanceSetAppTheme: "appearance:setAppTheme",
  appearanceGetTerminalTheme: "appearance:getTerminalTheme",
  appearanceSetTerminalTheme: "appearance:setTerminalTheme",
  appearanceGetReadingTheme: "appearance:getReadingTheme",
  appearanceSetReadingTheme: "appearance:setReadingTheme",
  appearanceGetLocale: "appearance:getLocale",
  appearanceSetLocale: "appearance:setLocale",
  statuslineGetStatus: "statusline:getStatus",
  statuslineSetEnabled: "statusline:setEnabled",
  statuslineSetRefreshInterval: "statusline:setRefreshInterval",
  statuslineRepair: "statusline:repair",
  caffeinateGet: "caffeinate:get",
  caffeinateSet: "caffeinate:set",
  serversList: "servers:list",
  serversSave: "servers:save",
  serversRemove: "servers:remove",
  serversSetCredential: "servers:setCredential",
  serversConnect: "servers:connect",
  serversDisconnect: "servers:disconnect",
  serversStatus: "servers:status",
  serversTest: "servers:test",
  launchPresetsGet: "launchPresets:get",
  launchPresetsSet: "launchPresets:set",
  /** PUSH: main -> renderer on every update-state transition. */
  updateState: "update:state",
} as const;

/** The renderer-facing result of one opencode service-op (tier-1 Run 2 / A3 + A4). Handlers never
 *  reject — the failure reason rides `error` verbatim (already display-grade, built main-side
 *  from the typed API error). `session` carries the optimistic draft for minting ops (fork). */
export interface OpencodeOpResult {
  ok: boolean;
  session?: Session;
  error?: string;
}

/** The index-only slice: the indexed session list from one SQLite read. The SQLite index holds no
 *  live statusLine data, so the account is added later — this is what the store returns,
 *  before the overlay. */
export interface IndexOverview {
  sessions: Session[];
}

/** What the renderer receives: the index slice plus the live statusLine overlay (ipc.ts assembles it). */
export interface OverviewData extends IndexOverview {
  projectState: ProjectState;
  /** App-wide account: billing mode + rate limits from the live statusLine. null when there is no
   *  statusLine data (no captures, or all stale) — the UI reads null as "no rate-limit bars". */
  account: Account | null;
  /** The cached CLI verdict per agent, keyed like AGENT_IDS. Missing/null means no completed check
   *  yet for that agent. */
  cliStatus: CliStatusByAgent;
  /** The user's home directory (os.homedir()), for ~-abbreviating paths in the renderer (the
   *  sidebar's group hints). Rides the overview so no separate IPC round trip is needed. */
  homeDir: string;
}

/** The result of an on-demand tasks read: a fresh list with a change token the caller echoes back as
 *  `since`, or one of the shared settled outcomes (see ReadSettled). */
export type TaskRead =
  | { status: "changed"; mtimeMs: number; tasks: Task[] }
  | ReadSettled;

/** The result of a background-shells list read: the session's shells with a change token, or a shared
 *  settled outcome. The list omits each shell's output path; the log is read separately via readShellOutput. */
export type ShellsRead =
  | { status: "changed"; mtimeMs: number; shells: BackgroundShell[] }
  | ReadSettled;

/** The result of a drilled shell-output read: the output with a change token, or a settled outcome.
 *  Polled only while a shell is open (gated like the subagent read). */
export type ShellOutputRead =
  | { status: "changed"; mtimeMs: number; output: ShellOutput }
  | ReadSettled;

/** The result of a monitors list read: the session's monitors with a change token, or a settled outcome.
 *  The list omits each monitor's output path; the log is read separately via readMonitorOutput. */
export type MonitorsRead =
  | { status: "changed"; mtimeMs: number; monitors: Monitor[] }
  | ReadSettled;

/** The result of a drilled monitor-output read: the output with a change token, or a settled outcome.
 *  Polled only while a monitor is open (gated like the shell read). */
export type MonitorOutputRead =
  | { status: "changed"; mtimeMs: number; output: ShellOutput }
  | ReadSettled;

/** The result of a Stats poll: a fresh snapshot with a change token the renderer echoes back as `since`,
 *  or `unchanged` when nothing the snapshot depends on has moved (no new turn, same local day, scan caught
 *  up, no in-place rewrite) — so the handler skips every aggregate and the renderer skips the re-render.
 *  Mirrors the transcript/tasks reads. */
export type StatsRead =
  | { status: "changed"; token: string; snapshot: StatsSnapshot }
  | { status: "unchanged"; token: string };

/** Per-agent count split used by both cards in Settings → Databases. */
export interface AgentCounts {
  total: number;
  byAgent: Record<AgentId, number>;
}

export interface AnalyticsDbInfo {
  path: string;
  sizeBytes: number;
  turns: AgentCounts;
  sessions: AgentCounts;
  oldestTs: number | null;
  processedFiles: number;
  worktrees: number;
}

export interface IndexDbInfo {
  path: string;
  sizeBytes: number;
  sessions: AgentCounts;
}

/** Both local SQLite stores shown by Settings → Databases. */
export interface DbInfo {
  analytics: AnalyticsDbInfo;
  index: IndexDbInfo;
}

/** A target for the header's "Open in" dropdown. The renderer sends one of these plus the session id;
 *  the main process resolves the folder and opens it. */
export type OpenInTarget = "vscode" | "finder";

/** The result of an openIn request. The handler never throws to the renderer: every failure (no
 *  resolvable cwd, path gone, shell error) comes back as `{ ok: false, error }` so the menu can show it.
 *  A discriminated union, so a successful result can't carry an error and a failure must name one. */
export type OpenInResult = { ok: true } | { ok: false; error: string };

/** The message both the main handler and the renderer fall back to when an open fails without a more
 *  specific reason. Defined once here, the only module both layers import, so the two can't drift. */
export const OPEN_IN_FAILED_MESSAGE = "Couldn't open.";

export interface IpcApi {
  /** Read-only: the indexed sessions as they stand, no sync — fast initial paint. */
  overview(): Promise<OverviewData>;
  /** Sync the index against ~/.claude, then return the fresh sessions from one read. */
  refresh(): Promise<OverviewData>;
  readTranscript(id: string, sinceMtimeMs?: number): Promise<TranscriptRead>;
  /** Read one subagent's own transcript (its sidechain file) into render-ready events — the read behind
   *  drilling into a Subagent lane. `sinceMtimeMs` is the change token from the last read; an unchanged
   *  token skips the read. */
  readSubagentTranscript(
    id: string,
    agentId: string,
    sinceMtimeMs?: number,
  ): Promise<TranscriptRead>;
  /** Read one session's task list from ~/.claude/tasks/<id>/. `sinceMtimeMs` is the change token from
   *  the caller's last read; when it still matches, the result is `unchanged`. */
  readTasks(id: string, sinceMtimeMs?: number): Promise<TaskRead>;
  /** List one session's background shells (compact metadata for the dock). `sinceMtimeMs` is the change
   *  token; an unchanged transcript skips the read. */
  readShells(id: string, sinceMtimeMs?: number): Promise<ShellsRead>;
  /** Read one background shell's output — the read behind drilling into a shell. Prefers the live
   *  `.output` file, falls back to stitched transcript snapshots. `sinceMtimeMs` is the change token. */
  readShellOutput(
    id: string,
    shellId: string,
    sinceMtimeMs?: number,
  ): Promise<ShellOutputRead>;
  /** List one session's monitors (compact metadata for the dock). `sinceMtimeMs` is the change token;
   *  an unchanged transcript skips the read. */
  readMonitors(id: string, sinceMtimeMs?: number): Promise<MonitorsRead>;
  /** Read one monitor's output — the read behind drilling into a monitor. Prefers the authoritative
   *  `.output` file (known at stream-end), falls back to de-duplicated stitched events. `sinceMtimeMs`
   *  is the change token. */
  readMonitorOutput(
    id: string,
    monitorId: string,
    sinceMtimeMs?: number,
  ): Promise<MonitorOutputRead>;
  /** Read one session's lazy metrics (token speed, git, voice, remote). `sinceMtimeMs` is the change
   *  token from the last read; an unchanged token skips the recompute. */
  readMetrics(id: string, sinceMtimeMs?: number): Promise<MetricsRead>;
  /** Per-family model overrides, the configured default family, and the allowed-family allowlist —
   *  read from Claude Code's settings.json and the process env. */
  modelDefaults(): Promise<ModelDefaults>;
  /** Run one bounded, incremental scan step, then return a snapshot scoped to `range` (all-time when
   *  omitted) and `calendarYear` (trailing twelve months when omitted), tagged with a change token. Pass the
   *  last token as `since`; when nothing the snapshot depends on has moved, the result is `unchanged` and no
   *  snapshot is built. Polled while the Stats view is open; never rejects. */
  readStats(
    agent: AgentId,
    range?: StatsRange,
    calendarYear?: number,
    since?: string,
  ): Promise<StatsRead>;
  /** Run one bounded, incremental analytics scan step and return how far the backfill has gotten —
   *  the background pump's poll (spec 2026-07-10). No aggregates are computed, so a caught-up tick
   *  costs one readdir+stat walk. Polled for the app's lifetime by useStatsPump; never rejects (a
   *  scan failure or missing store serves a done progress, parking the pump at its idle cadence). */
  pumpStats(): Promise<ScanProgress>;
  /** Run one bounded, incremental search-scan step and return the combined progress + per-source
   *  status — the search pump's poll (B1 spec). Never rejects: a thrown step serves a done
   *  progress, parking the pump at its idle cadence (mirrors pumpStats). */
  pumpSearch(): Promise<SearchProgress>;
  /** The search backfill readout: progress + per-source status, tagged with a change token. Pass
   *  the last token as `since`; when nothing has moved, the result is `unchanged` and no progress
   *  is built. Polled while the Search pane is open; never rejects. */
  readSearch(since?: string): Promise<SearchRead>;
  /** Run an FTS query across the indexed transcripts: grouped-by-session rows, ranked by bm25.
   *  Handlers never reject — a malformed query or a store failure is an in-band
   *  `{ ok: false, error }`. */
  searchQuery(q: string, limit?: number): Promise<SearchQueryResult>;
  /** Settings → Databases readout, assembled in main so the renderer gets one shape for both stores.
   *  Polled at the warm cadence while the section is mounted. Resolves null when no store is wired or
   *  the read fails; never rejects. */
  dbInfo(): Promise<DbInfo | null>;
  /** Force a fresh CLI status check for one agent (the footer's Re-check button). */
  recheckCli(agent: AgentId): Promise<CliStatus>;
  /** Drop the durable analytics store (turns + scan high-water marks) so the next stats poll rebuilds it
   *  from the transcripts on disk. Resolves `{ ok: false }` when no analytics store is wired or the clear
   *  fails; never rejects. */
  resetAnalytics(): Promise<{ ok: boolean }>;
  /** Open an http(s) URL in the user's default browser (the Git cell's PR link). Non-http(s) URLs are
   *  ignored by the main handler. */
  openExternal(url: string): Promise<void>;
  /** Reveal one of the app's database files in the OS file manager. */
  revealPath(path: string): Promise<void>;
  /** Open the session's working directory in `target`. The path is resolved in the main process from the
   *  session id (registry → transcript), so this works for ended sessions too. Never rejects. */
  openIn(id: string, target: OpenInTarget): Promise<OpenInResult>;
  /** Open a project folder (the sidebar folder row) in the OS file manager. The cwd must belong to
   *  an indexed session — main validates it, so the renderer can't reveal an arbitrary path. Never
   *  rejects: every failure is an in-band result. */
  projectReveal(cwd: string): Promise<OpenInResult>;
  /** Select a session's transcript file in the OS file manager — the actual on-disk record behind
   *  the row, for deleting it for good rather than dismissing it. The path is resolved in main and
   *  never crosses IPC. Never rejects. */
  sessionRevealTranscript(id: string): Promise<OpenInResult>;
  /** Build a public-safe Markdown diagnostic report for one indexed session. */
  diagnosticReport(id: string): Promise<DiagnosticReportResult>;
  /** Save the exact previewed Markdown through a native picker; no destination path crosses in. */
  saveDiagnosticReport(
    fileName: string,
    markdown: string,
  ): Promise<SaveDiagnosticReportResult>;
  /** Save a session-transcript Markdown export through a native picker (10 MiB cap). */
  saveSessionExport(
    input: SessionExportInput,
  ): Promise<SaveSessionExportResult>;
  /** Copy text to the system clipboard (the Git popover's branch / commit copy buttons). */
  clipboardWriteText(text: string): Promise<void>;
  /** Read text from the system clipboard (terminal paste — main-process clipboard for the same
   *  reason as the write path: no focused-secure-context requirement). `type: "selection"` reads
   *  the Linux X11 selection clipboard (Shift+Insert); only ever requested on Linux. */
  clipboardReadText(type?: "selection"): Promise<string>;
  /** Persist a display-name override for a session id (null or a value that trims to empty clears it,
   *  reverting to the derived/live name), then return the fresh overview with the override applied.
   *  Both overview() and refresh() also carry the override, since it is applied in overviewNow(). */
  renameSession(id: string, title: string | null): Promise<OverviewData>;
  /** Persist (or clear) the durable pin mark for a session id, then return the fresh overview with
   *  pinnedAtMs stamped. Applied in overviewNow(), so overview() and refresh() carry it too. */
  setSessionPinned(id: string, pinned: boolean): Promise<OverviewData>;
  /** Tier-1 Run 2 / A3: fork one opencode session through its service API (local or remote —
   *  main resolves every URL/credential). Fails in band: `error` carries the display-grade
   *  reason; `session` carries the optimistic draft of the NEW session on success. */
  opencodeFork(sourceId: string): Promise<OpencodeOpResult>;
  /** Tier-1 Run 2 / A4: deliver one prompt to an opencode session's service API (credentials and
   *  the remote tunnel resolve main-side only). Fails in band; the queue keeps the prompt. */
  opencodePrompt(sessionId: string, text: string): Promise<OpencodeOpResult>;
  /** Every saved launch-args preset, keyed by agent (the New-session preset picker). */
  getLaunchPresets(): Promise<LaunchPresets>;
  /** Replace the whole presets object — the renderer owns list edits and ships the result back. */
  setLaunchPresets(presets: LaunchPresets): Promise<void>;
  setProjectPlacement(
    key: string,
    placement: ProjectPlacement,
  ): Promise<OverviewData>;
  /** Dismiss sessions from the sidebar: tombstones each id (so the next sync can't re-add it),
   *  drops the rows, and purges their indexed search documents, then returns the fresh overview.
   *  The transcript files stay on disk untouched. A dismissed session whose transcript later
   *  wakes back up (resumed from the CLI) re-enters the index on the next sync.
   *  Invalid input (empty/non-string ids) is ignored; never rejects — on failure the unchanged
   *  overview is served. */
  deleteSessions(ids: string[]): Promise<OverviewData>;
  /** Fetch one tool call's full command + output on demand (the tool turn's detail modal). Not polled;
   *  a one-shot read keyed by the tool_use id. `agentId` reads the call from that subagent's own
   *  transcript file instead of the session transcript (the drilled Subagent view). */
  getToolResult(
    id: string,
    toolUseId: string,
    agentId?: string,
  ): Promise<ToolResultDetail>;
  /** The current update state (initial paint + post-action reconciliation). */
  getUpdateState(): Promise<UpdateState>;
  /** Trigger a check; resolves to the resulting state. Live transitions also arrive via onUpdateState. */
  checkForUpdate(): Promise<UpdateState>;
  /** Download the available update. Progress arrives via onUpdateState. */
  downloadUpdate(): Promise<void>;
  /** Quit and install a downloaded update — the app quits, so this never resolves. */
  installUpdate(): void;
  /** Whether the launch check is enabled (missing setting reads as true). */
  getAutoCheckUpdates(): Promise<boolean>;
  /** Persist the launch-check preference. */
  setAutoCheckUpdates(enabled: boolean): Promise<void>;
  /** The app chrome's theme SETTING — "system" follows the OS (missing preference reads as "dark"). */
  getAppTheme(): Promise<AppThemeSetting>;
  /** Persist the app theme setting and sync Electron's nativeTheme (the native macOS traffic-light
   *  buttons — this app uses titleBarStyle "hidden" with them visible; "system" defers to the OS). */
  setAppTheme(theme: AppThemeSetting): Promise<void>;
  /** The terminal panels' theme (interactive shell rail + observed session terminal), independent
   *  of the app theme (missing preference reads as "dark"). */
  getTerminalTheme(): Promise<"dark" | "light">;
  /** Persist the terminal theme. */
  setTerminalTheme(theme: "dark" | "light"): Promise<void>;
  /** The reading surfaces' Typora-style theme (transcript + markdown preview);
   *  missing preference reads as "default" (the app's built-in look). */
  getReadingTheme(): Promise<"default" | "github">;
  /** Persist the reading theme. */
  setReadingTheme(theme: "default" | "github"): Promise<void>;
  /** The app's display language (missing or invalid preference reads as "en" —
   *  the handler runs normalizeLocale, so the renderer never sees a raw value). */
  getLocale(): Promise<Locale>;
  /** Persist the display language. The renderer's $locale atom is the live copy;
   *  no native side effect (unlike setAppTheme's nativeTheme sync). */
  setLocale(locale: Locale): Promise<void>;
  /** The Statusline card's readout: preference, install state, derived health, coverage. Assembled in
   *  main; polled by the System section every 3s while open. Never rejects. */
  getStatuslineStatus(): Promise<StatuslineStatus>;
  /** Toggle capture. Disable = uninstall (settings restored byte-for-byte, captures removed) + persist
   *  the preference; enable = clear it + install. Returns the fresh status; failures surface as
   *  state "fault", never a rejection. */
  setStatuslineEnabled(enabled: boolean): Promise<StatuslineStatus>;
  /** Write refreshInterval (seconds, 1–60 from the UI) into the wrapped statusLine block; null means
   *  events-only. Returns the fresh status. */
  setStatuslineRefreshInterval(
    seconds: number | null,
  ): Promise<StatuslineStatus>;
  /** Re-run the installer's self-heal (recovers a stripped entry / vanished record). Returns the
   *  fresh status. */
  repairStatusline(): Promise<StatuslineStatus>;
  /** Whether the keep-awake blocker is currently active (the footer button's initial paint). */
  getCaffeinate(): Promise<boolean>;
  /** Turn keep-awake on or off. Resolves to the resulting state — main is the source of truth,
   *  so the footer renders the response rather than assuming the toggle took. */
  setCaffeinate(on: boolean): Promise<boolean>;
  /** Settings → Servers. All servers calls follow the app's never-rejects handler rule; save/
   *  credential/connect failures carry their reason in the result instead of a throw. */
  /** Every saved profile (the safe half — no credential material ever). */
  serversList(): Promise<ServerProfile[]>;
  /** Create or update; unknown fields in the input are tolerated, invalid ones fail in the result. */
  serversSave(input: ServerProfileInput): Promise<ServerSaveResult>;
  /** Delete a profile AND its stored credentials. reportable-noop for an unknown id. */
  serversRemove(id: string): Promise<void>;
  /** Store (or clear, null) one profile's password/passphrase. Encrypted with safeStorage;
   *  nothing about the value comes back. */
  serversSetCredential(
    id: string,
    value: ServerCredentialsInput,
  ): Promise<ServerSetCredentialResult>;
  /** Open (pool) the connection for one saved profile. Absent-credential/cfg failures report in
   *  the result; SUCCESS is reflected in the next status() poll. */
  serversConnect(id: string): Promise<ServerConnectResult>;
  /** Tear down one live connection (or a running dial). */
  serversDisconnect(id: string): Promise<void>;
  /** The pool's per-profile status + lastError map, keyed by saved profile id. POLLED while the
   *  Servers card is open — no push channels (app rule). */
  serversStatus(): Promise<ServerStatusMap>;
  /** Dial once with raw form values (works on an UNSAVED form), exec `echo ok`, close. */
  serversTest(input: ServerTestInput): Promise<ServerTestResult>;
}

/** Everything exposed on `window.api`: the request/response surface plus the Managed-terminal surface. */
export type AppApi = IpcApi & {
  terminal: TerminalApi;
  /** The footer shell-terminal surface (a plain interactive shell per tab) — separate manager and
   *  channels from the Managed `terminal` surface above. */
  shellTerminal: ShellTerminalApi;
  /** The SSH-terminal surface (S2): a remote shell channel per tab, riding ONE pooled ssh2 client
   *  per saved server resolved main-side — the renderer never sees credentials or a client. */
  terminalSsh: SshTerminalApi;
  /** The file-manager surface (F): SFTP ops over the pooled ssh2 client per server, main-side
   *  dialogs + one lazy sftp channel per server; transfers poll + push. */
  sftp: SftpApi;
  /** The editor's local-disk surface (I-a): capped UTF-8 read, atomic UTF-8 write, and the
   *  native open-file picker. Path rules live main-side (absolute-only, app data refused). */
  fileio: FileIoApi;
  /** The PDF tab's server half (I-b): main pulls a server PDF into userData/cache/pdf and
   *  answers a `file://` URL for the webview src (content-hash-named copy, 20MiB cap). */
  pdfTemp: PdfTempApi;
  /** Electron webUtils.getPathForFile: the absolute filesystem path of a DOM File dragged from the
   *  OS, for dropping paths into the terminal. Typed loosely (`object`) so this shared type stays
   *  DOM-lib-free under tsconfig.node.json; renderer call sites pass a real File. */
  getPathForFile(file: object): string;
  /** The host platform (`process.platform`), so the renderer can branch macOS-only chrome (the
   *  frameless title bar reserves space for the traffic lights only on darwin). */
  platform: string;
  /** Current web zoom factor (`webFrame.getZoomFactor()`), so the title bar can counter-zoom to a
   *  fixed physical size and keep the macOS traffic lights (OS-drawn, immune to web zoom) aligned. */
  getZoomFactor(): number;
  /** Subscribe to native macOS fullscreen changes. Main pushes the new state on every
   *  enter/leave-full-screen and on each load; the callback receives it, and the returned fn
   *  unsubscribes for effect cleanup. Off macOS main never sends, so the state stays false. */
  onFullscreenChange(cb: (isFullscreen: boolean) => void): () => void;
  /** Subscribe to update-state pushes. Main sends on every transition (including download progress);
   *  the returned fn unsubscribes. Mirrors onFullscreenChange. */
  onUpdateState(cb: (state: UpdateState) => void): () => void;
};
