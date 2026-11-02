import type { ToolFileTarget } from "./tool-file-link";
import { openLocalPath } from "../shell/editor/editor-actions";
import { openServerInEditor } from "../shell/editor/editor-actions";
import { useI18n } from "../i18n";

/** The transcript's "Open in editor" affordance (pass I-b): rendered only where the resolver
 *  answered a target — no disambiguation menu, no search dialog (the binding scope says the
 *  affordance OFFERS exactly what resolves, never a heuristic hunt). Clicking opens the
 *  editor tab through the same actions the SFTP pane's context menu uses, so the PDF vs
 *  textarea routing, the in-band "not found" empty state, and the origin badge all ride the
 *  existing editor plumbing. Visually it IS the border-button grammar of the Copy / Copy
 *  output buttons it sits beside. */
export function OpenInEditorButton({ target }: { target: ToolFileTarget }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => {
        void (target.kind === "local"
          ? openLocalPath(target.path)
          : openServerInEditor(target.serverId, target.path));
      }}
      className="rounded-sm border px-2 py-0.5 text-label transition-colors border-ink-700 text-fg-muted hover:border-ink-600 hover:text-fg"
    >
      {t.modals.openInEditor}
    </button>
  );
}
