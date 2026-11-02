import { formatWindowLabel } from "@shared/format";
import type { Translations } from "./en";

/** 简体中文 catalog. Full (not partial) — typed `: Translations` so tsc fails on any
 *  missing key, hermes's zh.ts enforcement model. Time functions re-implement the
 *  exact thresholds of @shared/format's helpers with Chinese units. */
export const zh: Translations = {
  common: {
    cancel: "取消",
    close: "关闭",
    copy: "复制",
    copied: "已复制",
    continue: "继续",
    comingSoon: "即将推出…",
  },
  settings: {
    nav: {
      settings: "设置",
      system: "系统",
      appearance: "外观",
      databases: "数据库",
      about: "关于",
    },
    appearance: {
      title: "外观",
      lede: "应用与终端默认使用深色主题，浅色需手动开启。",
      language: "语言",
      languageDesc: "应用的显示语言",
      appTheme: "应用主题",
      appThemeDesc: "面板、侧边栏与设置",
      terminalTheme: "终端主题",
      terminalThemeDesc: "交互式终端与会话观察终端",
      dark: "深色",
      light: "浅色",
      system: "跟随系统",
    },
    system: {
      title: "系统",
      lede: "驱动本应用的底层机件，保持绿灯。",
    },
    about: {
      title: "关于",
      tagline: "在同一座驾驶舱里驾驭编码智能代理。",
    },
    cli: {
      title: "Claude Code CLI",
      recheck: "重新检测",
      stateChecking: "检测中",
      stateReady: "就绪",
      stateFault: "故障",
      version: "版本",
      config: "配置",
      notDetected: "未检测到",
      headlineReady: "已就绪",
      headlineOutdated: "有可用更新",
      headlineLoggedOut: "已登出",
      headlineUnknown: "状态未知",
      headlineNotFound: "未找到",
      detailReady: "已是最新版本，可以使用。",
      detailFallback: "需要处理。",
      installDocs: "安装文档",
      unavailableReason:
        "Claude Code CLI 当前不可用 — 请查看标题栏中的系统状态。",
      unavailableReasonFor: (label: string) =>
        `${label} CLI 当前不可用 — 请查看设置 → 系统。`,
      unavailableShort: "CLI 不可用",
    },
    codexCli: {
      title: "Codex CLI",
      notInstalledHeadline: "未检测到",
      docs: "Codex 文档",
    },
    opencodeCli: {
      title: "OpenCode CLI",
      notInstalledHeadline: "未检测到",
      docs: "OpenCode 文档",
      docsHref: "https://opencode.ai/v2/docs",
    },
    servers: {
      title: "服务器",
      add: "添加服务器",
      addHeadline: "添加服务器",
      editHeadline: "编辑服务器",
      name: "名称",
      namePlaceholder: "web-1",
      group: "分组",
      groupPlaceholder: "（未分组）",
      host: "主机",
      port: "端口",
      username: "用户",
      auth: "认证",
      authPassword: "密码",
      authKey: "密钥",
      authAgent: "代理",
      keyPath: "密钥路径",
      password: "密码",
      passphrase: "密钥口令",
      // Pass R: the per-row serve lamp — ok/down/unknown, distinct from the SSH lamp.
      opencode: {
        enable: "托管 OpenCode serve",
        servePort: "服务端口",
        directUrl: "直连地址（可选，跳过隧道）",
        autoTunnel: "按需开启隧道",
        password: "服务密码",
        ok: "服务正常",
        down: "服务不可用",
        unknown: "服务未探测",
      },
      // Credential inputs are write-only: the field starts blank with this placeholder once a
      // secret is stored (the value is never round-tripped back to the renderer).
      credentialSet: "已保存 — 输入以替换，留空则保留",
      save: "保存",
      edit: "编辑",
      cancel: "取消",
      test: "测试",
      testing: "测试中",
      testOk: "通过",
      testFailed: (n) => `失败 — ${n}`,
      tested: "已测试",
      status: {
        connected: "已连接",
        connecting: "连接中",
        error: "错误",
        offline: "离线",
      },
      rows: (n: number) => `${n} 台服务器`,
      empty:
        "还没有服务器 — 添加一个，以便在后续功能（终端、文件浏览）中连接到你的主机。",
      deleteTitle: (name) => `删除 ${name}？`,
      deleteBody:
        "将删除该配置以及本机上保存的凭据。服务器上的内容不会受影响。",
      deleteConfirm: "删除",
      credFail: (n) => `凭据未保存 — ${n}`,
      lastConnected: "最近连接",
      never: "从未",
    },
    statusline: {
      title: "Statusline",
      stateCapturing: "捕获中",
      stateStale: "已过期",
      stateFault: "故障",
      stateOff: "已关闭",
      stateChecking: "检测中",
      enable: "启用",
      disable: "禁用",
      staleHeadline: "无新捕获",
      faultHeadline: "捕获故障",
      repair: "修复",
      watchKindLive: "活跃",
      watchKindWorking: "运行中",
      staleBody: (count, kind) =>
        `${count} 个${kind}会话均未上报 — 捕获已停止。修复将重写该封装脚本。`,
      noteOn:
        "实时占空比、时钟与速率限制均通过 Claude Code 的状态栏传递给面板。你自己的状态栏照常显示。",
      noteOff:
        "捕获已关闭：面板退回使用会话记录数据 — 没有实时占空比、时钟或速率限制。你的状态栏不受影响，照常运行。",
      lastCapture: "上次捕获",
      never: "从未",
      sessions: "会话",
      noSessions: (kind) => `没有${kind}会话`,
      sessionsReporting: (reporting, watched, kind) =>
        `${watched} 个${kind}会话中有 ${reporting} 个已上报`,
      refresh: "刷新",
      eventsOnly: "仅事件触发",
      every: (seconds) => `每 ${seconds} 秒`,
      edit: "编辑",
      refreshPlaceholder: "秒数（1–60），留空则仅事件触发",
      save: "保存",
    },
    databases: {
      title: "数据库",
      lede: "从磁盘上的编码智能代理会话记录生成的本地镜像与索引。",
      location: "位置",
      reveal: "在访达中显示",
      size: "大小",
      turns: "轮次",
      sessions: "会话",
      sessionsIndexed: "会话",
      history: "历史记录",
      since: (day) => `自 ${day} 起`,
      tables: "数据表",
      agentCounts: (total, claude, codex, opencode) =>
        `共 ${total} · Claude Code ${claude} · Codex ${codex} · OpenCode ${opencode}`,
      analytics: {
        title: "分析数据库",
        stateChecking: "检测中",
        backfilling: (done, total) => `回填中 · ${done}/${total}`,
        mirrored: "镜像完成",
        turnsPurpose: "供统计页面使用的持久化、按智能代理区分的用量事件。",
        processedFilesPurpose: "回填扫描使用的逐会话记录处理进度。",
        worktreesPurpose: "用于项目分组的工作树与主检出目录映射。",
        dangerHeadline: "超出保留期限将不可恢复",
        dangerBody:
          "将根据磁盘上的会话记录重建。早于 Claude Code 清理窗口的历史记录将永久丢失。",
        resetError: "重置失败，请重试。",
        reset: "重置",
        confirmTitle: "重置分析数据库？",
        confirmBody:
          "将清除已计算的统计数据，并根据磁盘上的会话记录重新构建。早于 Claude Code 记录保留期限的历史记录将永久丢失。",
      },
      index: {
        title: "会话索引",
        stateChecking: "检测中",
        live: "实时",
        sourceTruth: "可重建缓存；磁盘上的会话记录才是数据源。",
        sessionsPurpose: "供侧边栏与概览使用的当前会话摘要索引。",
      },
    },
    update: {
      title: "软件更新",
      autoCheckLabel: "自动检查更新",
      autoCheckDesc: "启动应用和打开“关于”时检查新版本",
      upToDate: "已是最新",
      check: "检查更新",
      checking: "正在检查更新…",
      available: "有可用更新",
      onVersion: (version) => `当前 v${version}`,
      onVersionReleased: (version, date) => `当前 v${version} · 发布于 ${date}`,
      releaseNotes: "更新说明",
      download: "下载",
      downloading: "正在下载更新…",
      downloadProgress: (transferred, total, percent) =>
        `${transferred} / ${total} · ${percent}%`,
      ready: "更新已就绪",
      downloaded: "已下载 · 将在下次退出时安装",
      restartHint: "或立即重启以马上应用",
      restartNow: "立即重启",
      checkError: "检查更新失败",
      retryDetail: (message) => `${message} · 将在下次启动时重试`,
      retry: "重试",
    },
  },
  shell: {
    sidebar: {
      newSession: "新建会话",
      stats: "统计",
      updatePendingTitle: "有更新待处理 — 详见设置 › 关于",
      updatePendingSrOnly: "（更新待处理）",
      searchPlaceholder: "搜索会话…",
      searchLabel: "搜索会话",
      clearSearch: "清除搜索",
      sessionsLabel: "会话",
      pinnedLabel: "置顶",
      noPinnedSessions: "没有置顶会话。",
      expandAll: "展开全部",
      collapseAll: "折叠全部",
      filterMenuLabel: "会话筛选",
      showAgentIcons: "显示智能体图标",
      agentGroup: "智能体",
      allAgents: "所有智能体",
      noPinnedProjects: "没有置顶项目。",
      pinProject: "置顶项目",
      unpinProject: "取消置顶项目",
      hideProject: "隐藏项目",
      unhideProject: "取消隐藏项目",
      hiddenLabel: "已隐藏",
      noHiddenProjects: "没有隐藏项目。",
      projectActions: "项目操作",
      absolutePath: "绝对路径",
      copyPath: "复制路径",
      noMatchingSessions: "没有匹配的会话。",
      noSessionsYet: "暂无会话。",
      newSessionIn: (cwd) => `在 ${cwd} 中新建会话`,
      newSessionWith: (label, cwd) => `在 ${cwd} 新建 ${label} 会话`,
      chooseAgentHint: "右键选择智能体",
      olderSessions: (count) => `更早（${count}）`,
      showMoreSessions: "显示更多",
      activeSessionsBadge: (count) => `${count} 进行中`,
      activeSessions: (count) => `${count} 个进行中的会话`,
    },
    sessionRow: {
      // Pass R: the remote-row server badge tooltip — name first, host after the dot.
      serverBadge: (name, host) =>
        host ? `远程服务器 ${name} · ${host}` : `远程服务器 ${name}`,
      openSession: (title) => `打开 ${title}`,
      sessionActions: "会话操作",
      expandSubagents: (count) => `展开 ${count} 个子代理`,
      collapseSubagents: (count) => `折叠 ${count} 个子代理`,
      subagentCount: (count, active) =>
        active > 0
          ? `组内 ${count} 个子代理 · ${active} 个活跃`
          : `组内 ${count} 个子代理`,
      detachedSubagent: "已脱离的子代理",
      threadKind: {
        subagent: "子代理",
        review: "审查",
        guardian: "守护",
        compact: "压缩",
      },
      branchTooltip: (branch) => `分支：${branch}`,
      state: {
        working: "进行中",
        waiting: "等待中",
        idle: "空闲",
        ended: "已结束",
      },
    },
    sessionMenu: {
      renameFieldLabel: "重命名会话",
      menuTitle: "会话菜单",
      pin: "置顶",
      unpin: "取消置顶",
      copySessionId: "复制 ID",
      diagnosticReport: "诊断",
      rename: "重命名",
      resume: "恢复",
      resuming: "恢复中…",
      fork: "复刻",
      forking: "复刻中…",
      endSession: "结束",
      openIn: "打开方式",
      resumeConfirmTitle: "恢复未记录模型的会话？",
      resumeConfirmBody:
        "该会话从未记录过模型 — 很可能在第一轮对话前就已出错 — 因此恢复时可能会因模型错误而失败。仍要继续吗？",
      resumeConfirmLabel: "仍然恢复",
      forkConfirmTitle: "复刻未记录模型的会话？",
      forkConfirmBody:
        "该会话从未记录过模型 — 很可能在第一轮对话前就已出错 — 因此复刻时可能会因模型错误而失败。仍要继续吗？",
      forkConfirmLabel: "仍然复刻",
      endConfirmTitle: "结束此会话？",
      endConfirmBody:
        "当前有一轮对话正在进行，将被中断。对话内容已保存，之后可恢复。",
      resumeTitleNoConversation: "无内容可恢复 — 该会话没有已保存的对话记录。",
      resumeTitlePending: "该会话刚刚退出，稍后即可恢复。",
      forkTitleNoConversation: "无内容可复刻 — 该会话没有已保存的对话记录。",
      endTitleLive: "结束此会话",
      endTitleUnavailable: "仅当会话处于本应用管理的活跃状态时才能结束。",
      comingSoonForAgent: (label: string) => `${label} 会话即将支持。`,
    },
    newSession: {
      ledeBefore: "在所选目录中启动",
      ledeGeneric: "，并通过实时终端驱动。",
      sessionSetup: "会话设置",
      agent: "智能代理",
      directory: "目录",
      choose: "选择…",
      noDirectoryChosen: "未选择目录",
      model: "模型",
      modelDefault: "默认",
      command: "命令",
      commandHint: "灰色部分固定不变，输入的参数会追加在后面。",
      argsPlaceholder: "额外参数…",
      savePreset: "保存为预设",
      presetNamePlaceholder: "预设名称…",
      presets: "预设",
      presetNone: "无（清除）",
      deletePreset: (name: string) => `删除预设 ${name}`,
      reservedArg: (token: string) => `${token} 由应用管理，不能在此传入。`,
      unbalancedQuote: "参数中的引号未闭合。",
      failedToStart: "会话启动失败",
      create: "创建",
      starting: "启动中…",
    },
    middleHeader: {
      viewGroupLabel: "视图",
      transcript: "记录",
    },
    footer: {
      keepAwake: "防止电脑休眠",
      letSleep: "允许电脑休眠",
      caffeinate: "保持唤醒",
      showTerminal: "显示终端",
      hideTerminal: "隐藏终端",
      terminal: "终端",
    },
    titlebar: {
      showSidebar: "显示侧边栏",
      hideSidebar: "隐藏侧边栏",
      showRightPanel: "显示右侧面板",
      hideRightPanel: "隐藏右侧面板",
    },
    gitReadout: {
      copyBranch: "复制分支",
    },
    sessionPanel: {
      heading: "会话",
      model: "模型",
      effort: "推理强度",
      branch: "分支",
      pr: "拉取请求",
      clock: "时长",
      compactions: "压缩次数",
      active: "活跃",
      tokensReclaimed: (tokens) => `已回收 ${tokens} 个词元`,
    },
    sessionList: {
      ungrouped: "（无项目）",
    },
    // S2：会话栏顶部的服务器区（ServerRailSection）。
    servers: {
      sectionTitle: "服务器",
      emptyState: "未保存服务器——在设置中添加",
      openTerminal: "打开终端",
      newTabToServer: "为此服务器新建标签",
      editInSettings: "在设置中编辑…",
      connect: "连接",
      disconnect: "断开连接",
      browseFiles: "浏览文件",
    },
  },
  /** 文件面板（pass F）。键位遵循 DESIGN_NOTES 骨架，另补面板自身文案所需的词。 */
  sftp: {
    pane: {
      title: "文件",
      serverLabel: "服务器",
    },
    empty: {
      noServers: "尚未添加服务器——在设置中保存一个即可浏览其文件。",
    },
    path: {
      edit: "编辑路径",
      invalid: "路径不存在",
    },
    tree: {
      empty: "没有子文件夹",
    },
    list: {
      empty: "空文件夹——拖入文件以上传",
      name: "名称",
      size: "大小",
      mtime: "修改时间",
      sortDirectionLabel: (asc) => (asc ? "升序" : "降序"),
    },
    menu: {
      open: "打开",
      download: "下载…",
      uploadHere: "上传到此处…",
      newFile: "新建文件…",
      newFolder: "新建文件夹…",
      rename: "重命名…",
      delete: "删除",
      copy: "拷贝",
      cut: "剪切",
      paste: "粘贴",
      cutHint: "已剪切",
      newFileDefault: "未命名.txt",
      newFolderDefault: "未命名文件夹",
      // pass I-a：服务器文件在编辑器面板的页签中打开。
      edit: "编辑",
    },
    confirm: {
      deleteTitle: (count) => `删除 ${count} 项？`,
      deleteBody: (count) => `将从服务器上删除 ${count} 项。`,
      deleteFolder: "将删除文件夹及其全部内容。",
    },
    conflict: {
      title: "名称已存在",
      uploadTitle: "上传冲突",
      pasteTitle: "粘贴冲突",
      uploadBody: "目标文件夹中已存在同名条目。",
      pasteBody: "目标中已存在同名条目。",
      count: (index, total) => `第 ${index + 1} / ${total} 项`,
      overwrite: "覆盖",
      skip: "跳过",
      rename: "重命名",
      renameShort: (candidate) => `重命名为 ${candidate}`,
      overwriteAll: "全部覆盖",
      skipAll: "全部跳过",
      applyAll: "应用到全部",
    },
    transfers: {
      title: "传输",
      done: "完成",
      canceled: "已取消",
      failed: "失败",
      cancel: "取消",
      retry: "重试",
      clearFinished: "清除已完成",
      connectionLost: "连接已断开",
    },
    lock: {
      reconnectedBanner: "已重连——刷新",
    },
  },
  /** 编辑器面板（pass I-a）：本地 fileio:* 与 SFTP readFile/writeFile 的停靠页签。 */
  editor: {
    pane: {
      title: "编辑器",
      tabListAria: "打开的文件",
      closeTabAria: (name) => `关闭 ${name}`,
    },
    empty: {
      hint: "打开一个文件",
      dropHint: "…或把本地文件拖到这里。",
      noServers: "尚未添加服务器——在设置中保存一个即可编辑其文件。",
    },
    open: {
      button: "打开",
      local: "本地…",
      server: "服务器…",
      serverLabel: "服务器",
      pathLabel: "路径",
      pathPlaceholder: "/绝对路径/file.md",
      open: "打开",
    },
    header: {
      localBadge: "本地",
      serverBadge: "SSH",
      opencodeBadge: "opencode",
      readOnly: "只读",
      modeEdit: "编辑",
      modePreview: "预览",
      previewUnavailable: "仅未改动的 .md 文件可预览。",
    },
    footer: {
      utf8: "UTF-8",
      lineCol: (line, col) => `第 ${line} 行，第 ${col} 列`,
      savedFlash: "已保存",
    },
    banner: {
      capped: "文件过大——已加载前 512 KB，编辑已禁用。",
    },
    binary: {
      title: "二进制文件",
      body: "该文件不是文本，在当前版本无法编辑。",
    },
    errors: {
      invalidPath: "请提供本机上的绝对路径。",
      forbiddenPath: "Code-by-wire 拒绝编辑自身的数据文件。",
      notFound: "找不到文件。",
      binary: "二进制文件，当前版本不可编辑。",
      pdfTooLarge: "PDF 超过 20 MB，未打开。",
      readFailed: (message) => `读取文件失败：${message}`,
      saveFailed: (message) => `保存失败：${message}`,
    },
    dirty: {
      title: "未保存的修改",
      body: (name) => `${name} 尚有未保存的修改，关闭前保存吗？`,
      save: "保存",
      discard: "放弃",
      cancel: "取消",
    },
  },
  terminal: {
    tabListAria: "终端",
    newTerminal: "新建终端",
    closeOthers: "关闭其他",
    closeAll: "关闭全部",
    defaultTitle: "终端",
    processExited: "进程已退出",
    spawnFailed: (message) => `终端启动失败：${message}`,
    // S2：SSH 标签的锁定遮罩状态。
    ssh: {
      connecting: "正在连接…",
      reconnecting: "正在重连…",
      droppedOverlay: "连接已断开",
      reconnect: "重新连接",
      reconnectFailed: (message) => `无法重连：${message}`,
    },
  },
  workspace: {
    emptyStates: {
      noSessions: "未找到 Claude Code 会话。",
      selectSession: "选择一个会话以打开。",
      sessionEndedTranscriptSoon: "会话已结束——转录功能即将推出。",
    },
    mode: {
      managed: {
        label: "托管",
        blurb:
          "由 Code-by-wire 启动并驱动。你可以在这里发送输入、中断或结束它。",
      },
      observed: {
        label: "观察中",
        blurb:
          "正在另一个终端或设备中运行。Code-by-wire 仅只读镜像其记录，你无法在此输入。恢复它即可接管。",
      },
    },
    observedTerminal: {
      endedBadge: "已结束",
      observedBadge: "观察中",
      endedBody: "该会话已结束，可将其重新唤醒。",
      observedBody: "该会话正在另一个终端中运行 — 此处为只读。",
      endedFooter: "恢复 = 接管操作 · 复刻 = 探索新分支",
      observedFooter: "复刻它以分出你自己的会话。",
    },
    resume: {
      failed: "恢复失败",
      aliveAgain: "该会话已重新激活。",
      couldNotResume: "无法恢复此会话。",
      couldNotFork: "无法复刻此会话。",
    },
    openIn: {
      finder: "访达",
      fileExplorer: "文件资源管理器",
      fileManager: "文件管理器",
    },
  },
  stats: {
    agentLabel: "智能代理",
    comingSoonFor: (label: string) => `${label} 统计——即将推出…`,
    clearDayFilter: "清除日期筛选",
    buildingHistory: "正在构建历史记录…",
    noUsage: "暂无使用记录。",
    shared: {
      unknownModel: "未知",
      tokensHeader: "词元",
      showMore: (n, total) => `再显示 ${n} 个（共 ${total} 个）`,
      rangeToday: "今天",
      range7d: "7天",
      range30d: "30天",
      range90d: "90天",
      rangeAll: "全部",
    },
    overview: {
      sessions: "会话",
      tokens: "词元",
      favoriteModel: "最常用模型",
      activeDays: "活跃天数",
      mostActiveDay: "最活跃日",
      longestSession: "最长会话",
      longestStreak: "最长连续",
      currentStreak: "当前连续",
      streakUnit: () => "天",
      contributions: "贡献",
      less: "少",
      more: "多",
      trailingYear: "最近 12 个月",
      tokensLabel: (value) => `${value} 个词元`,
      dayTokensAria: (day, tokens) => `${day}：${tokens}`,
    },
    models: {
      title: "每日词元用量",
      tooltipNoUsage: "暂无用量",
      total: "总计",
      inOut: (input, output) => `输入：${input} · 输出：${output}`,
    },
    projects: {
      title: "按项目",
      nameLabel: "项目",
    },
    sessions: {
      title: "按会话",
      colSession: "会话",
      colModel: "模型",
      colLastActivity: "最近活动",
      colDuration: "时长",
      colTurns: "轮次",
      copySessionId: "复制会话 ID",
    },
  },
  dock: {
    label: "活动",
    resizeAria: "调整活动面板高度",
    collapseAria: "收起活动面板",
    collapseTitle: "收起",
    expandAria: "展开活动面板",
    expandTitle: "展开",
    tabs: {
      tasks: "任务",
      subagents: "子代理",
      shells: "后台终端",
      monitors: "监控",
    },
    tally: (tasks, subagents, shells, monitors) =>
      `${tasks} 个任务 · ${subagents} 个子代理 · ${shells} 个后台终端 · ${monitors} 个监控`,
    status: {
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      killed: "已终止",
      stopped: "已停止",
      blocked: "阻塞",
    },
    aboutMetric: (title) => (title ? `关于${title}` : "关于此指标"),
    tokensUnit: "词元",
    tasks: {
      empty: "暂无任务。",
    },
    subagents: {
      empty: "暂无子代理。",
      drillAria: (type) => `查看 ${type} 子代理详情`,
      toolUse: "次工具调用",
      toolUses: "次工具调用",
      toolUsesAria: (n) => `${n} 次工具调用`,
    },
    shells: {
      empty: "暂无后台终端。",
      openLogAria: (command) => `打开 ${command} 的日志`,
      exitSuffix: (code) => `（退出码 ${code}）`,
      truncated: (kb) => `已隐藏 ${kb} KB 的早期输出`,
    },
    monitors: {
      empty: "暂无监控。",
      openDetailsAria: (command) => `打开 ${command} 的详情`,
    },
    pressure: {
      heading: "压力",
      info: "剩余多少余量：当前提示词的上下文占用超过窗口的比例，随后是本会话的速率限制窗口（已用百分比、重置倒计时——优先取会话自身的数据，会话未上报时用账户 API 数据补全）。Extra 为账户的付费额外用量额度。柱状条超过 70% 转琥珀色，超过 85% 转红色警戒。",
      noContext: "尚未采集到上下文数据。",
      contextUnit: "% 上下文",
      extra: "Extra",
      windowFiveHour: "5h",
      windowSevenDay: "7d",
      windowSevenDaySonnet: "7d S",
      windowSevenDayOpus: "7d O",
    },
    spend: {
      heading: "花费",
      info: "本会话已消耗的用量：按种类划分的词元总量——新输入、生成输出、缓存读取，以及 5 分钟和 1 小时的缓存写入。$ 是 Claude Code 自身的会话记账；在订阅方案下它是等价 API 价值，并非实际账单。",
      infoCodex:
        "本会话已消耗的用量：按种类划分的词元总量——新输入、生成输出与缓存读取。Codex 不提供费用记账，因此没有 $ 数值。",
      infoOpenCode:
        "本会话已消耗的用量：按种类划分的词元总量——新输入、生成输出与缓存读取。$ 来自 OpenCode 服务自身的会话记账，是实际的费用数值。",
      kinds: {
        input: {
          label: "输入",
          description: "本会话处理的新提示词的词元，按全价计费。",
        },
        output: {
          label: "输出",
          description: "模型生成的词元。",
        },
        cacheRead: {
          label: "缓存读取",
          description:
            "从缓存中回放、无需重新处理的上下文，价格约为输入的 10%。",
        },
        cacheWrite5m: {
          label: "缓存写入 5 分钟",
          description:
            "写入 5 分钟缓存的上下文，供下一轮低成本回放，价格为输入的 1.25 倍。",
        },
        cacheWrite1h: {
          label: "缓存写入 1 小时",
          description: "写入更长效的 1 小时缓存的上下文，价格为输入的 2 倍。",
        },
      },
    },
    duty: {
      heading: "占空比",
      info: "会话的占空比：会话生命周期中，API 请求实际在途的时间占比——模型工作的时间相对于会话保持打开的时间。自会话开始起累计，因此长时间空闲的会话即便当前正忙，读数也会偏低。",
      apiUnit: "% api",
    },
    throughput: {
      heading: "吞吐量",
      info: "最近 60 秒内活跃生成的词元吞吐量。走势图描绘近期样本的总词元/秒；轮次之间的空闲间隙不计入统计。",
      idle: "空闲",
      input: "输入",
      output: "输出",
      windowLabel: "60秒",
    },
  },
  transcript: {
    noneObserved: "该会话在磁盘上还没有记录。",
    noneManaged: "暂无记录 — 请在终端标签页中操作该会话。",
    noneSubagent: "该子代理在磁盘上还没有记录。",
    waitingHeading: "等待你的操作",
    waitingFallback: "等待你的输入",
    you: "你",
    claude: "Claude",
    thinking: "思考中",
    toolRunning: "运行中…",
    toolNoOutput: "无输出",
    toolOutputLines: (n) => `${n} 行`,
    viewToolOutput: (name) => `查看 ${name} 的输出`,
    viewDiff: (tool, file) => `查看 ${tool} 对 ${file} 的改动`,
    subagentLabel: "子代理",
    session: "会话",
    subagentCrumb: (type, description) =>
      description ? `子代理（${type}）：${description}` : `子代理（${type}）`,
  },
  modals: {
    shellTitle: "后台终端详情",
    monitorTitle: "监控详情",
    detail: {
      status: "状态",
      runtime: "运行时长",
      command: "命令",
      script: "脚本",
      output: "输出",
    },
    turnStatus: {
      ok: "通过",
      error: "失败",
      pending: "运行中",
    },
    // 转录→编辑器入口（I-b）：仅当工具输入就是一个位于会话目录下的绝对路径时出现，不做启发式猜测。
    openInEditor: "在编辑器中打开",
    toolResult: {
      loading: "正在加载输出…",
      loadError: "输出加载失败。",
      runningNoOutput: "运行中 — 暂无输出。",
      copyOutput: "复制输出",
    },
    diff: {
      noChanges: "无更改",
      copyPath: "复制路径",
      copyDiff: "复制改动",
    },
    outputBox: {
      reading: "正在读取输出…",
      unavailable: "无可用输出",
    },
    diagnostic: {
      title: "诊断报告",
      privacy: "仅包含元数据 — 不含消息、代码、文件内容或原始错误消息。",
      loading: "正在生成报告…",
      loadError: "无法生成此报告。",
      retry: "重试",
      download: "下载",
      saving: "正在保存…",
      saved: "已保存",
      copyError: "无法复制报告。",
      saveError: "无法保存报告。",
    },
  },
  time: {
    ago: (ms, now) => {
      const s = Math.max(0, Math.round((now - ms) / 1000));
      if (s < 8) return "刚刚";
      if (s < 60) return `${s}秒前`;
      const m = Math.round(s / 60);
      if (m < 60) return `${m}分钟前`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}小时前`;
      return `${Math.floor(h / 24)}天前`;
    },
    countdown: (resetsAt, now) => {
      const ms = resetsAt - now;
      if (ms <= 0) return "现在";
      const totalMin = Math.floor(ms / 60_000);
      const d = Math.floor(totalMin / 1440);
      const h = Math.floor((totalMin % 1440) / 60);
      const m = totalMin % 60;
      if (d > 0) return h > 0 ? `${d}天${h}小时` : `${d}天`;
      if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`;
      if (m > 0) return `${m}分`;
      return "不足1分";
    },
    duration: (ms) => {
      if (!Number.isFinite(ms) || ms <= 0) return "0秒";
      if (ms < 1000) return (ms / 1000).toFixed(1) + "秒";
      const totalSec = Math.round(ms / 1000);
      if (totalSec < 60) return `${totalSec}秒`;
      const totalMin = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      if (totalMin < 60) return s > 0 ? `${totalMin}分${s}秒` : `${totalMin}分`;
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      return m > 0 ? `${h}小时${m}分` : `${h}小时`;
    },
    tps: (tps) => {
      if (!Number.isFinite(tps) || tps <= 0) return "0 词元/秒";
      if (tps >= 1000) return (tps / 1000).toFixed(1) + "k 词元/秒";
      return tps.toFixed(1) + " 词元/秒";
    },
    tpsValue: (tps) => {
      if (!Number.isFinite(tps) || tps <= 0) return "0";
      if (tps >= 1000) return (tps / 1000).toFixed(1) + "k";
      return tps.toFixed(1);
    },
    tpsUnit: "词元/秒",
    dayShort: (day) => {
      const [, m, d] = day.split("-").map(Number);
      return `${m}月${d}日`;
    },
    dayLong: (day) => {
      const [y, m, d] = day.split("-").map(Number);
      return `${y}年${m}月${d}日`;
    },
    monthShort: (day) => {
      const [, m] = day.split("-").map(Number);
      return `${m}月`;
    },
    // Codex-only, delegated (not re-implemented): same fixed-width technical shorthand as
    // windowFiveHour/windowSevenDay above, kept identical across locales.
    windowLabel: (minutes) => formatWindowLabel(minutes),
  },
  numbers: {
    // Chinese groups large numbers by powers of 10^4 (万 = 10,000, 亿 = 100,000,000),
    // not 10^3 like en's k/M — mirrors formatTokensShort/formatTokensAxis's own
    // structure (same promotion-boundary formula, scaled to the 万/亿 grouping) rather
    // than reusing the shared helpers, since the division itself differs, not just the
    // unit suffix.
    tokensShort: (n) => {
      if (!Number.isFinite(n) || n <= 0) return "0";
      if (n >= 99_999_500) return (n / 100_000_000).toFixed(2) + "亿";
      if (n >= 10_000) return (n / 10_000).toFixed(1) + "万";
      return String(Math.round(n));
    },
    tokensAxis: (n) => {
      if (!Number.isFinite(n) || n <= 0) return "0";
      const trim = (s: string) => s.replace(/\.?0+$/, "");
      if (n >= 99_999_500) return trim((n / 100_000_000).toFixed(2)) + "亿";
      if (n >= 10_000) return trim((n / 10_000).toFixed(1)) + "万";
      return String(Math.round(n));
    },
  },
};
