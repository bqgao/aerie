import { useEffect, useState } from "react";
import type {
  ServerProfile,
  ServerStatus,
  ServerStatusMap,
  ServerTestResult,
} from "@shared/servers";
import { Card } from "../shell/page-primitives";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/icons";
import { useI18n } from "../i18n";
import { ReadoutRow, RailButton, EditLink } from "./system-primitives";

const inputClass =
  "w-full min-w-0 rounded-md border border-ink-700 bg-well px-2.5 py-1.5 font-mono text-aux text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/25";

/** Inline status dot + word per connection state — the subsystem lamp hues, reusing the card
 *  grammar compiled inline (a fifth lamp color pair would be a new design language; this isn't). */
function StatusDot({ status }: { status: ServerStatus }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <span
        className={
          status === "connected"
            ? "h-2 w-2 rounded-full bg-working shadow-[0_0_0.375rem_rgba(45,212,191,0.5)]"
            : status === "connecting"
              ? "h-2 w-2 animate-pulse rounded-full bg-accent"
              : status === "error"
                ? "h-2 w-2 rounded-full bg-danger"
                : "h-2 w-2 rounded-full bg-ink-600"
        }
      />
      <span className="font-mono text-meta text-fg-faint">
        {t.settings.servers.status[status]}
      </span>
    </span>
  );
}

/** The form draft: save fields plus the WRITE-ONLY credential inputs, kept out of the profile
 *  type so the saved profile can never grow a plaintext field by accident. Credential inputs
 *  always start blank — secrets are never round-tripped (the placeholder says what's stored). */
interface ServerForm {
  id?: string;
  name: string;
  group: string;
  host: string;
  port: string;
  username: string;
  authMode: "password" | "key" | "agent";
  keyPath: string;
  password: string;
  passphrase: string;
}

const EMPTY_FORM = (port: string): ServerForm => ({
  name: "",
  group: "",
  host: "",
  port,
  username: "",
  authMode: "password",
  keyPath: "",
  password: "",
  passphrase: "",
});

function formOf(p: ServerProfile): ServerForm {
  return {
    id: p.id,
    name: p.name,
    group: p.group,
    host: p.host,
    port: String(p.port),
    username: p.username,
    authMode: p.authMode,
    keyPath: p.keyPath ?? "",
    password: "",
    passphrase: "",
  };
}

function Labeled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-meta text-fg-faint">{label}</span>
      {children}
    </label>
  );
}

/**
 * Settings → Servers: the saved SSH endpoints with a per-row status lamp, Test verdict, edit and
 * delete, plus the add/edit form (fields validated in MAIN; the form surfaces its first error).
 * The list is read once per mount and refetched after every mutation; the STATUS map is polled
 * at the System section's 3s cadence while the card is mounted (no push channels — app rule).
 */
export function ServerCard() {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [status, setStatus] = useState<ServerStatusMap>({});
  const [form, setForm] = useState<ServerForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<ServerProfile | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Test verdict per submit key (profile id or "__form") — survives until the next test or a
  // profile mutation; rendered inline under its row (the ReadoutRow's amber warn line).
  const [verdicts, setVerdicts] = useState<
    Record<string, ServerTestResult | null>
  >({});

  useEffect(() => {
    void window.api.serversList().then(setProfiles);
    // Poll like the rest of the System section: row lamps move because main's pool state moves.
    const timer = setInterval(
      () => void window.api.serversStatus().then(setStatus),
      3000,
    );
    return () => clearInterval(timer);
  }, []);

  const refresh = async (): Promise<void> => {
    const [list, st] = await Promise.all([
      window.api.serversList(),
      window.api.serversStatus(),
    ]);
    setProfiles(list);
    setStatus(st);
  };

  const save = async (): Promise<void> => {
    if (!form) return;
    setFormError(null);
    const values = {
      ...(form.id ? { id: form.id } : {}),
      name: form.name,
      group: form.group,
      host: form.host,
      port: Number(form.port) || 0,
      username: form.username,
      authMode: form.authMode,
      ...(form.authMode === "key" && form.keyPath
        ? { keyPath: form.keyPath }
        : {}),
    };
    const saved = await window.api.serversSave(values);
    if (!saved.ok) {
      setFormError(saved.error);
      return;
    }
    // The credential inputs ride a second call: undefined keys = untouched; a typed value replaces.
    if (form.password !== "" || form.passphrase !== "") {
      const result = await window.api.serversSetCredential(saved.profile.id, {
        ...(form.password !== "" ? { password: form.password } : {}),
        ...(form.passphrase !== "" ? { passphrase: form.passphrase } : {}),
      });
      if (!result.ok)
        setFormError(`${t.settings.servers.credFail(result.error)}`);
    }
    setForm(null);
    setVerdicts({}); // the form changed → every previous test verdict is stale
    await refresh();
  };

  const remove = async (id: string): Promise<void> => {
    await window.api.serversRemove(id);
    setConfirmId(null);
    setVerdicts({});
    await refresh();
  };

  const runTest = async (
    form2: ServerForm,
    rowProfileId: string,
  ): Promise<void> => {
    setBusyKey(rowProfileId);
    try {
      // Raw values only: a saved row sends its id with BLANK credential fields so MAIN injects
      // the stored secret; the unsaved form sends what was typed (possibly nothing — the row
      // then shows the "no password" verdict honestly, since the renderer never pulls secrets).
      const result = await window.api.serversTest({
        ...(form2.id ? { id: form2.id } : {}),
        host: form2.host,
        port: Number(form2.port) || 0,
        username: form2.username,
        authMode: form2.authMode,
        ...(form2.authMode === "key" && form2.keyPath
          ? { keyPath: form2.keyPath }
          : {}),
      });
      setVerdicts((prev) => ({ ...prev, [rowProfileId]: result }));
    } finally {
      setBusyKey(null);
    }
  };

  const rows = (): ServerProfile[] => {
    const grouped = profiles
      .filter((p) => p.group.trim() !== "")
      .sort(
        (a, b) =>
          a.group.localeCompare(b.group) || a.name.localeCompare(b.name),
      );
    const ungrouped = profiles
      .filter((p) => p.group.trim() === "")
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...grouped, ...ungrouped];
  };

  return (
    <Card title={t.settings.servers.title}>
      <div className="flex items-center justify-between border-b border-ink-850 px-4 py-2.5">
        <span className="font-mono text-meta text-fg-faint">
          {t.settings.servers.rows(profiles.length)}
        </span>
        {form === null ? (
          <RailButton
            onClick={() => {
              setForm(EMPTY_FORM("22"));
              setFormError(null);
            }}
          >
            <Icon name="plus" size={13} />
            {t.settings.servers.add}
          </RailButton>
        ) : (
          <span className="font-mono text-meta tracking-[0.1em] text-accent-bright">
            {form.id
              ? t.settings.servers.editHeadline
              : t.settings.servers.addHeadline}
          </span>
        )}
      </div>

      {profiles.length === 0 && form === null && (
        <div className="px-4 py-3 text-aux text-fg-faint">
          {t.settings.servers.empty}
        </div>
      )}

      {rows().map((p) => {
        const entry = status[p.id];
        const st: ServerStatus = entry?.status ?? "offline";
        const verdict = verdicts[p.id];
        return (
          <ReadoutRow
            key={p.id}
            label={p.name}
            value={
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono">{`${p.username}@${p.host}:${p.port}`}</span>
                {p.group.trim() !== "" && (
                  <span className="rounded border border-ink-700 px-1 text-meta text-fg-faint">
                    {p.group}
                  </span>
                )}
                <StatusDot status={st} />
              </span>
            }
            warn={
              verdict && !verdict.ok
                ? t.settings.servers.testFailed(verdict.error)
                : undefined
            }
            edit={
              <span className="flex items-center gap-2">
                <RailButton
                  disabled={busyKey === p.id}
                  onClick={() =>
                    void runTest(
                      {
                        ...formOf(p),
                        id: p.id,
                        password: "",
                        passphrase: "",
                      },
                      p.id,
                    )
                  }
                >
                  <Icon
                    name="rotate-ccw"
                    size={12}
                    className={busyKey === p.id ? "animate-spin" : ""}
                  />
                  {t.settings.servers.test}
                </RailButton>
                <EditLink
                  onClick={() => {
                    setForm(formOf(p));
                    setFormError(null);
                  }}
                >
                  {t.settings.servers.edit}
                </EditLink>
                <button
                  type="button"
                  onClick={() => setConfirmId(p)}
                  className="rounded-md px-1.5 py-1 text-meta text-fg-faint transition-colors hover:text-danger"
                  aria-label={t.settings.servers.deleteConfirm}
                >
                  <Icon name="x" size={13} />
                </button>
              </span>
            }
          />
        );
      })}

      {form && (
        <div className="flex flex-col gap-2.5 px-4 py-3">
          <div className="grid grid-cols-2 gap-2.5">
            <Labeled label={t.settings.servers.name}>
              <input
                className={inputClass}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t.settings.servers.namePlaceholder}
                autoFocus
              />
            </Labeled>
            <Labeled label={t.settings.servers.group}>
              <input
                className={inputClass}
                value={form.group}
                onChange={(e) => setForm({ ...form, group: e.target.value })}
                placeholder={t.settings.servers.groupPlaceholder}
              />
            </Labeled>
            <Labeled label={t.settings.servers.host}>
              <input
                className={inputClass}
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
              />
            </Labeled>
            <Labeled label={t.settings.servers.username}>
              <input
                className={inputClass}
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </Labeled>
            <Labeled label={t.settings.servers.port}>
              <input
                className={inputClass}
                value={form.port}
                inputMode="numeric"
                onChange={(e) =>
                  setForm({ ...form, port: e.target.value.replace(/\D/g, "") })
                }
              />
            </Labeled>
            <Labeled label={t.settings.servers.auth}>
              <select
                className="h-[38px] rounded-md border border-ink-700 bg-well px-2 font-mono text-aux text-fg outline-none focus:border-primary"
                value={form.authMode}
                onChange={(e) =>
                  setForm({
                    ...form,
                    authMode: e.target.value as ServerForm["authMode"],
                  })
                }
              >
                <option value="password">
                  {t.settings.servers.authPassword}
                </option>
                <option value="key">{t.settings.servers.authKey}</option>
                <option value="agent">{t.settings.servers.authAgent}</option>
              </select>
            </Labeled>
            {form.authMode === "key" && (
              <Labeled label={t.settings.servers.keyPath}>
                <input
                  className={inputClass}
                  value={form.keyPath}
                  onChange={(e) =>
                    setForm({ ...form, keyPath: e.target.value })
                  }
                  placeholder="~/.ssh/id_ed25519"
                />
              </Labeled>
            )}
            {form.authMode === "password" && (
              <Labeled label={t.settings.servers.password}>
                <input
                  className={inputClass}
                  type="password"
                  value={form.password}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                  placeholder={t.settings.servers.credentialSet}
                />
              </Labeled>
            )}
            {form.authMode === "key" && (
              <Labeled label={t.settings.servers.passphrase}>
                <input
                  className={inputClass}
                  type="password"
                  value={form.passphrase}
                  onChange={(e) =>
                    setForm({ ...form, passphrase: e.target.value })
                  }
                  placeholder={t.settings.servers.credentialSet}
                />
              </Labeled>
            )}
          </div>
          {formError && (
            <div className="font-mono text-meta text-danger">{formError}</div>
          )}
          <div className="flex justify-end gap-2">
            <RailButton onClick={() => setForm(null)}>
              {t.settings.servers.cancel}
            </RailButton>
            <RailButton
              disabled={busyKey === "__form"}
              onClick={() => void runTest(form, "__form")}
            >
              <Icon
                name="rotate-ccw"
                size={12}
                className={busyKey === "__form" ? "animate-spin" : ""}
              />
              {t.settings.servers.test}
            </RailButton>
            <RailButton onClick={() => void save()}>
              {t.settings.servers.save}
            </RailButton>
          </div>
        </div>
      )}

      {confirmId && (
        <ConfirmDialog
          title={t.settings.servers.deleteTitle(confirmId.name)}
          body={t.settings.servers.deleteBody}
          tone="danger"
          confirmLabel={t.settings.servers.deleteConfirm}
          onConfirm={() => void remove(confirmId.id)}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </Card>
  );
}
