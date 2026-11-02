import { ensurePaneRegistered } from "./panes";

export const CBW_LEFT_PANE_ID = "cbw-left";
export const CBW_RIGHT_PANE_ID = "cbw-right";

export const LEFT_DEFAULT_WIDTH = 237;
export const LEFT_MIN_WIDTH = 237;
export const LEFT_MAX_WIDTH = 360;
export const RIGHT_DEFAULT_WIDTH = 237; // hermes FILE_BROWSER_DEFAULT_WIDTH (= sidebar width)
export const RIGHT_MIN_WIDTH = 160; // hermes FILE_BROWSER_MIN_WIDTH (10rem)
export const RIGHT_MAX_WIDTH = 320; // hermes FILE_BROWSER_MAX_WIDTH (20rem)

ensurePaneRegistered(CBW_LEFT_PANE_ID, { open: true });
ensurePaneRegistered(CBW_RIGHT_PANE_ID, { open: true });

export const CBW_TERMINAL_PANE_ID = "cbw-terminal";

ensurePaneRegistered(CBW_TERMINAL_PANE_ID, { open: true });

/** The SFTP file manager (pass F): a right-hand docked pane, default closed. */
export const SFTP_PANE_ID = "sftp";

ensurePaneRegistered(SFTP_PANE_ID, { open: false });

/** The Editor pane (pass I-a): a right-hand docked pane with an internal tab strip, default
 *  closed (spec: "default closed"). Tabs live in the editor store for the session; the pane's
 *  open state is the only persisted bit, like SFTP's. */
export const EDITOR_PANE_ID = "editor";

ensurePaneRegistered(EDITOR_PANE_ID, { open: false });
