/**
 * The SFTP pane's modal dialogs (pass F) — built on ModalShell (no new container paradigms):
 * the NAME conflict resolver (Overwrite / Skip / Rename with a name-2 auto-suffix preview) and
 * the name prompt (New File / New Folder / Rename all ride it). The conflict policy's RULES live
 * in sftp-model.ts; these components own capture/translation only.
 */
import { useEffect, useState } from "react";
import { cx, focusRing } from "../../ui/atoms";
import { ModalShell } from "../../ui/ModalShell";
import { useI18n } from "../../i18n";
import { renameSuggestion } from "./sftp-model";

/** The dialog buttons' shared grammar (ConfirmDialog's two-tone set, compiled here for the
 *  three-way row — a small extension, not a new visual language). */
const DIALOG_ACTION =
  "rounded-md px-3 py-1.5 text-body font-medium ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2";
const DIALOG_CONFIRM = cx(
  focusRing,
  `${DIALOG_ACTION} bg-primary text-ink-950 ring-primary/40 hover:bg-primary-bright`,
);
const DIALOG_PLAIN = cx(
  focusRing,
  DIALOG_ACTION,
  "text-fg-muted ring-ink-700 hover:text-fg",
);

export type ConflictChoice = "overwrite" | "skip" | "rename";

export interface ConflictResolution {
  perName: Record<string, ConflictChoice>;
}

/** One name at a time (a tiny wizard): Overwrite / Skip / Rename advance to the next colliding
 *  name; "Apply to all" collapses the rest with the SAME choice; quitting skips the remainder. */
export function ConflictDialog({
  title,
  names,
  exists,
  onDone,
}: {
  title: string;
  names: readonly string[];
  exists: (candidate: string) => boolean;
  onDone: (resolution: ConflictResolution | null) => void;
}) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const [resolution, setResolution] = useState<Record<string, ConflictChoice>>(
    {},
  );
  const applyOne = (choice: ConflictChoice): void => {
    const next = { ...resolution, [names[index]]: choice };
    setResolution(next);
    setIndex(index + 1);
  };
  const applyAll = (choice: ConflictChoice): void => {
    const next = { ...resolution };
    for (const name of names) next[name] = choice;
    onDone({ perName: next });
  };
  if (index >= names.length) {
    // Every name decided: submit the resolution (the caller closes the modal's parent).
    onDone({ perName: resolution });
    return null;
  }
  const name = names[index];
  const candidate = renameSuggestion(name, exists);
  return (
    <ModalShell
      labelledBy="sftp-conflict-title"
      widthClass="w-[22rem]"
      onClose={() => onDone(null)}
    >
      <div id="sftp-conflict-title" className="text-subhead font-semibold">
        {title}
      </div>
      <p className="mt-2 truncate font-mono text-aux" title={name}>
        {name}
      </p>
      {names.length > 1 && (
        <p className="mt-0.5 text-meta text-fg-faint">
          {t.sftp.conflict.count(index, names.length)}
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          className={DIALOG_PLAIN}
          onClick={() => applyAll("skip")}
          type="button"
        >
          {t.sftp.conflict.skipAll}
        </button>
        <button
          className={DIALOG_PLAIN}
          onClick={() => applyOne("rename")}
          type="button"
        >
          {t.sftp.conflict.renameShort(candidate)}
        </button>
        <button
          className={DIALOG_PLAIN}
          onClick={() => applyAll("overwrite")}
          type="button"
        >
          {t.sftp.conflict.overwriteAll}
        </button>
        <button
          className={DIALOG_CONFIRM}
          onClick={() => applyOne("skip")}
          type="button"
        >
          {t.sftp.conflict.skip}
        </button>
      </div>
    </ModalShell>
  );
}

/** The name prompt (New File / New Folder / Rename): one input, Enter submits, Escape cancels. */
export function NamePromptDialog({
  title,
  initial,
  onConfirm,
  onCancel,
}: {
  title: string;
  initial: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    setValue(initial);
  }, [initial]);
  const submit = (): void => {
    const name = value.trim();
    if (name) onConfirm(name);
  };
  return (
    <ModalShell
      labelledBy="sftp-name-title"
      widthClass="w-[20rem]"
      onClose={onCancel}
    >
      <div id="sftp-name-title" className="text-subhead font-semibold">
        {title}
      </div>
      <input
        aria-label={title}
        className="mt-3 w-full rounded-md border border-ink-700 bg-well px-2.5 py-1.5 font-mono text-aux text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/25"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        type="text"
        value={value}
      />
      <div className="mt-4 flex justify-end gap-2">
        <button className={DIALOG_PLAIN} onClick={onCancel} type="button">
          {t.common.cancel}
        </button>
        <button className={DIALOG_CONFIRM} onClick={submit} type="button">
          {t.common.continue}
        </button>
      </div>
    </ModalShell>
  );
}
