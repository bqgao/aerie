import "../api.d.ts";

import { atom } from "nanostores";
import type { AppThemeSetting } from "@shared/ipc";

export type AppearanceMode = "dark" | "light";

/** Resolve a theme SETTING to the concrete chrome theme: "system" defers to the OS preference.
 *  Pure on purpose — the matchMedia read is injected so tests stay deterministic. */
export function resolveAppThemeSetting(
  setting: AppThemeSetting,
  prefersDark: boolean,
): AppearanceMode {
  if (setting === "system") return prefersDark ? "dark" : "light";
  return setting;
}

/** The user's theme CHOICE (persisted). The DOM never reads this directly — it reads the
 *  resolved $appTheme below, so "system" tracks the OS live. */
export const $appThemeSetting = atom<AppThemeSetting>("dark");

/** The app chrome's RESOLVED theme (panels, sidebar, settings, markdown code blocks). Independent of
 *  $terminalTheme below — see the 2026-07-14 light-theme design doc. Defaults to "dark" (matching
 *  the main-process settings store's own default) until the initial IPC read resolves. */
export const $appTheme = atom<AppearanceMode>("dark");

/** The terminal panels' theme (the interactive shell rail + the observed Claude-session terminal),
 *  independent of $appTheme — a user can run e.g. a light app with a dark terminal. */
export const $terminalTheme = atom<AppearanceMode>("dark");

/** One live read of the OS preference. jsdom provides matchMedia (matches always false); guard
 *  anyway so this module stays importable from plain node tests. */
const prefersDarkColors = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Apply a theme setting: record the choice, resolve it against the current OS preference
 *  (no-op for concrete themes), and let $appTheme's DOM subscription do the repaint. */
export function applyAppThemeSetting(setting: AppThemeSetting): void {
  $appThemeSetting.set(setting);
  $appTheme.set(resolveAppThemeSetting(setting, prefersDarkColors()));
}

/** Set the app theme: updates the reactive value immediately (every subscriber repaints/re-themes
 *  on this tick) and persists it in the background. */
export function setAppTheme(setting: AppThemeSetting): void {
  applyAppThemeSetting(setting);
  void window.api.setAppTheme(setting);
}

/** Set the terminal theme — same shape as setAppTheme, independent setting. */
export function setTerminalTheme(mode: AppearanceMode): void {
  $terminalTheme.set(mode);
  void window.api.setTerminalTheme(mode);
}

/** Typora-style theme for the reading surfaces (transcript + markdown preview). */
export type ReadingThemeSetting = "default" | "github";
export const $readingTheme = atom<ReadingThemeSetting>("default");

/** Set the reading-surface theme — same shape as setTerminalTheme, independent setting. */
export function setReadingTheme(theme: ReadingThemeSetting): void {
  $readingTheme.set(theme);
  void window.api.setReadingTheme(theme);
}

// Module-scope, not a React effect: both the initial hydration and the DOM side effect below must
// run exactly once per renderer lifetime, regardless of how many components subscribe. Guarded so
// this module stays importable from node-run tests (no window) and jsdom tests (no window.api,
// since no preload ran there) — mirrors shell-terminal/store.ts's storedBoolean/persistBoolean guards.
if (typeof window !== "undefined" && window.api) {
  void window.api.getAppTheme().then(applyAppThemeSetting);
  void window.api
    .getTerminalTheme()
    .then((mode: AppearanceMode) => $terminalTheme.set(mode));
  void window.api
    .getReadingTheme()
    .then((theme: ReadingThemeSetting) => $readingTheme.set(theme));

  // "system" must track the OS live: flip the resolved theme when the preference changes,
  // without touching the persisted choice. Concrete themes ignore the stream.
  if (typeof window.matchMedia === "function") {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      if ($appThemeSetting.get() === "system") {
        $appTheme.set(resolveAppThemeSetting("system", mq.matches));
      }
    };
    mq.addEventListener?.("change", onChange);
  }
}

if (typeof document !== "undefined") {
  $appTheme.subscribe((mode) => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
  });
  // Terminal theme is JS-only otherwise — use-terminal-session.ts/xterm-factory.ts subscribe
  // $terminalTheme to re-theme their own Terminal instances, but nothing mirrors it into the DOM, so
  // CSS has no way to tell the two themes apart. A handful of CSS surfaces need to follow Terminal
  // theme instead of App theme (the terminal pane's own chrome + the observed-session terminal's
  // container — see index.css's --terminal-editor-surface-background/--terminal-well-background),
  // so mirror $appTheme's own data-theme pattern with a second, independent attribute. No
  // colorScheme write here — that's a document-wide (native form controls/scrollbars) concern that
  // belongs to App theme alone.
  $terminalTheme.subscribe((mode) => {
    document.documentElement.dataset.terminalTheme = mode;
  });
  // Reading theme is CSS-only: index.css scopes the GitHub-Light reading palette
  // to `[data-reading-theme="github"] .reading-surface` (transcript + preview).
  $readingTheme.subscribe((theme) => {
    document.documentElement.dataset.readingTheme = theme;
  });
}
