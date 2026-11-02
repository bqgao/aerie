import { useStore } from "@nanostores/react";
import { TerminalInstance } from "./instance";
import { SshTerminalInstance } from "./ssh-instance";
import { $activeTerminalId, $terminals } from "./terminals";

/** The persistent-overlay layer: the stack of live xterm instances (only these must stay in the
 *  fixed overlay, for the WebGL host). Mount/visibility is owned by PersistentTerminal (latched so
 *  shells survive hiding); the tab rail lives in the pane DOM — see TerminalPaneChrome.
 *  S2: an ssh-kind tab renders the ssh instance (channel + lock overlay) in the same stack — two
 *  components rather than a kind-branch inside one, because the two session hooks must both mount
 *  for every tab. */
export function TerminalWorkspace() {
  const terminals = useStore($terminals);
  const activeId = useStore($activeTerminalId);

  return (
    <>
      {terminals.map((term) =>
        term.kind === "ssh" ? (
          <SshTerminalInstance
            active={term.id === activeId}
            id={term.id}
            key={term.id}
            serverId={term.serverId ?? ""}
          />
        ) : (
          <TerminalInstance
            active={term.id === activeId}
            cwd={term.cwd}
            id={term.id}
            key={term.id}
            reviveBuffer={term.reviveBuffer}
          />
        ),
      )}
    </>
  );
}
