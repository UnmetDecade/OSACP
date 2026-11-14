import { t } from "../i18n";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getLiveConnection } from "../live/config";
import { errorMessage } from "../live/client";
import type { TerminalControlFrame } from "../live/rows";
import { openTerminal } from "../api";

/**
 * Terminal sessions live outside the page: switching pages only moves xterm's DOM into a hidden container,
 * leaving the WebSocket and shell connected; returning to the terminal page reattaches to the same session with scrollback intact.
 * Closing the tab makes the browser drop the connection as well.
 */

export type TermStatus = "connecting" | "open" | "closed" | "error";

export type TermSession = {
  key: string;
  hostId: string;
  instanceId: string;
  status: TermStatus;
  error: string;
  attach(mount: HTMLElement): void;
  detach(): void;
  reconnect(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

type Internal = TermSession & {
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  socket: WebSocket | null;
  inputSub?: { dispose(): void };
  readers: Set<() => void>;
  attached: boolean;
  disposed: boolean;
  setStatus(status: TermStatus, error?: string): void;
};

const sessions = new Map<string, Internal>();
const MAX_SESSIONS = 4;
let parking: HTMLDivElement | null = null;

function parkingHost(): HTMLDivElement {
  if (parking && parking.isConnected) return parking;
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:-20000px;top:0;width:900px;height:600px;pointer-events:none;visibility:hidden;";
  document.body.appendChild(el);
  parking = el;
  return el;
}

function sessionKey(hostId: string, instanceId: string): string {
  return `${hostId}:${instanceId}`;
}

export function getTerminalSession(hostId: string, instanceId: string): TermSession {
  const key = sessionKey(hostId, instanceId);
  const existing = sessions.get(key);
  if (existing) return existing;

  // Each terminal holds an SSH/Shell connection; cap the resident count and reclaim hidden ones first when exceeding it.
  if (sessions.size >= MAX_SESSIONS) {
    for (const [otherKey, other] of sessions) {
      if (!other.attached) {
        other.dispose();
        sessions.delete(otherKey);
        break;
      }
    }
  }

  const el = document.createElement("div");
  el.style.cssText = "width:100%;height:100%;";
  parkingHost().appendChild(el);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    scrollback: 5000,
    theme: {
      background: "#0e0f13",
      foreground: "#d7dae2",
      cursor: "#8b8cf6",
      selectionBackground: "rgba(139,140,246,0.28)",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  let disposed = false;
  let frame = 0;
  const doFit = () => {
    if (disposed || !el.isConnected) return;
    try {
      fit.fit();
    } catch {
      // Ignore while the container is still laying out
    }
  };
  const scheduleFit = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      doFit();
    });
  };
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(el);

  const readers = new Set<() => void>();
  const session: Internal = {
    key,
    hostId,
    instanceId,
    status: "connecting",
    error: "",
    el,
    term,
    fit,
    socket: null,
    readers,
    attached: false,
    disposed: false,
    attach(mount) {
      if (disposed) return;
      mount.appendChild(el);
      session.attached = true;
      requestAnimationFrame(() => {
        doFit();
        // The renderer does not repaint while in the hidden container, so refresh the whole screen once on reattach.
        session.term.refresh(0, session.term.rows - 1);
        term.focus();
      });
    },
    detach() {
      session.attached = false;
      if (!disposed) parkingHost().appendChild(el);
    },
    reconnect() {
      if (disposed) return;
      void connect(session);
    },
    subscribe(listener) {
      readers.add(listener);
      return () => readers.delete(listener);
    },
    setStatus(status, error = "") {
      session.status = status;
      session.error = error;
      for (const listener of readers) listener();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      session.disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      session.inputSub?.dispose();
      session.socket?.close();
      session.socket = null;
      term.dispose();
      el.remove();
    },
  };

  sessions.set(key, session);
  session.inputSub = term.onData((data) => {
    if (session.socket && session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(new TextEncoder().encode(data));
    }
  });

  void connect(session);
  return session;
}

async function connect(session: Internal): Promise<void> {
  if (session.disposed) return;
  session.socket?.close();
  session.socket = null;

  const dims = (() => {
    try {
      return session.fit.proposeDimensions();
    } catch {
      return undefined;
    }
  })();
  const cols = dims?.cols ?? 80;
  const rows = dims?.rows ?? 24;

  // Reconnection keeps existing output and does not clear the screen.
  session.setStatus("connecting");
  try {
    const ticket = await openTerminal(session.hostId, session.instanceId, cols, rows);
    if (session.disposed) return;
    const socket = new WebSocket(
      terminalWsUrl(getLiveConnection().pcsUrl, ticket.path),
      ["pcs.terminal", `pcs.ticket.${ticket.ticket}`],
    );
    socket.binaryType = "arraybuffer";
    session.socket = socket;
    // On reconnect the old socket's close callback may arrive late; accept only the current one.
    const current = () => !session.disposed && session.socket === socket;
    socket.onopen = () => {
      if (!current()) return;
      session.setStatus("open");
      requestAnimationFrame(() => session.term.focus());
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      if (typeof event.data === "string") {
        let control: TerminalControlFrame | null = null;
        try {
          control = JSON.parse(event.data) as TerminalControlFrame;
        } catch {
          session.term.write(event.data);
          return;
        }
        if (control?.type === "exit") {
          const code = String(control.code ?? "");
          session.term.write(`\r\n\x1b[90m${t("会话结束（退出码 {code}）", { code })}\x1b[0m\r\n`);
          session.setStatus("closed");
        } else if (control?.type === "error") {
          const message = String(control.message ?? "");
          session.term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
          session.setStatus("error", message);
        } else if (control?.type === "ready") {
          session.setStatus("open");
        }
        return;
      }
      session.term.write(new Uint8Array(event.data as ArrayBuffer));
    };
    socket.onerror = () => {
      if (!current()) return;
      session.term.write(t("\r\n\x1b[31m连接中断\x1b[0m\r\n"));
      session.setStatus("error", t("终端连接中断"));
    };
    socket.onclose = () => {
      if (!current()) return;
      session.setStatus(session.status === "open" ? "closed" : session.status);
    };
  } catch (e) {
    if (session.disposed) return;
    const message = errorMessage(e);
    session.term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
    session.setStatus("error", message);
  }
}

/** Convert the control plane base address (same-origin proxy or absolute) into a WebSocket address. */
function terminalWsUrl(base: string, path: string): string {
  const abs = new URL(base, window.location.href);
  abs.protocol = abs.protocol === "https:" ? "wss:" : "ws:";
  abs.search = "";
  abs.hash = "";
  abs.pathname = `${abs.pathname.replace(/\/+$/, "")}${path}`;
  return abs.toString();
}
