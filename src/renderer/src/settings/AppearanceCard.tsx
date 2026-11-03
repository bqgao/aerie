import { useStore } from "@nanostores/react";
import {
  $appThemeSetting,
  $readingTheme,
  $terminalTheme,
  setAppTheme,
  setReadingTheme,
  setTerminalTheme,
  type AppearanceMode,
  type ReadingThemeSetting,
} from "../ui/appearance-store";
import type { AppThemeSetting } from "@shared/ipc";
import { SegmentedSwitch } from "../ui/SegmentedSwitch";
import { Card } from "../shell/page-primitives";
import { useI18n } from "../i18n";
import { LanguagePicker } from "./LanguagePicker";

/**
 * The "Appearance" card in Settings: the Language picker (first row, hermes parity)
 * plus two independent theme controls — the app chrome (Follow System / Dark / Light)
 * and the terminal panels (Dark / Light). Reads/writes the shared nanostores directly
 * (no props from App.tsx).
 */
export function AppearanceCard() {
  const { t } = useI18n();
  const appThemeSetting = useStore($appThemeSetting);
  const terminalTheme = useStore($terminalTheme);
  const readingTheme = useStore($readingTheme);
  // In-render (not module-scope): the labels must re-resolve per locale switch.
  // The app-theme row is the SETTING (three-way, incl. "system"); the terminal row is a
  // concrete two-way choice (a terminal that follows the OS theme independently reads
  // oddly — the xterm themes are hand-tuned per palette).
  const appThemeOptions = [
    {
      value: "system" as const,
      label: t.settings.appearance.system,
      icon: "monitor" as const,
    },
    {
      value: "dark" as const,
      label: t.settings.appearance.dark,
      icon: "moon" as const,
    },
    {
      value: "light" as const,
      label: t.settings.appearance.light,
      icon: "sun" as const,
    },
  ];
  const terminalOptions = [
    {
      value: "dark" as const,
      label: t.settings.appearance.dark,
      icon: "moon" as const,
    },
    {
      value: "light" as const,
      label: t.settings.appearance.light,
      icon: "sun" as const,
    },
  ];

  return (
    <Card title={t.settings.appearance.title}>
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="text-body text-fg">
            {t.settings.appearance.language}
          </div>
          <div className="mt-0.5 text-meta text-fg-faint">
            {t.settings.appearance.languageDesc}
          </div>
        </div>
        <LanguagePicker />
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-ink-850 px-4 py-3">
        <div className="min-w-0">
          <div className="text-body text-fg">
            {t.settings.appearance.appTheme}
          </div>
          <div className="mt-0.5 text-meta text-fg-faint">
            {t.settings.appearance.appThemeDesc}
          </div>
        </div>
        <SegmentedSwitch<AppThemeSetting>
          ariaLabel={t.settings.appearance.appTheme}
          value={appThemeSetting}
          onChange={setAppTheme}
          options={appThemeOptions}
        />
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-ink-850 px-4 py-3">
        <div className="min-w-0">
          <div className="text-body text-fg">
            {t.settings.appearance.readingTheme}
          </div>
          <div className="mt-0.5 text-meta text-fg-faint">
            {t.settings.appearance.readingThemeDesc}
          </div>
        </div>
        <SegmentedSwitch<ReadingThemeSetting>
          ariaLabel={t.settings.appearance.readingTheme}
          value={readingTheme}
          onChange={setReadingTheme}
          options={[
            {
              value: "default" as const,
              label: t.settings.appearance.readingDefault,
            },
            {
              value: "github" as const,
              label: t.settings.appearance.readingGithub,
            },
          ]}
        />
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-ink-850 px-4 py-3">
        <div className="min-w-0">
          <div className="text-body text-fg">
            {t.settings.appearance.terminalTheme}
          </div>
          <div className="mt-0.5 text-meta text-fg-faint">
            {t.settings.appearance.terminalThemeDesc}
          </div>
        </div>
        <SegmentedSwitch<AppearanceMode>
          ariaLabel={t.settings.appearance.terminalTheme}
          value={terminalTheme}
          onChange={setTerminalTheme}
          options={terminalOptions}
        />
      </div>
    </Card>
  );
}
