import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { PcsError } from "./errors.js";
import type { PcsService } from "./service.js";
import { spawnSshPty, type SshTarget } from "./ssh.js";

/**
 * 交互式 root 终端。
 *
 * 终端是给管理员用的，不经过调度队列：队列负责可审计的自动化任务，
 * 交互式 shell 需要逐字节实时响应。实现等价于管理员 SSH 到宿主机再
 * `docker exec -it` 进容器，权限完全、没有命令审核。
 *
 * 鉴权：管理员用 Bearer 令牌换一次性票据（30 秒、用完即焚），票据放在
 * WebSocket 子协议里，不写 URL、不写日志。
 */

const TICKET_TTL_MS = 30_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type Ticket = {
  hostId: string;
  instanceId: string;
  operator: string;
  transport: "local" | "ssh";
  container: string;
  /** 裸机实例没有容器：直接进主机 shell。 */
  native?: boolean;
  ssh?: SshTarget;
  cols: number;
  rows: number;
  expiresAt: number;
};

const tickets = new Map<string, Ticket>();

export async function issueTerminalTicket(
  service: PcsService,
  body: Record<string, unknown>,
  operator: string,
): Promise<{ ticket: string; path: string; expires_in: number }> {
  const hostId = String(body.host_id ?? "").trim();
  const instanceId = String(body.instance_id ?? "").trim();
  if (!hostId || !instanceId) {
    throw new PcsError(400, "BAD_REQUEST", "缺少 host_id 或 instance_id");
  }
  const target = await service.terminalTarget(hostId, instanceId);
  const ticket = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  for (const [key, value] of tickets) {
    if (value.expiresAt <= now) tickets.delete(key);
  }
  tickets.set(ticket, {
    hostId,
    instanceId,
    operator,
    ...target,
    cols: clampInt(body.cols, 80, 20, 400),
    rows: clampInt(body.rows, 24, 5, 200),
    expiresAt: now + TICKET_TTL_MS,
  });
  return { ticket, path: "/api/v1/platform/terminal", expires_in: TICKET_TTL_MS / 1000 };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/** 处理 PCS HTTP server 上的 WebSocket upgrade；路径不对直接拒绝。 */
export function handleTerminalUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const path = (req.url ?? "").split("?")[0];
  if (path !== "/api/v1/platform/terminal") {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ticketKey = protocols.find((p) => p.startsWith("pcs.ticket."));
  const ticket = ticketKey ? tickets.get(ticketKey.slice("pcs.ticket.".length)) : undefined;
  if (ticket) tickets.delete(ticketKey!.slice("pcs.ticket.".length));
  if (!ticket || ticket.expiresAt < Date.now()) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || !key) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "Sec-WebSocket-Protocol: pcs.terminal",
      "",
      "",
    ].join("\r\n"),
  );

  startSession(socket, ticket, head);
}

function startSession(socket: Duplex, ticket: Ticket, head: Buffer): void {
  // 容器实例进容器；裸机实例直接落到主机 shell（权限等同 SSH 登录用户）。
  const inner = `stty cols ${ticket.cols} rows ${ticket.rows} 2>/dev/null; exec bash -l`;
  const execCmd = ticket.native
    ? `exec bash -l`
    : `docker exec -it ${shellQuote(ticket.container)} bash -lc ${shellQuote(inner)}`;
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };

  let child: ChildProcess;
  let cleanup = () => {};
  if (ticket.transport === "ssh" && ticket.ssh) {
    // ssh -tt 自己会申请远端 PTY，不需要本地终端。
    const spawned = spawnSshPty(ticket.ssh, execCmd, env);
    child = spawned.child;
    cleanup = spawned.cleanup;
  } else {
    // docker CLI 的 -t 要求本地 stdin 是终端；用 script 分配一个伪终端，
    // 否则会直接报 “the input device is not a TTY”。
    child = spawn("script", ["-q", "-c", execCmd, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
  }

  let closed = false;
  const send = (opcode: number, payload: Buffer) => {
    if (closed) return;
    try {
      socket.write(encodeFrame(opcode, payload));
    } catch {
      closed = true;
    }
  };
  const sendJson = (value: unknown) => send(0x1, Buffer.from(JSON.stringify(value)));
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      socket.end(encodeFrame(0x8, Buffer.alloc(0)));
    } catch {
      /* socket 可能已断 */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    cleanup();
  };

  child.stdout?.on("data", (b: Buffer) => send(0x2, b));
  child.stderr?.on("data", (b: Buffer) => send(0x2, b));
  child.on("error", (e) => {
    sendJson({ type: "error", message: String(e.message ?? e) });
    close();
  });
  child.on("close", (code) => {
    sendJson({ type: "exit", code: code ?? 1 });
    close();
  });
  socket.on("close", close);
  socket.on("error", close);
  sendJson({ type: "ready", container: ticket.container, instance_id: ticket.instanceId });

  // 客户端帧：二进制 = 键盘输入；文本 = 控制消息（目前只接受 resize，忽略）。
  const reader = createFrameReader((opcode, payload) => {
    if (opcode === 0x8) {
      close();
      return;
    }
    if (opcode === 0x9) {
      send(0xA, payload);
      return;
    }
    if (opcode === 0x2 || opcode === 0x1) {
      if (opcode === 0x1 && payload.length < 2048 && looksLikeJson(payload)) {
        // resize 等控制消息：docker exec 无法动态改 PTY 大小，先忽略。
        return;
      }
      try {
        child.stdin?.write(payload);
      } catch {
        close();
      }
    }
  });
  if (head.length) reader(head);
  socket.on("data", (chunk: Buffer) => reader(chunk));
}

function looksLikeJson(payload: Buffer): boolean {
  const first = payload.toString("utf8", 0, 1);
  return first === "{";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* ------------------------------------------------------------------ */
/* 最小 WebSocket 帧实现（服务端只需要文本/二进制/关闭/心跳）          */
/* ------------------------------------------------------------------ */

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function createFrameReader(onFrame: (opcode: number, payload: Buffer) => void) {
  let buffer: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + length) return;
      let payload = buffer.subarray(offset + maskLen, offset + maskLen + length);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + maskLen + length);
      onFrame(opcode, Buffer.from(payload));
    }
  };
}
