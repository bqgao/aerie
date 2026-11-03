# <img src="build/icon.svg" alt="" height="56" align="center"> Aerie

English | [简体中文](README.zh-CN.md)

A desktop cockpit for coding agents. Aerie watches the [Claude Code](https://docs.anthropic.com/en/docs/claude-code),
[Codex](https://developers.openai.com/codex/cli) and [opencode](https://opencode.ai) sessions already running on your
machine — transcripts, telemetry, terminals — and lets you drive them from one window.

> **Fork notice.** Aerie is a personal fork of
> [luojiahai/code-by-wire](https://github.com/luojiahai/code-by-wire) (MIT). The upstream app is the
> foundation; this fork re-brands it, rebuilds it for local macOS/Windows use, and layers on the
> changes listed under [What this fork changes](#what-this-fork-changes). Upstream is the original
> work and deserves the credit for the architecture it provides.

![Aerie: a live session with the session rail, transcript, and telemetry panels](docs/assets/cbw-screenshot.png)

## What it does

Open the app and every agent session already running on your machine is in the rail — grouped by
project, searchable, each flagging its live state.

- **Every session in one rail.** Grouped by project, collapsible, searchable, with a live state
  badge per row.
- **Drive, fork, resume, or just watch.** Spawn a session in an embedded terminal, fork a live one,
  resume one you started elsewhere, or observe read-only.
- **The full transcript.** Every message, tool call, and result reconstructed from disk and rendered
  cleanly — plus full-text search across every transcript on the machine.
- **The full telemetry.** Context pressure, spend, token throughput, duty cycle, git state, tasks,
  subagents, and background shells, live per session.
- **The whole story.** A cross-session Stats view with a year-long contributions calendar.
- **Your rate limits in view.** The account's rate-limit windows, read from disk, with reset
  countdowns.

## What this fork changes

- **Aerie branding and icon.** New app icon (ink-teal raptor mark on an ivory paper tile) shipped as
  a 824/1024-grid `.icns` for Finder/Dock on macOS ≤ 15, with the full-bleed render kept as the
  macOS 26 (Tahoe) escape hatch.
- **Delete session records.** The session menu and each project folder can dismiss ended sessions:
  a tombstone table keeps the next sync from re-adding them, their search rows are purged, and a
  transcript resumed later from the CLI comes back on purpose. Transcripts stay on disk.
- **Reveal in Finder.** Project rows and session rows can open their folder / transcript file
  directly, so a dead test project can be cleaned up at the source.
- **Context menus that fit.** The session menu clamps to the viewport (flip, then slide) and
  scrolls past a viewport-height cap instead of running off the bottom of the window.
- **Local-first packaging.** No update server, no publish target: `pnpm dist` / `pnpm dist:win`
  produce installers you run yourself. (The upstream release workflow that built signed installers
  in CI is removed here — it needs an Apple Developer ID and repository secrets this fork doesn't
  have, so builds are local.)

## Install

| Platform              | Artifact                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| macOS · Apple Silicon | [`Aerie-arm64.dmg`](https://github.com/bqgao/aerie/releases/latest/download/Aerie-arm64.dmg)             |
| Windows · x64         | [`Aerie-Setup-x64.exe`](https://github.com/bqgao/aerie/releases/latest/download/Aerie-Setup-x64.exe)     |
| Windows · ARM64       | [`Aerie-Setup-arm64.exe`](https://github.com/bqgao/aerie/releases/latest/download/Aerie-Setup-arm64.exe) |

Locally built apps are **unsigned**. On macOS the first launch may need right-click → **Open**, or
`xattr -dr com.apple.quarantine /Applications/Aerie.app`. On Windows, SmartScreen warns: click
**More info → Run anyway**.

You need Claude Code and/or Codex installed locally, so there are sessions to observe and control.

## Build from source

Requires Node 24 and pnpm.

```sh
pnpm install
pnpm rebuild:native   # better-sqlite3 + node-pty against Electron's ABI
pnpm dev              # launch the app
```

```sh
pnpm dist             # macOS: release/Aerie-arm64.dmg (+ zip)
pnpm dist:win         # Windows: release/Aerie-Setup-{x64,arm64}.exe
```

**Cross-building Windows installers on macOS.** `electron-builder.yml` sets `npmRebuild: false`
(native modules are rebuilt by hand because electron-builder's own rebuild misbehaves under pnpm),
so a Windows build inherits the host's `better_sqlite3.node` and crashes at startup. Stage the
target prebuild first, then restore the host's binaries afterwards:

```sh
cd node_modules/better-sqlite3
pnpm exec prebuild-install --runtime electron --target 41.7.2 --arch x64 --platform win32
cd ../..
pnpm exec electron-builder --win --x64 --publish never
pnpm rebuild:native   # restore darwin binaries
```

`node-pty` needs no staging: it bundles `prebuilds/` for every platform and its loader falls back
from `build/Release` to `prebuilds/<platform>-<arch>`.

## Checks

```sh
pnpm test          # vitest: tests/**/*.test.ts
pnpm typecheck     # tsc for the node and web projects
pnpm lint          # eslint
pnpm format:check  # prettier
```

## Architecture

Electron, three processes:

- **Main** — request/response only: no background timers, no `fs.watch`; the renderer polls.
  Providers (`claude`, `codex`, `opencode`) read sessions and transcripts off disk on demand.
- **Parse worker** — a lazily forked `utilityProcess` hosting poll-driven transcript parsing off the
  main thread, degrading to in-process code on worker fault.
- **Renderer** — React 19 + Tailwind 4 + xterm. `preload` exposes a single `window.api`.

Shared types, IPC channel names and the agent registry live in `src/shared/` (`@shared/*`). The
sidebar gates every surface on `AgentCapabilities` from that registry, never on an agent id.

## License

[MIT](LICENSE) — © 2026 luojiahai (upstream), © 2026 bqgao (this fork).

The `website/` directory is the upstream marketing site, kept for reference; it is not deployed from
this repository.
