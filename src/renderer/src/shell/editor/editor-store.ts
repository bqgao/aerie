/**
 * The Editor pane's live store (pass I-a). Session-lifetime in-memory only (IDE_SPEC "Tabs":
 * NOT persisted across app relaunch; no revival contract) — the atoms hold the whole tab
 * family plus the active selection; pure rules live in editor-model.ts; this file owns the
 * atoms + the write paths. Window-guarded like the other shell stores (nanostores atoms are
 * window-stack-independent in practice; tests reset via the exported setters).
 */
import { atom } from "nanostores";
import type { EditorOrigin, EditorTab } from "./editor-model";
import {
  applyRead,
  applySaved,
  setDraft,
  setMode,
  reduceTabs,
} from "./editor-model";

/** The Editor pane's id in the panes registry (layout.ts also registers the defaults). */
export const EDITOR_PANE_ID = "editor";

/** The tab family, in open order (append-only; closing splices). */
export const $editorTabs = atom<readonly EditorTab[]>([]);
/** The selected tab id (null = the pane shows its empty state). */
export const $editorActiveId = atom<string | null>(null);

export function openEditorTab(origin: EditorOrigin): void {
  const reduced = reduceTabs($editorTabs.get(), $editorActiveId.get(), {
    op: "open",
    origin,
  });
  $editorTabs.set(reduced.tabs);
  $editorActiveId.set(reduced.activeId);
}

export function activateEditorTab(id: string): void {
  $editorActiveId.set(id);
}

/** The pure close; the pane decides whether the CLOSE-DIRTY confirm rides first. */
export function closeEditorTab(id: string): void {
  const reduced = reduceTabs($editorTabs.get(), $editorActiveId.get(), {
    op: "close",
    id,
  });
  $editorTabs.set(reduced.tabs);
  $editorActiveId.set(reduced.activeId);
}

/** Find one tab's live record (the pane reads the SAME object identity out of $editorTabs). */
export function editorTabOf(id: string): EditorTab | undefined {
  return $editorTabs.get().find((tab) => tab.id === id);
}

function updateTab(tabId: string, fn: (tab: EditorTab) => EditorTab): void {
  $editorTabs.set(
    $editorTabs.get().map((tab) => (tab.id === tabId ? fn(tab) : tab)),
  );
}

/** A read verdict lands on its tab (the pane awaits the IPC and calls this). */
export function applyTabRead(
  tabId: string,
  read: Parameters<typeof applyRead>[1],
): void {
  updateTab(tabId, (tab) => applyRead(tab, read));
}

export function setTabDraft(tabId: string, draft: string): void {
  updateTab(tabId, (tab) => setDraft(tab, draft));
}

export function applyTabSaved(
  tabId: string,
  saved: Parameters<typeof applySaved>[1],
): void {
  updateTab(tabId, (tab) => applySaved(tab, saved));
}

export function setTabMode(tabId: string, mode: "edit" | "preview"): void {
  updateTab(tabId, (tab) => setMode(tab, mode));
}
