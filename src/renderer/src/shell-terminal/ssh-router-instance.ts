import { createSshRouter } from "./router";

/** Built at app startup alongside the local shell router (router-instance.ts), so the ssh
 *  multiplexed routing is live before any ssh terminal ever dials: the register-before-spawn
 *  ordering in the hook puts the first pooled-channel bytes on a live handler. */
export const sshRouter = createSshRouter(window.api.terminalSsh);
