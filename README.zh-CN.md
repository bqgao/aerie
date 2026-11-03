# <img src="build/icon.svg" alt="" height="56" align="center"> Aerie

[English](README.md) | 简体中文

一个面向编码智能体的桌面驾驶舱。Aerie 会读取本机已经在运行的
[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex](https://developers.openai.com/codex/cli)
与 [opencode](https://opencode.ai) 会话 —— 转录、遥测、终端 —— 并让你在一个窗口里统一驱动它们。

> **Fork 说明。** Aerie 是 [luojiahai/code-by-wire](https://github.com/luojiahai/code-by-wire)（MIT）
> 的个人 fork。上游项目是整套架构的基础，值得绝大部分功劳；本 fork 重新做了品牌与图标、按本机
> 的 macOS/Windows 使用场景重新打包，并叠加了下面列出的改动。

![Aerie：左侧会话栏、转录与遥测面板](docs/assets/cbw-screenshot.png)

## 它能做什么

打开应用，本机所有正在运行的智能体会话就已经在左侧栏里了 —— 按项目分组、可搜索、每行标注实时状态。

- **一个会话栏装下全部。** 按项目分组、可折叠、可搜索，每行带实时状态标记。
- **驱动、复刻、恢复，或者只是旁观。** 在内嵌终端里新开会话、复刻运行中的会话、恢复在别处启动的
  会话，或以只读方式旁观。
- **完整转录。** 每条消息、工具调用与结果都从磁盘重建并清晰渲染 —— 并支持全机器转录的全文搜索。
- **完整遥测。** 上下文压力、花费、token 吞吐、占空比、git 状态、任务、子智能体、后台 shell，
  逐会话实时呈现。
- **全局视角。** 跨会话的统计页，含一年贡献日历。
- **额度一目了然。** 账户的速率限制窗口直接读盘，带重置倒计时。

## 本 fork 的改动

- **Aerie 品牌与图标。** 新图标（米白纸感底 + 墨青猛禽头符号）以 824/1024 网格 `.icns` 分发，
  保证 macOS ≤ 15 的访达/Dock 观感与原生图标一致；全出血版本保留为 macOS 26（Tahoe）的逃生口。
- **删除会话记录。** 会话菜单与项目文件夹都能把已结束会话从列表移除：墓碑表防止下次同步复活，
  搜索索引同步清理；之后从 CLI 恢复该会话时会自动重新出现（有意为之）。转录文件保留在磁盘上。
- **在访达中显示。** 项目行可直接打开其文件夹，会话行可直接定位转录文件，便于从源头清理测试项目。
- **右键菜单不再溢出。** 会话菜单按视口钳制位置（先翻转、再滑入）并支持滚动，不再伸出窗口底部。
- **纯本地打包。** 没有更新服务器、没有发布目标：`pnpm dist` / `pnpm dist:win` 产出的安装包由你自行安装。

## 安装

| 平台                  | 产物                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| macOS · Apple Silicon | [`Aerie-arm64.dmg`](https://github.com/bqgao/aerie/releases/latest/download/Aerie-arm64.dmg)             |
| Windows · x64         | [`Aerie-Setup-x64.exe`](https://github.com/bqgao/aerie/releases/latest/download/Aerie-Setup-x64.exe)     |
| Windows · ARM64       | [`Aerie-Setup-arm64.exe`](https://github.com/bqgao/aerie/releases/latest/download/Aerie-Setup-arm64.exe) |

本地构建的应用**未签名**。macOS 首次打开可能需要右键 → **打开**，或执行
`xattr -dr com.apple.quarantine /Applications/Aerie.app`；Windows 上 SmartScreen 会拦截，
点 **更多信息 → 仍要运行**。

需要本机已安装 Claude Code 和/或 Codex，否则没有可观察、可控制的会话。

## 从源码构建

需要 Node 24 与 pnpm。

```sh
pnpm install
pnpm rebuild:native   # 针对 Electron 的 ABI 重建 better-sqlite3 + node-pty
pnpm dev              # 启动应用
```

```sh
pnpm dist             # macOS：产出 release/Aerie-arm64.dmg（含 zip）
pnpm dist:win         # Windows：产出 release/Aerie-Setup-{x64,arm64}.exe
```

**在 macOS 上交叉构建 Windows 安装包。** `electron-builder.yml` 设了 `npmRebuild: false`
（原生模块手动重建，因为 electron-builder 自带的重建在 pnpm 下会出问题），所以 Windows 包会
继承宿主机的 `better_sqlite3.node`，在 Windows 上启动即崩。先暂存目标平台预编译，打完再恢复：

```sh
cd node_modules/better-sqlite3
pnpm exec prebuild-install --runtime electron --target 41.7.2 --arch x64 --platform win32
cd ../..
pnpm exec electron-builder --win --x64 --publish never
pnpm rebuild:native   # 恢复 darwin 二进制
```

`node-pty` 无需暂存：它随包附带全平台 `prebuilds/`，加载失败时会从 `build/Release` 回退到
`prebuilds/<platform>-<arch>`。

## 检查

```sh
pnpm test          # vitest：tests/**/*.test.ts
pnpm typecheck     # node 与 web 两个工程各跑一次 tsc
pnpm lint          # eslint
pnpm format:check  # prettier
```

## 架构

Electron 三进程：

- **主进程** —— 只做请求/响应：没有后台定时器、没有 `fs.watch`，由渲染层轮询。各 provider
  （`claude`、`codex`、`opencode`）按需从磁盘读会话与转录。
- **解析 worker** —— 懒启动的 `utilityProcess`，把轮询驱动的转录解析搬离主线程，worker 故障时
  降级为进程内执行。
- **渲染层** —— React 19 + Tailwind 4 + xterm；`preload` 只暴露一个 `window.api`。

共享类型、IPC 通道名与智能体注册表都在 `src/shared/`（`@shared/*`）。侧栏的所有界面都以注册表里的
`AgentCapabilities` 为开关，从不判断具体 agent id。

## 许可证

[MIT](LICENSE) —— © 2026 luojiahai（上游），© 2026 bqgao（本 fork）。

`website/` 目录是上游的官网工程，仅作参考保留，不从本仓库部署。
