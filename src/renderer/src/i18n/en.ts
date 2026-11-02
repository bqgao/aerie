import {
  formatDayLong,
  formatDayShort,
  formatDuration,
  formatMonthShort,
  formatRelativeTime,
  formatResetCountdown,
  formatTokensAxis,
  formatTokensShort,
  formatTps,
  formatWindowLabel,
} from "@shared/format";

/**
 * The English catalog — both the default language and the shape contract:
 * `Translations` is derived from this object (a plain literal, NOT `as const`,
 * so strings infer as `string` and zh.ts can hold different text), and zh.ts is
 * typed `: Translations`, making any missing/extra key a compile error. Ported
 * from hermes desktop's i18n (typed nested catalogs, arrow functions for
 * interpolation) — see the 2026-07-16 i18n design doc.
 */
export const en = {
  common: {
    cancel: "Cancel",
    close: "Close",
    copy: "Copy",
    copied: "Copied",
    continue: "Continue",
    comingSoon: "Coming soon…",
  },
  settings: {
    nav: {
      settings: "Settings",
      system: "System",
      appearance: "Appearance",
      databases: "Databases",
      about: "About",
    },
    appearance: {
      title: "Appearance",
      lede: "Dark is the default for both the app and the terminal — light is opt-in.",
      language: "Language",
      languageDesc: "The app's display language",
      appTheme: "App theme",
      appThemeDesc: "The panels, sidebar, and settings",
      terminalTheme: "Terminal theme",
      terminalThemeDesc:
        "The interactive shell and the observed session terminal",
      dark: "Dark",
      light: "Light",
      system: "System",
    },
    system: {
      title: "System",
      lede: "The machinery feeding this app. Keep it green.",
    },
    about: {
      title: "About",
      tagline: "Pilot coding agents from one cockpit.",
    },
    cli: {
      title: "Claude Code CLI",
      recheck: "Recheck",
      stateChecking: "CHECKING",
      stateReady: "READY",
      stateFault: "FAULT",
      version: "Version",
      config: "Config",
      notDetected: "not detected",
      headlineReady: "Ready",
      headlineOutdated: "Update available",
      headlineLoggedOut: "Logged out",
      headlineUnknown: "Status unknown",
      headlineNotFound: "Not found",
      detailReady: "Up to date and ready.",
      detailFallback: "Action needed.",
      installDocs: "Install docs",
      unavailableReason:
        "Claude Code CLI isn't usable — see Sys status in the title bar.",
      // Per-agent form: the title-bar Sys lamp only ever reflects Claude's status (see
      // SettingsView's cliDot), so a disabled Codex control points at Settings → System instead,
      // where its own health card actually lives.
      unavailableReasonFor: (label: string) =>
        `${label} CLI isn't usable — check Settings → System.`,
      unavailableShort: "CLI unavailable",
    },
    codexCli: {
      title: "Codex CLI",
      notInstalledHeadline: "NOT DETECTED",
      docs: "Codex docs",
    },
    opencodeCli: {
      title: "OpenCode CLI",
      notInstalledHeadline: "NOT DETECTED",
      docs: "OpenCode docs",
      docsHref: "https://opencode.ai/v2/docs",
    },
    servers: {
      title: "Servers",
      add: "Add server",
      addHeadline: "ADD SERVER",
      editHeadline: "EDIT SERVER",
      name: "Name",
      namePlaceholder: "web-1",
      group: "Group",
      groupPlaceholder: "(ungrouped)",
      host: "Host",
      port: "Port",
      username: "User",
      auth: "Auth",
      authPassword: "password",
      authKey: "key",
      authAgent: "agent",
      keyPath: "Key path",
      password: "Password",
      passphrase: "Passphrase",
      // Pass R: the per-row serve lamp — ok/down/unknown, distinct from the SSH lamp.
      opencode: {
        enable: "Hosts an OpenCode serve",
        servePort: "Serve port",
        directUrl: "Direct URL (optional, skip tunnel)",
        autoTunnel: "Open the tunnel on demand",
        password: "Serve password",
        ok: "SERVE OK",
        down: "SERVE DOWN",
        unknown: "SERVE UNPROBED",
      },
      // Credential inputs are write-only: the field starts blank with this placeholder once a
      // secret is stored (the value is never round-tripped back to the renderer).
      credentialSet: "saved — type to replace, empty keeps",
      save: "Save",
      edit: "Edit",
      cancel: "Cancel",
      test: "Test",
      testing: "TESTING",
      testOk: "OK",
      testFailed: (n: string) => `FAILED — ${n}`,
      tested: "tested",
      status: {
        connected: "CONNECTED",
        connecting: "CONNECTING",
        error: "ERROR",
        offline: "OFFLINE",
      },
      rows: (n: number) => `${n} server${n === 1 ? "" : "s"}`,
      empty:
        "No servers yet — add one to connect to your hosts in later passes (terminals, file browsing).",
      deleteTitle: (name: string) => `Delete ${name}?`,
      deleteBody:
        "Removes the profile and its stored credentials from this machine. Nothing on the server is touched.",
      deleteConfirm: "Delete",
      credFail: (n: string) => `Credential not saved — ${n}`,
      lastConnected: "Last connected",
      never: "never",
    },
    statusline: {
      title: "Statusline",
      stateCapturing: "CAPTURING",
      stateStale: "STALE",
      stateFault: "FAULT",
      stateOff: "OFF",
      stateChecking: "CHECKING",
      enable: "Enable",
      disable: "Disable",
      staleHeadline: "NO FRESH CAPTURES",
      faultHeadline: "CAPTURE FAULT",
      repair: "Repair",
      watchKindLive: "live",
      watchKindWorking: "working",
      staleBody: (count: number, kind: string) =>
        `${count} ${kind} ${count === 1 ? "session" : "sessions"}, none reporting — captures have stopped. Repair rewrites the wrapper.`,
      // English wording fixed by the design spec — do not reword; the zh.ts entry is a real
      // translation of it, not a rewrite.
      noteOn:
        "Live duty, clock and rate limits reach the panels through Claude Code's statusline. Your own statusline renders as usual.",
      noteOff:
        "Capture is off: the panels fall back to transcript data — no live duty, clock or rate limits. Your statusline runs untouched.",
      lastCapture: "Last capture",
      never: "never",
      sessions: "Sessions",
      noSessions: (kind: string) => `no ${kind} sessions`,
      sessionsReporting: (reporting: number, watched: number, kind: string) =>
        `${reporting} of ${watched} ${kind} reporting`,
      refresh: "Refresh",
      eventsOnly: "on events only",
      every: (seconds: number) => `every ${seconds}s`,
      edit: "Edit",
      refreshPlaceholder: "seconds (1–60), empty for events only",
      save: "Save",
    },
    databases: {
      title: "Databases",
      lede: "Local mirrors and indexes derived from coding-agent transcripts on disk.",
      location: "Location",
      reveal: "Reveal in Finder",
      size: "Size",
      turns: "Turns",
      sessions: "Sessions",
      sessionsIndexed: "Sessions",
      history: "History",
      since: (day: string) => `since ${day}`,
      tables: "Tables",
      agentCounts: (
        total: string,
        claude: string,
        codex: string,
        opencode: string,
      ) =>
        `${total} total · Claude Code ${claude} · Codex ${codex} · OpenCode ${opencode}`,
      analytics: {
        title: "Analytics database",
        stateChecking: "CHECKING",
        backfilling: (done: number, total: number) =>
          `BACKFILLING · ${done}/${total}`,
        mirrored: "MIRRORED",
        turnsPurpose: "Durable, agent-scoped usage events for Stats.",
        processedFilesPurpose:
          "Per-transcript scan high-water marks used by the backfill.",
        worktreesPurpose:
          "Persisted worktree-to-main-checkout mappings for project grouping.",
        dangerHeadline: "IRREVERSIBLE BEYOND RETENTION",
        dangerBody:
          "Rebuilds from transcripts on disk. History older than Claude Code's cleanup window is lost for good.",
        resetError: "Couldn't reset. Please try again.",
        reset: "Reset",
        confirmTitle: "Reset the analytics database?",
        confirmBody:
          "Clears the computed stats and rebuilds them from the transcripts on disk. History older than Claude Code's transcript retention is lost for good.",
      },
      index: {
        title: "Session index",
        stateChecking: "CHECKING",
        live: "LIVE",
        sourceTruth:
          "Rebuildable cache; transcripts on disk are the source of truth.",
        sessionsPurpose:
          "Current indexed session summaries for the sidebar and overview.",
      },
    },
    update: {
      title: "Software update",
      autoCheckLabel: "Automatically check for updates",
      autoCheckDesc: "Check on launch and when you open About",
      upToDate: "Up to date",
      check: "Check for updates",
      checking: "Checking for updates…",
      available: "Update available",
      onVersion: (version: string) => `On v${version}`,
      onVersionReleased: (version: string, date: string) =>
        `On v${version} · released ${date}`,
      releaseNotes: "Release notes",
      download: "Download",
      downloading: "Downloading update…",
      downloadProgress: (transferred: string, total: string, percent: number) =>
        `${transferred} of ${total} · ${percent}%`,
      ready: "Update ready",
      downloaded: "Downloaded · installs when you next quit",
      restartHint: "or restart now to apply it immediately",
      restartNow: "Restart now",
      checkError: "Couldn't check for updates",
      retryDetail: (message: string) =>
        `${message} · will retry on next launch`,
      retry: "Retry",
    },
  },
  shell: {
    sidebar: {
      newSession: "New session",
      stats: "Stats",
      updatePendingTitle: "Update pending — see Settings › About",
      updatePendingSrOnly: "(update pending)",
      searchPlaceholder: "Search sessions…",
      searchLabel: "Search sessions",
      clearSearch: "Clear search",
      sessionsLabel: "Sessions",
      pinnedLabel: "Pinned",
      noPinnedSessions: "No pinned sessions.",
      expandAll: "Expand all",
      collapseAll: "Collapse all",
      filterMenuLabel: "Session filters",
      showAgentIcons: "Show agent icons",
      agentGroup: "Agent",
      allAgents: "All agents",
      noPinnedProjects: "No pinned projects.",
      pinProject: "Pin project",
      unpinProject: "Unpin project",
      hideProject: "Hide project",
      unhideProject: "Unhide project",
      hiddenLabel: "Hidden",
      noHiddenProjects: "No hidden projects.",
      projectActions: "Project actions",
      absolutePath: "Absolute path",
      copyPath: "Copy path",
      noMatchingSessions: "No matching sessions.",
      noSessionsYet: "No sessions yet.",
      newSessionIn: (cwd: string) => `New session in ${cwd}`,
      newSessionWith: (label: string, cwd: string) =>
        `New ${label} session in ${cwd}`,
      chooseAgentHint: "Right-click to choose the agent",
      olderSessions: (count: number) => `Older (${count})`,
      showMoreSessions: "Show more",
      activeSessionsBadge: (count: number) => `${count} live`,
      activeSessions: (count: number) =>
        `${count} active ${count === 1 ? "session" : "sessions"}`,
      // Run 1 (tier-1 spec / A1): the rail header's All/Inbox toggle and the inbox's own
      // copy + reason chips.
      listModeLabel: "List all sessions, or only the ones waiting on you",
      listModeAll: "All",
      listModeInbox: "Inbox",
      inboxEmpty: "Nothing is waiting on you.",
      reasonWaiting: "Waiting",
      reasonIdle: "Idle",
      reasonPermission: (tool: string) => `Permission: ${tool}`,
    },
    // Tier-1 Run 2 / A4: the per-session prompt queue's copy.
    promptQueue: {
      menuLabel: "Queue prompt…",
      clearQueue: "Clear queued prompts",
      modalTitle: "Queue prompt",
      placeholder: "Type a prompt to queue…",
      inputLabel: "Prompt to queue",
      modalHint: "Enter to queue · Shift+Enter for a new line",
      modalEmpty: "No queued prompts.",
      queuedPrompts: (count: number) =>
        count === 1 ? "1 queued prompt" : `${count} queued prompts`,
      // The in-band fallback when the arm itself couldn't produce a reason (never a rejection).
      sendFailed: "The prompt could not be delivered.",
    },
    sessionRow: {
      openSession: (title: string) => `Open ${title}`,
      // Pass R: the remote-row server badge tooltip — name first, host after the dot.
      serverBadge: (name: string, host: string) =>
        host ? `Remote server ${name} · ${host}` : `Remote server ${name}`,
      sessionActions: "Session actions",
      expandSubagents: (count: number) =>
        `Expand ${count} ${count === 1 ? "subagent" : "subagents"}`,
      collapseSubagents: (count: number) =>
        `Collapse ${count} ${count === 1 ? "subagent" : "subagents"}`,
      subagentCount: (count: number, active: number) =>
        active > 0
          ? `${count} ${count === 1 ? "subagent" : "subagents"} in this group · ${active} active`
          : `${count} ${count === 1 ? "subagent" : "subagents"} in this group`,
      detachedSubagent: "Detached subagent",
      threadKind: {
        subagent: "Subagent",
        review: "Review",
        guardian: "Guardian",
        compact: "Compact",
      },
      // Pinned-row worktree hint: the real checked-out branch, shown only when it differs from
      // the worktree directory name (they're independent fields and can diverge).
      branchTooltip: (branch: string) => `Branch: ${branch}`,
      // Tier-1 Run 2 / A3: the fork badge's tooltip — the id it was forked from.
      forkedFrom: (sourceId: string) => `Forked from ${sourceId}`,
      // The Lamp glyph's hover-tooltip state word (session-glyph.ts's glyphTitle lowercases it).
      state: {
        working: "Working",
        waiting: "Waiting",
        idle: "Idle",
        ended: "Ended",
      },
    },
    sessionMenu: {
      renameFieldLabel: "Rename session",
      menuTitle: "Session menu",
      pin: "Pin",
      unpin: "Unpin",
      copySessionId: "Copy ID",
      diagnosticReport: "Diagnostic",
      rename: "Rename",
      resume: "Resume",
      resuming: "Resuming…",
      fork: "Fork",
      forking: "Forking…",
      endSession: "End",
      openIn: "Open in",
      resumeConfirmTitle: "Resume a session with no recorded model?",
      resumeConfirmBody:
        "This session never recorded a model — it likely errored before its first turn — so resuming it may fail with a model error. Continue anyway?",
      resumeConfirmLabel: "Resume anyway",
      forkConfirmTitle: "Fork a session with no recorded model?",
      forkConfirmBody:
        "This session never recorded a model — it likely errored before its first turn — so forking it may fail with a model error. Continue anyway?",
      forkConfirmLabel: "Fork anyway",
      endConfirmTitle: "End this session?",
      endConfirmBody:
        "A turn is in progress and will be interrupted. The conversation is saved and can be resumed later.",
      resumeTitleNoConversation:
        "Nothing to resume — this session has no saved conversation.",
      resumeTitlePending:
        "This session just exited. Resume is available in a moment.",
      forkTitleNoConversation:
        "Nothing to fork — this session has no saved conversation.",
      endTitleLive: "End this session",
      endTitleUnavailable:
        "End is only available for a live session you manage.",
      comingSoonForAgent: (label: string) =>
        `Coming soon for ${label} sessions.`,
    },
    newSession: {
      ledeBefore: "Spawns",
      ledeGeneric:
        "in the chosen directory and drives it from a live terminal.",
      sessionSetup: "Session setup",
      agent: "Agent",
      directory: "Directory",
      choose: "Choose…",
      noDirectoryChosen: "No directory chosen",
      model: "Model",
      modelDefault: "Default",
      command: "Command",
      commandHint: "The dim part is fixed. Anything you type is appended.",
      argsPlaceholder: "extra arguments…",
      savePreset: "Save as preset",
      presetNamePlaceholder: "Preset name…",
      presets: "Presets",
      presetNone: "None (clear)",
      deletePreset: (name: string) => `Delete preset ${name}`,
      reservedArg: (token: string) =>
        `${token} is managed by the app and can't be passed here.`,
      unbalancedQuote: "Unclosed quote in arguments.",
      failedToStart: "Failed to start the session",
      create: "Create",
      starting: "Starting…",
    },
    middleHeader: {
      viewGroupLabel: "View",
      transcript: "Transcript",
    },
    footer: {
      keepAwake: "Keep computer awake",
      letSleep: "Let computer sleep",
      caffeinate: "Caffeinate",
      showTerminal: "Show terminal",
      hideTerminal: "Hide terminal",
      terminal: "Terminal",
    },
    titlebar: {
      showSidebar: "Show sidebar",
      hideSidebar: "Hide sidebar",
      showRightPanel: "Show right panel",
      hideRightPanel: "Hide right panel",
    },
    gitReadout: {
      copyBranch: "Copy branch",
    },
    sessionPanel: {
      heading: "Session",
      model: "Model",
      effort: "Effort",
      branch: "Branch",
      pr: "PR",
      clock: "Clock",
      compactions: "Compactions",
      active: "Active",
      tokensReclaimed: (tokens: string) => `${tokens} tokens reclaimed`,
    },
    sessionList: {
      ungrouped: "(no project)",
    },
    // S2's Servers section in the sessions rail (ServerRailSection): titles, row actions, and the
    // context menu. Reuses the settings.servers wording family wherever the strings coincide.
    servers: {
      sectionTitle: "Servers",
      emptyState: "No servers saved — add one in Settings",
      openTerminal: "Open Terminal",
      newTabToServer: "New Tab to This Server",
      editInSettings: "Edit in Settings…",
      connect: "Connect",
      disconnect: "Disconnect",
      browseFiles: "Browse Files",
    },
  },
  /** The SFTP file manager pane (pass F). Keys follow DESIGN_NOTES' skeleton; extra keys carry
   *  only wording the pane's own grammar needs (the conflict wizard's button labels, the
   *  transfers strip's states, and the menu's two default NEW-name placeholders). */
  sftp: {
    pane: {
      title: "Files",
      serverLabel: "Server",
    },
    empty: {
      noServers: "No servers yet — save one in Settings to browse its files.",
    },
    path: {
      edit: "Edit path",
      invalid: "Path not found",
    },
    tree: {
      empty: "No subfolders",
    },
    list: {
      empty: "Empty folder — drop files here to upload",
      name: "Name",
      size: "Size",
      mtime: "Modified",
      sortDirectionLabel: (asc: boolean): string =>
        asc ? "ascending" : "descending",
    },
    menu: {
      open: "Open",
      download: "Download…",
      uploadHere: "Upload Here…",
      newFile: "New File…",
      newFolder: "New Folder…",
      rename: "Rename…",
      delete: "Delete",
      copy: "Copy",
      cut: "Cut",
      paste: "Paste",
      // The pane's clipboard hint under the path bar while a cut selection is armed.
      cutHint: "Cut",
      // The name prompt's placeholder for the two create-paths (rename starts from the row).
      newFileDefault: "untitled.txt",
      newFolderDefault: "untitled-folder",
      // Pass I-a: server files open into the Editor pane's tab family.
      edit: "Edit",
    },
    confirm: {
      deleteTitle: (count: number) =>
        `Delete ${count} item${count === 1 ? "" : "s"}?`,
      deleteBody: (count: number) =>
        `Removes ${count} item${count === 1 ? "" : "s"} from the server.`,
      deleteFolder: "This deletes the folder and all its contents.",
    },
    conflict: {
      title: "A name already exists",
      uploadTitle: "Upload conflict",
      pasteTitle: "Paste conflict",
      uploadBody: "The destination folder already has an entry with this name.",
      pasteBody: "The destination has an entry with this name.",
      count: (index: number, total: number) => `Item ${index + 1} of ${total}`,
      overwrite: "Overwrite",
      skip: "Skip",
      rename: "Rename",
      renameShort: (candidate: string) => `Rename to ${candidate}`,
      overwriteAll: "Overwrite all",
      skipAll: "Skip all",
      applyAll: "Apply to all",
    },
    transfers: {
      title: "Transfers",
      done: "Done",
      canceled: "Canceled",
      failed: "Failed",
      cancel: "Cancel",
      retry: "Retry",
      clearFinished: "Clear finished",
      connectionLost: "Connection lost",
    },
    lock: {
      reconnectedBanner: "Reconnected — refresh",
    },
  },
  /** The Editor pane (pass I-a): docked tabs over the `fileio:*` local family and the SFTP
   *  service's readFile/writeFile. `errors.*` maps the fileio errorKind taxonomy (and the SFTP
   *  failure crumbs) to wording; `message` fallbacks come in raw from mains. */
  editor: {
    pane: {
      title: "Editor",
      tabListAria: "Open files",
      closeTabAria: (name: string) => `Close ${name}`,
    },
    empty: {
      hint: "Open a file",
      dropHint: "…or drop a local file here.",
      noServers: "No servers yet — save one in Settings to edit its files.",
    },
    open: {
      button: "Open",
      local: "Local…",
      server: "Server…",
      serverLabel: "Server",
      pathLabel: "Path",
      pathPlaceholder: "/absolute/path/file.md",
      open: "Open",
    },
    header: {
      localBadge: "Local",
      serverBadge: "SSH",
      opencodeBadge: "opencode",
      readOnly: "Read-only",
      modeEdit: "Edit",
      modePreview: "Preview",
      previewUnavailable: "Preview is available for fresh .md files.",
    },
    footer: {
      utf8: "UTF-8",
      lineCol: (line: number, col: number) => `Ln ${line}, Col ${col}`,
      savedFlash: "Saved",
    },
    banner: {
      capped:
        "Large file — the first 512 KB is loaded and editing is disabled.",
    },
    binary: {
      title: "Binary file",
      body: "This file isn't text, so it can't be edited in this version.",
    },
    errors: {
      invalidPath: "Open an absolute path on this machine.",
      forbiddenPath: "Code-by-wire refuses to edit its own data files.",
      notFound: "File not found.",
      binary: "Binary file, not editable in this version.",
      pdfTooLarge: "PDF is larger than 20 MB — not opened.",
      readFailed: (message: string) => `Could not read the file: ${message}`,
      saveFailed: (message: string) => `Save failed: ${message}`,
    },
    dirty: {
      title: "Unsaved changes",
      body: (name: string) =>
        `${name} has unsaved changes. Save them before closing?`,
      save: "Save",
      discard: "Discard",
      cancel: "Cancel",
    },
  },
  /** Chrome for both terminal surfaces: the interactive shell-terminal pane's tab rail
   *  (rail.tsx) and its context menu, AND the renderer-synthesized banners each terminal writes
   *  directly into its own xterm viewport (the Managed pty's exit notice in terminal-store.ts;
   *  the interactive shell's spawn-failure notice in use-terminal-session.ts). Terminal CONTENT
   *  (pty/shell output) is the shell's own — never translated; only chrome the app itself writes
   *  is. `defaultTitle` is the tab's placeholder label until the pty reports the resolved shell
   *  name or the user renames it. `processExited`/`spawnFailed` are substituted into hand-built
   *  ANSI escape sequences at the call site — keep them as bare word phrases (or, for
   *  `spawnFailed`, a function around the interpolated error message); never fold the escape
   *  codes themselves into the catalog. */
  terminal: {
    tabListAria: "Terminals",
    newTerminal: "New terminal",
    closeOthers: "Close others",
    closeAll: "Close all",
    defaultTitle: "Terminal",
    processExited: "process exited",
    spawnFailed: (message: string) => `Terminal failed to start: ${message}`,
    // S2: the ssh tab's lock overlay states — connecting covers the first dial and every
    // Reconnect (which switches to `reconnecting` wording once a tab has lived), dropped is the
    // message line under the frozen buffer, reconnectFailed interpolates a refused re-dial's
    // in-band error (never credentials — the pool's sticky row reason).
    ssh: {
      connecting: "Connecting…",
      reconnecting: "Reconnecting…",
      droppedOverlay: "Connection lost",
      reconnect: "Reconnect",
      reconnectFailed: (message: string) => `Could not reconnect: ${message}`,
    },
  },
  workspace: {
    emptyStates: {
      noSessions: "No Claude Code sessions found.",
      selectSession: "Select a session to open it.",
      sessionEndedTranscriptSoon: "Session ended — transcript coming soon.",
    },
    // The Managed/Observed legend (currently unwired to any live popover — see mode-info.ts's
    // docstring — but kept translated since the table itself still ships).
    mode: {
      managed: {
        label: "Managed",
        blurb:
          "Spawned and driven by Code-by-wire. You can send input, interrupt it, and end it from here.",
      },
      observed: {
        label: "Observed",
        blurb:
          "Running in another terminal or machine. Code-by-wire mirrors its transcript read-only. You can't type in. Resume it to take the wheel.",
      },
    },
    observedTerminal: {
      endedBadge: "Ended",
      observedBadge: "Observed",
      endedBody: "This session has ended. Bring it back to life.",
      observedBody:
        "This session is running in another terminal — read-only here.",
      endedFooter: "Resume = take the wheel · Fork = explore a new branch",
      observedFooter: "Fork it to branch off into your own session.",
    },
    resume: {
      // useResumeAction's generic fallback when the thrown error carries no message of its own.
      failed: "Failed to resume",
      // App.tsx's resumeSession/forkSession throw Error(...) with these exact messages, surfaced
      // verbatim as e.message by useResumeAction's catch — must stay translated, not just the
      // generic `failed` fallback above (which only fires for a non-Error throw).
      aliveAgain: "This session is alive again.",
      couldNotResume: "Could not resume this session.",
      couldNotFork: "Could not fork this session.",
    },
    openIn: {
      finder: "Finder",
      fileExplorer: "File Explorer",
      fileManager: "File Manager",
    },
  },
  stats: {
    agentLabel: "Agent",
    comingSoonFor: (label: string) => `${label} stats — coming soon…`,
    clearDayFilter: "Clear the day filter",
    buildingHistory: "Building history…",
    noUsage: "No usage yet.",
    shared: {
      unknownModel: "Unknown",
      tokensHeader: "Tokens",
      showMore: (n: number, total: number) => `Show ${n} more (${total} total)`,
      rangeToday: "Today",
      range7d: "7d",
      range30d: "30d",
      range90d: "90d",
      rangeAll: "All",
    },
    overview: {
      sessions: "Sessions",
      tokens: "Tokens",
      favoriteModel: "Favorite model",
      activeDays: "Active days",
      mostActiveDay: "Most active day",
      longestSession: "Longest session",
      longestStreak: "Longest streak",
      currentStreak: "Current streak",
      streakUnit: (n: number): string => (n === 1 ? "day" : "days"),
      contributions: "Contributions",
      less: "Less",
      more: "More",
      trailingYear: "Last 12 months",
      tokensLabel: (value: string) => `${value} tokens`,
      dayTokensAria: (day: string, tokens: string) => `${day}: ${tokens}`,
    },
    models: {
      title: "Tokens per day",
      tooltipNoUsage: "No usage",
      total: "Total",
      inOut: (input: string, output: string) => `In: ${input} · Out: ${output}`,
    },
    projects: {
      title: "By project",
      nameLabel: "Project",
    },
    sessions: {
      title: "By session",
      colSession: "Session",
      colModel: "Model",
      colLastActivity: "Last activity",
      colDuration: "Duration",
      colTurns: "Turns",
      copySessionId: "Copy session ID",
    },
  },
  /** The Activity dock (Tasks/Subagents/Shells/Monitors tabs) plus the right-rail telemetry panels
   *  (Pressure/Spend/Duty/Throughput) that share its `chrome.tsx` PanelSection/PanelHeading shell. */
  dock: {
    label: "Activity",
    resizeAria: "Resize activity dock",
    collapseAria: "Collapse activity dock",
    collapseTitle: "Collapse",
    expandAria: "Expand activity dock",
    expandTitle: "Expand",
    tabs: {
      tasks: "Tasks",
      subagents: "Subagents",
      shells: "Shells",
      monitors: "Monitors",
    },
    tally: (
      tasks: number,
      subagents: number,
      shells: number,
      monitors: number,
    ) =>
      `${tasks} tasks · ${subagents} subagents · ${shells} shells · ${monitors} monitors`,
    // One shared status-word group for every dock tab's glyph label / status pill / metric tag, so
    // Tasks (blocked), Shells and Monitors (running/completed/failed/killed/stopped) all read from
    // here instead of each tab minting its own copy of the same words.
    status: {
      running: "running",
      completed: "completed",
      failed: "failed",
      killed: "killed",
      stopped: "stopped",
      blocked: "blocked",
    },
    aboutMetric: (title?: string) =>
      title ? `About ${title}` : "About this metric",
    tokensUnit: "tokens",
    tasks: {
      empty: "No tasks yet.",
    },
    subagents: {
      empty: "No subagents yet.",
      drillAria: (type: string) => `Drill into ${type} subagent`,
      toolUse: "tool use",
      toolUses: "tool uses",
      toolUsesAria: (n: number) => `${n} tool ${n === 1 ? "use" : "uses"}`,
    },
    shells: {
      empty: "No background shells.",
      openLogAria: (command: string) => `Open log for ${command}`,
      // Appended to a completed shell's status word on a non-zero exit, e.g. "failed (exit 1)".
      exitSuffix: (code: number) => ` (exit ${code})`,
      truncated: (kb: number) => `${kb} KB of earlier output hidden`,
    },
    monitors: {
      empty: "No monitors.",
      openDetailsAria: (command: string) => `Open details for ${command}`,
    },
    pressure: {
      heading: "Pressure",
      info: "How much headroom is left: the current prompt's context fill over the window, then this session's rate-limit windows (% used, time to reset — the session's own numbers, filled from the account API where the session hasn't reported). Extra is the account's paid extra-usage credit. Bars warm to amber past 70% and redline past 85%.",
      noContext: "No context sampled yet.",
      contextUnit: "% context",
      extra: "Extra",
      // Fixed-width technical shorthand (a 28px/w-7 label column) — kept identical across locales so
      // the rate-limit rows don't overflow their gutter; S/O are the Sonnet/Opus initials.
      windowFiveHour: "5h",
      windowSevenDay: "7d",
      windowSevenDaySonnet: "7d S",
      windowSevenDayOpus: "7d O",
    },
    spend: {
      heading: "Spend",
      info: "What this session has consumed: total tokens by kind — fresh input, generated output, cached reads, and the 5-minute and 1-hour cache writes. The $ is Claude Code's own session accounting; on a subscription it is the API-equivalent value, not a bill.",
      infoCodex:
        "What this session has consumed: total tokens by kind — fresh input, generated output, and cached reads. Codex reports no cost accounting, so there is no $ figure.",
      infoOpenCode:
        "What this session has consumed: total tokens by kind — fresh input, generated output, and cached reads. The $ is OpenCode's own session accounting, from the service's per-session cost, not a derived estimate.",
      // Mirrors ui/token-kinds.ts's TOKEN_KINDS, keyed the same way, so SpendPanel can render
      // translated label/description text while still iterating TOKEN_KINDS for order and key.
      kinds: {
        input: {
          label: "Input",
          description:
            "Fresh prompt tokens processed this session, at full price.",
        },
        output: {
          label: "Output",
          description: "Tokens the model generated.",
        },
        cacheRead: {
          label: "Cache read",
          description:
            "Context replayed from cache instead of reprocessed, ~10% of input price.",
        },
        cacheWrite5m: {
          label: "Cache write 5m",
          description:
            "Context written into the 5-minute cache so the next turn replays it cheaply. 1.25× input.",
        },
        cacheWrite1h: {
          label: "Cache write 1h",
          description:
            "Context written into the longer-lived 1-hour cache. 2× input.",
        },
      },
    },
    duty: {
      heading: "Duty",
      info: "The session's duty cycle: how much of its lifetime an API request was actually in flight — time the model was working versus the session sitting open. Cumulative since the session started, so a long-idle session reads low even while currently busy.",
      apiUnit: "% api",
    },
    throughput: {
      heading: "Throughput",
      info: "Token throughput over the last 60s of active generation. The sparkline traces total tokens/sec across recent samples; idle gaps between turns don't count.",
      idle: "idle",
      input: "Input",
      output: "Output",
      // Mirrors SPEED_WINDOW_MS in src/main/provider/claude/transcript-speed.ts (60s) — keep in
      // sync if that window changes. The long form crowded the heading at 237px.
      windowLabel: "60s",
    },
  },
  /** The transcript feed: message bubbles, tool/edit rows, subagent dispatches, and the subagent
   *  drill-in breadcrumb. Transcript CONTENT itself (message text, tool input/output, code) is Claude
   *  Code's own — never translated here; only the chrome around it (labels, empty states, aria text). */
  transcript: {
    noneObserved: "No transcript on disk for this session yet.",
    noneManaged: "No transcript yet — drive the session in the Terminal tab.",
    noneSubagent: "No transcript on disk for this subagent yet.",
    waitingHeading: "Waiting for you",
    // Shown only when the CLI's own waitingReason is unset — the reason text itself (when present)
    // is Claude Code's own content and is never translated.
    waitingFallback: "Waiting for your input",
    you: "You",
    claude: "Claude",
    thinking: "Thinking",
    toolRunning: "running…",
    toolNoOutput: "no output",
    toolOutputLines: (n: number) => `${n} line${n === 1 ? "" : "s"}`,
    viewToolOutput: (name: string) => `View ${name} output`,
    viewDiff: (tool: string, file: string) => `View ${tool} diff for ${file}`,
    subagentLabel: "Subagent",
    session: "Session",
    subagentCrumb: (type: string, description?: string) =>
      description ? `Subagent (${type}): ${description}` : `Subagent (${type})`,
  },
  /** The tool-result/diff/shell/monitor detail modals (ToolResultModal, DiffModal, ShellDetailModal,
   *  MonitorDetailModal) plus the OutputBox they share. Close/Copy reuse `common.close`/`common.copy`
   *  rather than minting per-modal duplicates. */
  modals: {
    shellTitle: "Shell details",
    monitorTitle: "Monitor details",
    detail: {
      status: "Status",
      runtime: "Runtime",
      command: "Command",
      script: "Script",
      output: "Output",
    },
    // Mirrors turn-status.ts's status union (ok/error/pending) shared by the tool and diff rows.
    turnStatus: {
      ok: "passed",
      error: "failed",
      pending: "running",
    },
    // The transcript→editor link (I-b): shown on a tool-drill-in (the modal's expanded state)
    // only when the input IS one absolute path under the session's directory — never a
    // heuristic pick, so the affordance appears rather than disambiguates.
    openInEditor: "Open in editor",
    toolResult: {
      loading: "Loading output…",
      loadError: "Couldn't load output.",
      runningNoOutput: "Running — no output yet.",
      copyOutput: "Copy output",
    },
    diff: {
      noChanges: "no changes",
      copyPath: "Copy path",
      copyDiff: "Copy diff",
    },
    outputBox: {
      reading: "Reading output…",
      unavailable: "No output available",
    },
    diagnostic: {
      title: "Diagnostic report",
      privacy:
        "Metadata only — no messages, code, file contents, or raw error messages.",
      loading: "Generating report…",
      loadError: "Couldn't generate this report.",
      retry: "Retry",
      download: "Download",
      saving: "Saving…",
      saved: "Saved",
      copyError: "Couldn't copy the report.",
      saveError: "Couldn't save the report.",
    },
  },
  /** Wordy time/rate formatting (relative times, durations, month dates). English
   *  delegates to the deterministic @shared/format helpers; zh re-implements the
   *  same thresholds with Chinese units (hermes-style per-locale function values).
   *  Digit-grouped and currency formatters (formatTokens, formatUsd, formatBytes) are
   *  NOT here — they stay in @shared/format, locale-independent by design. The
   *  k/M-abbreviated token counts ARE here (see `numbers` below): Chinese groups large
   *  numbers by powers of 10^4 (万/亿), not 10^3 (k/M), so the abbreviation itself —
   *  not just a unit label — differs by locale. */
  time: {
    ago: (ms: number, now: number) => formatRelativeTime(ms, now),
    countdown: (resetsAt: number, now: number) =>
      formatResetCountdown(resetsAt, now),
    duration: (ms: number) => formatDuration(ms),
    tps: (tps: number) => formatTps(tps),
    // Split form of tps(), for callers that style the number and the unit separately (e.g. a hero
    // number with a small unit label beside it) — avoids string-splitting the combined tps() output
    // with a locale-specific regex. tpsValue + " " + tpsUnit reproduces tps()'s own output.
    tpsValue: (tps: number) => {
      if (!Number.isFinite(tps) || tps <= 0) return "0";
      if (tps >= 1000) return (tps / 1000).toFixed(1) + "k";
      return tps.toFixed(1);
    },
    tpsUnit: "tokens/s",
    dayShort: (day: string) => formatDayShort(day),
    dayLong: (day: string) => formatDayLong(day),
    monthShort: (day: string) => formatMonthShort(day),
    // Codex-only: a rate-limit window's real duration, when its shape doesn't match Claude's fixed
    // 5h/7d pair (see @shared/format's formatWindowLabel doc). Not translated — same fixed-width
    // technical shorthand as windowFiveHour/windowSevenDay below, kept identical across locales.
    windowLabel: (minutes: number) => formatWindowLabel(minutes),
  },
  // B1 transcript search (Search pane). Kept small by design: the pane reuses the rail row
  // grammar, so most of its labels aren't pane-specific.
  search: {
    title: "Search transcripts",
    placeholder: "Search transcripts…",
    noQuery: "Search across Claude Code, Codex, and OpenCode sessions.",
    noResults: "No matches.",
    backfilling: "Building the transcript index…",
    degraded: "Transcript search is unavailable.",
    unavailable: "unavailable",
    hits: (n: number) => `${n} hit${n === 1 ? "" : "s"}`,
  },
  // Large-number abbreviation. English groups by powers of 10^3 (k/M) via the shared
  // formatTokensShort/formatTokensAxis helpers; zh groups by powers of 10^4 (万/亿) with
  // its own thresholds — a genuinely different scheme, not just a different unit string.
  numbers: {
    tokensShort: (n: number) => formatTokensShort(n),
    tokensAxis: (n: number) => formatTokensAxis(n),
  },
};

export type Translations = typeof en;
