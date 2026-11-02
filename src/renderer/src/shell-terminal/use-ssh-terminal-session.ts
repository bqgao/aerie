import { useEffect, useRef, useState } from "react";
import { osKind } from "@shared/platform";
import { XtermTerminal } from "../xterm/xterm-terminal";
import { terminalTheme } from "../xterm/terminal-theme";
import { TerminalResizeDebouncer } from "../xterm/terminal-resize-debouncer";
import { computeLayoutResize } from "../xterm/terminal-font-metrics";
import { warmTerminalFonts } from "../xterm/font-warmup";
import { macEditSequence } from "../ui/mac-edit-sequence";
import { clipboardKeyAction } from "../xterm/clipboard-keys";
import { deferToKeypress } from "../xterm/ime-punctuation";
import {
  attachClipboardContextMenu,
  runClipboardAction,
  type ClipboardActionDeps,
} from "../xterm/clipboard-actions";
import {
  collectDroppedPaths,
  quotePathForShell,
  transferHasDropCandidates,
} from "../xterm/file-drop";
import { sshRouter } from "./ssh-router-instance";
import { closeTerminal } from "./terminals";
// The teardown guard is the pty hook's already-mounted pagehide listener — one mark, two surfaces.
import { appIsTearingDown } from "./use-terminal-session";

/** Per-tab ssh session status, driven into the ssh-model's state map by the instance.
 *  "dropped" keeps the tab behind a lock overlay (buffer preserved) until Reconnect re-dials. */
export type SshSessionStatus = "connecting" | "connected" | "dropped";

interface UseSshTerminalSessionOptions {
  /** Renderer-side tab id (keys the tab store; NOT the ssh session id). */
  id: string;
  /** The saved server profile id the shell channel rides (resolved main-side). */
  serverId: string;
  /** Only the active tab is visible; (re)activation refits and refocuses. */
  active: boolean;
  /** Reconnect epoch: bumping re-dials into the SAME xterm instance (see reconnectSshTerminal). */
  attempt: number;
  onStatus?: (status: SshSessionStatus) => void;
}

export function useSshTerminalSession({
  id,
  serverId,
  active,
  attempt,
  onStatus,
}: UseSshTerminalSessionOptions) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const xtRef = useRef<XtermTerminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  // Flushes the resize debouncer's deferred edge on reactivation — a hidden tab defers its X/Y
  // resize to idle callbacks; showing it again must apply them immediately, not wait for idle.
  const flushRef = useRef<(() => void) | null>(null);
  // Whichever session (the renderer-minted ssh session id) is currently live: re-pointed per dial.
  // xterm's single onData key listener and the debouncer read THROUGH it, so reconnects swap the
  // stream underneath without re-attaching anything.
  const liveRef = useRef<{ sessionId: string } | null>(null);
  const [status, setStatus] = useState<SshSessionStatus>("connecting");
  const [failure, setFailure] = useState<string | null>(null);

  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  // ── The xterm instance outlives every dial ─────────────────────────────────
  // One xterm per tab for the tab's whole life; the reconnect story is: old channel dies → status
  // dropped (lock overlay, buffer preserved) → Reconnect bumps the epoch → the dial effect below
  // spawns a fresh session whose output streams into THIS instance. The local (pty) hook instead
  // re-creates its whole stack per session, because a local shell has nothing worth preserving.
  // No revive buffer / snapshot persistence here either: ssh tabs don't persist across a page
  // load (a live pooled dial has nothing to revive), so the buffer only needs to survive
  // reconnects — which staying mounted accomplishes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof window === "undefined") return;

    let disposed = false;
    const cleanup: Array<() => void> = [];

    const xt = new XtermTerminal({
      raw: {
        allowProposedApi: true,
        // Opaque canvas = WebGL's crisp fast-path (VS Code keeps transparency off).
        allowTransparency: false,
        convertEol: true,
        cursorBlink: true,
        customGlyphs: true,
        rescaleOverlappingGlyphs: true,
        fontFamily:
          "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
        fontSize: 11,
        fontWeight: "normal",
        fontWeightBold: "bold",
        letterSpacing: 0,
        lineHeight: 1.12,
        macOptionClickForcesSelection: true,
        macOptionIsMeta: true,
        minimumContrastRatio: 4.5,
        scrollback: 1000,
      },
      theme: (mode) => terminalTheme(mode),
      unicodeVersion: "11",
      openExternal: (url) => void window.api.openExternal(url),
      // No scrollbarHost override: `host` (the ref target below) is itself the positioned ancestor
      // .xterm's own absolute/inset CSS binds to (it's `relative`), matching instance.tsx's layout.
    });
    const term = xt.raw;
    xtRef.current = xt;
    cleanup.push(() => xt.dispose());

    // Keystrokes flow to the live session through the ref; while nothing is live (drop, or a dial
    // still resolving) they go nowhere instead of into the old session's pipe.
    const liveWrite = (data: string): void => {
      const live = liveRef.current;
      if (live) window.api.terminalSsh.write(live.sessionId, data);
    };
    const liveResize = (cols: number, rows: number): void => {
      const live = liveRef.current;
      if (live) window.api.terminalSsh.resize(live.sessionId, cols, rows);
    };
    const dataDisposable = term.onData((data) => liveWrite(data));
    cleanup.push(() => dataDisposable.dispose());

    // macOS readline word-navigation + clipboard combos: the same key surface as the local shell
    // terminal (the remote story is identical — an interactive shell reads byte sequences).
    const os = osKind(window.api.platform);
    const clipDeps: ClipboardActionDeps = {
      term,
      writePty: liveWrite,
      clipboard: {
        readText: (type) => window.api.clipboardReadText(type),
        writeText: (text) => window.api.clipboardWriteText(text),
      },
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.isComposing) return false;
      const action = clipboardKeyAction(e, os, term.hasSelection());
      if (action !== null) {
        e.preventDefault();
        void runClipboardAction(action, clipDeps);
        return false;
      }
      if (deferToKeypress(e)) return false;
      if (os !== "mac") return true;
      const seq = macEditSequence(e);
      if (seq === null) return true;
      e.preventDefault();
      liveWrite(seq);
      return false;
    });
    cleanup.push(attachClipboardContextMenu(host, os, clipDeps));

    // Drag & drop file paths into the remote shell: the same affordance as the local terminal,
    // quoted for the (overwhelmingly POSIX) remote login shell.
    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer || !transferHasDropCandidates(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent): void => {
      if (!e.dataTransfer || !transferHasDropCandidates(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const live = liveRef.current;
      if (!live) return; // nothing live to paste into — the drop is inert while dropped/connecting
      const paths = collectDroppedPaths(e.dataTransfer, (f) =>
        window.api.getPathForFile(f),
      );
      if (!paths.length) return;
      window.api.terminalSsh.write(
        live.sessionId,
        `${paths.map((p) => quotePathForShell(p, "bash")).join(" ")} `,
      );
      xtRef.current?.raw.focus();
    };
    host.addEventListener("dragenter", onDragOver);
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("drop", onDrop);
    cleanup.push(() => {
      host.removeEventListener("dragenter", onDragOver);
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
    });

    const debouncer = new TerminalResizeDebouncer({
      getBufferLength: () => term.buffer.normal.length,
      isVisible: () => activeRef.current,
      resizeBoth: (cols, rows) => {
        term.resize(cols, rows);
        liveResize(cols, rows);
      },
      resizeX: (cols) => {
        term.resize(cols, term.rows);
        liveResize(cols, term.rows);
      },
      resizeY: (rows) => {
        term.resize(term.cols, rows);
        liveResize(term.cols, rows);
      },
    });
    cleanup.push(() => debouncer.dispose());
    flushRef.current = () => debouncer.flush();

    let lastDims: { width: number; height: number } | null = null;
    const layout = (): void => {
      if (
        disposed ||
        !host.isConnected ||
        host.clientWidth <= 0 ||
        host.clientHeight <= 0 ||
        !term.element
      ) {
        return;
      }
      lastDims = { width: host.clientWidth, height: host.clientHeight };
      // Shared with the Claude terminal (xterm/terminal-font-metrics.ts): padding-only
      // subtraction + the unchanged-size skip live in one place.
      const dims = computeLayoutResize(
        window,
        term.element,
        xt.getFont(),
        lastDims.width,
        lastDims.height,
        term.cols,
        term.rows,
      );
      if (!dims) return;
      debouncer.resize(dims.cols, dims.rows);
    };
    fitRef.current = layout;
    cleanup.push(
      xt.onDidRequestRefreshDimensions(() => {
        if (!disposed) layout();
      }),
    );

    // Coalesce ResizeObserver bursts through rAF (unchanged rationale from the local hook).
    let pendingFrame = 0;
    const scheduleResize = (): void => {
      if (pendingFrame) return;
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = 0;
        if (!disposed) layout();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(host);
    cleanup.push(() => {
      resizeObserver.disconnect();
      if (pendingFrame) window.cancelAnimationFrame(pendingFrame);
    });

    const mount = (): void => {
      if (disposed || !host.isConnected) return;
      xt.attachToElement(host);
      layout();
    };
    // Open + fit only once webfonts settle: fitting with fallback metrics picks the wrong row
    // count (same rationale as the local hook; the dial effect refits on its own success path).
    void warmTerminalFonts(11).then(mount, mount);

    return () => {
      disposed = true;
      cleanup.forEach((run) => run());
      fitRef.current = null;
      flushRef.current = null;
      liveRef.current = null;
      xtRef.current = null;
    };
  }, [id]);

  // ── One dial epoch: register → spawn → own the session until its exit ──────
  // Re-runs on Reconnect (epoch bump). The xterm above is untouched — only this output plumbing is
  // re-wired, which is what "same xterm instance, buffer preserved" rides on. The sessionId is
  // minted here (unique per tab+attempt) and the ssh router handler registers BEFORE the spawn
  // invoke: the race-free ordering every terminal surface uses.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const api = window.api.terminalSsh;
    let disposed = false;
    const cleanup: Array<() => void> = [];
    const sessionId = `ssh-${id}-${attempt}`;
    setStatus("connecting");
    setFailure(null);
    onStatusRef.current?.("connecting");

    cleanup.push(
      sshRouter.register(sessionId, {
        onData: (data) => {
          xtRef.current?.raw.write(data, () =>
            sshRouter.ackConsumed(sessionId, data.length),
          );
        },
        onExit: (_exitCode, reason) => {
          if (disposed || appIsTearingDown()) return;
          liveRef.current = null; // dead session — keystrokes must not reach the old pipe
          if (reason === "dropped") {
            // Pool-level loss (main's noteDown, or the channel's own close while the pool is
            // gone): the tab SURVIVES under the lock overlay; the epoch is re-dialable.
            setStatus("dropped");
            onStatusRef.current?.("dropped");
            return;
          }
          // The remote shell exited (`exit` inside the remote shell) — dies like a local exit:
          // the tab closes and its slot collapses as usual.
          closeTerminal(id);
        },
      }),
    );
    liveRef.current = { sessionId };

    void api
      .spawn({
        id: sessionId,
        serverId,
        cols: xtRef.current?.raw.cols ?? 80,
        rows: xtRef.current?.raw.rows ?? 24,
      })
      .then((res) => {
        if (disposed) {
          // Cleanup already sent close() — belt-and-suspenders ordering on the same pipe.
          if (res.ok) api.close(sessionId);
          return;
        }
        if (!res.ok) {
          // A refused dial. First dial: per DESIGN_NOTES no tab survives an auth/unreachable
          // failure — drop the optimistic tab and leave the sticky reason on the sidebar row.
          // Reconnect: stay revivable under the overlay and surface the reason there.
          if (attempt === 0) {
            closeTerminal(id);
            return;
          }
          setFailure(res.error);
          setStatus("dropped");
          onStatusRef.current?.("dropped");
          return;
        }
        setFailure(null);
        setStatus("connected");
        onStatusRef.current?.("connected");
        const xt = xtRef.current;
        // Refit + focus now that a real session is live — same rAF shape as the local spawn path.
        window.requestAnimationFrame(() => {
          if (disposed || !xt) return;
          flushRef.current?.();
          fitRef.current?.();
          xt.raw.clearSelection();
          xt.raw.focus();
        });
      })
      .catch((error: unknown) => {
        // The shared surface never rejects (never-reject rule main-side); this catch is the
        // wiring-fault belt only, shaped like the refused-dial path above.
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 0) {
          closeTerminal(id);
          return;
        }
        setFailure(message);
        setStatus("dropped");
        onStatusRef.current?.("dropped");
      });

    return () => {
      // Unregister FIRST: late chunks get stray-acked rather than flooded into a dead tab.
      disposed = true;
      cleanup.forEach((run) => run());
      liveRef.current = null;
      api.close(sessionId); // fire-and-forget; ordered after the spawn invoke on the same pipe
    };
  }, [id, attempt, serverId]);

  // On (re)activation: a WebGL terminal doesn't paint while visibility:hidden, so it reveals a
  // stale frame. Flush the resize the debouncer deferred while hidden, refit, force a full
  // redraw + atlas rebuild, then focus. Same as the local hook.
  useEffect(() => {
    if (!active || status !== "connected") return;
    const frame = requestAnimationFrame(() => {
      const xt = xtRef.current;
      flushRef.current?.();
      fitRef.current?.();
      xt?.forceRedraw();
      xt?.raw.refresh(0, xt.raw.rows - 1);
      xt?.raw.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, status]);

  return { hostRef, status, failure };
}
