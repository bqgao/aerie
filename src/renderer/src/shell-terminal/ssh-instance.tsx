import "@xterm/xterm/css/xterm.css";
import { useStore } from "@nanostores/react";
import { useEffect } from "react";
import { cx } from "../ui/atoms";
import { RailButton } from "../settings/system-primitives";
import { useI18n } from "../i18n";
import { INSTANCE_CLASS } from "./instance";
import { useSshTerminalSession } from "./use-ssh-terminal-session";
import {
  $sshDialAttempt,
  clearSshTabState,
  reconnectSshTerminal,
  setSshTabState,
  sshDialAttemptOf,
} from "./ssh-model";

// Same absolute-stacking contract as the local instance.tsx: inactive tabs keep layout size
// (visibility toggles which one is seen; a display:none host renders garbled on re-show).
const SSH_INSTANCE_CLASS = INSTANCE_CLASS;

/** One persistent xterm + ssh session. Every open ssh tab stays mounted (its session, buffer and
 *  lamp state survive tab switches); only the active one is shown. A drop does NOT unmount: the
 *  xterm freezes behind a lock overlay until Reconnect re-dials into the same instance. */
export function SshTerminalInstance({
  id,
  active,
  serverId,
}: {
  id: string;
  active: boolean;
  serverId: string;
}) {
  const { t } = useI18n();
  // Dial epochs live in the model's map; re-render fires on any epoch change (Reconnect).
  useStore($sshDialAttempt);
  const attempt = sshDialAttemptOf(id);
  const { hostRef, status, failure } = useSshTerminalSession({
    id,
    serverId,
    active,
    attempt,
    onStatus: (state) => setSshTabState(id, state),
  });
  // Tab removal (local exit, refused first dial, user close): drop the tab's state entry so no
  // stale lamp or revive-in-place match lingers.
  useEffect(
    () => () => {
      clearSshTabState(id);
    },
    [id],
  );

  return (
    <div
      className={cx(
        SSH_INSTANCE_CLASS,
        active ? "visible" : "invisible pointer-events-none",
      )}
      data-terminal=""
      data-terminal-kind="ssh"
      data-ssh-state={status}
    >
      {/* Same inset/host split as instance.tsx (`relative` is load-bearing — see its comment). */}
      <div
        className="relative h-full min-h-0 overflow-hidden text-(--ui-text-secondary) [&_.xterm]:h-full [&_.xterm-screen]:bg-(--terminal-editor-surface-background)! [&_.xterm-viewport]:bg-(--terminal-editor-surface-background)!"
        ref={hostRef}
      />
      {status !== "connected" && (
        // The lock overlay (DESIGN_NOTES §S2 drop state): the buffer stays painted and frozen
        // behind it while nothing is live — read-only by construction, since keystrokes only flow
        // to a live session. connecting/reconnecting = dim veil + status; dropped = the message
        // line + the Reconnect affordance.
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-(--ui-editor-surface-background)/70"
          data-ssh-overlay=""
        >
          {failure ? (
            <p
              className="max-w-[70%] text-center text-xs text-danger"
              title={failure}
            >
              {t.terminal.ssh.reconnectFailed(failure)}
            </p>
          ) : (
            <p className="text-xs text-(--ui-text-secondary)">
              {attempt > 0
                ? t.terminal.ssh.reconnecting
                : t.terminal.ssh.connecting}
            </p>
          )}
          {status === "dropped" && (
            <RailButton onClick={() => reconnectSshTerminal(id)}>
              {t.terminal.ssh.reconnect}
            </RailButton>
          )}
        </div>
      )}
    </div>
  );
}
