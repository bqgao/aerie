import { describe, it, expect, beforeEach } from "vitest";
import {
  $appTheme,
  $appThemeSetting,
  $terminalTheme,
  applyAppThemeSetting,
  resolveAppThemeSetting,
} from "../../src/renderer/src/ui/appearance-store";

describe("appearance-store", () => {
  beforeEach(() => {
    // Reset to the module's own default between tests — the DOM-side-effect subscription is global.
    $appTheme.set("dark");
    $appThemeSetting.set("dark");
    $terminalTheme.set("dark");
  });

  it("$appTheme defaults to dark", () => {
    expect($appTheme.get()).toBe("dark");
  });

  it("resolveAppThemeSetting passes concrete themes through and maps system onto the OS preference", () => {
    expect(resolveAppThemeSetting("dark", true)).toBe("dark");
    expect(resolveAppThemeSetting("dark", false)).toBe("dark");
    expect(resolveAppThemeSetting("light", true)).toBe("light");
    expect(resolveAppThemeSetting("light", false)).toBe("light");
    expect(resolveAppThemeSetting("system", true)).toBe("dark");
    expect(resolveAppThemeSetting("system", false)).toBe("light");
  });

  it("applyAppThemeSetting records the choice and resolves it into $appTheme", () => {
    // jsdom's matchMedia reports matches=false — "system" therefore resolves light here.
    applyAppThemeSetting("system");
    expect($appThemeSetting.get()).toBe("system");
    expect($appTheme.get()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    applyAppThemeSetting("dark");
    expect($appThemeSetting.get()).toBe("dark");
    expect($appTheme.get()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("$terminalTheme is independent of $appTheme", () => {
    $appTheme.set("light");
    expect($terminalTheme.get()).toBe("dark");
  });

  it("setting $appTheme updates document.documentElement's data-theme and color-scheme", () => {
    $appTheme.set("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");

    $appTheme.set("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("setting $terminalTheme updates document.documentElement's data-terminal-theme, independent of data-theme/color-scheme", () => {
    // Regression test for the terminal-retheme fix: index.css's terminal-pane chrome
    // (--terminal-editor-surface-background/--terminal-well-background) reads this attribute, not
    // data-theme, so it must move independently of App theme's own attribute/colorScheme writes.
    $appTheme.set("dark");
    $terminalTheme.set("light");
    expect(document.documentElement.dataset.terminalTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    $terminalTheme.set("dark");
    expect(document.documentElement.dataset.terminalTheme).toBe("dark");
  });
});
