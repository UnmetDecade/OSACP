import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import type { AgentProfile } from "./types.js";

export interface AdapterEvent {
  type: "progress" | "log" | "artifact";
  percent?: number;
  phase?: string;
  level?: string;
  message?: string;
  name?: string;
  path?: string;
}

export interface AdapterResult {
  status: "SUCCEEDED" | "FAILED";
  summary?: string;
  /** Optional text reply for chat-type tasks; ordinary build tasks do not need to set it */
  reply?: string;
  outputs?: Array<{ name: string; path: string }>;
  metrics?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

export interface AdapterHooks {
  onEvent: (event: AdapterEvent) => void;
  onLog: (line: string) => void;
  /** Tool calls are executed by role-agent's Policy Guard; errors are returned to the Adapter as-is */
  onToolCall: (params: unknown) => Promise<unknown>;
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class AdapterCrash extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdapterCrash";
  }
}

/**
 * stdio JSON-RPC 2.0 Adapter (one JSON per line).
 *
 * This is the key boundary for "swapping Agents under the same role": the Agent sees only the task, the workspace and the tool handle,
 * not the scheduler token, the Secret Store or host directories.
 */
export class StdioAdapter {
  private child?: ChildProcessWithoutNullStreams;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly events: AdapterEvent[] = [];
  private resultNotify: AdapterResult | null = null;
  private resultWaiter?: (r: AdapterResult) => void;
  private closed = false;
  private lastProgress = -1;

  constructor(
    private readonly profile: AgentProfile,
    private readonly workspace: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly hooks: AdapterHooks,
  ) {}

  /**
   * In native mode, Agent Profiles still write /opt/platform/... as container paths;
   * this maps them to the instance directory, so a Profile does not need a separate copy for each execution mode.
   */
  private nativePath(value: string): string {
    const root = process.env.PLATFORM_NATIVE_ROOT;
    if (!root || !value.startsWith("/opt/platform/")) return value;
    return path.join(root, value.slice("/opt/platform/".length));
  }

  async start(): Promise<void> {
    const [rawCmd, ...baseArgs] = this.profile.entrypoint;
    if (!rawCmd) throw new AdapterCrash("AGENT_PROFILE_INVALID", "Agent Profile is missing entrypoint");
    const cmd = this.nativePath(rawCmd);
    const args = [...baseArgs.map((a) => this.nativePath(a)), ...(this.profile.args ?? []).map((a) => this.nativePath(a))];
    this.child = spawn(cmd, args, {
      cwd: this.workspace,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    readline.createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.hooks.onLog(`[adapter] ${redact(line)}`.slice(0, 2000));
    });
    this.child.on("error", (e) => this.failAll(new AdapterCrash("AGENT_CRASHED", e.message)));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      const msg = `Adapter exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.failAll(new AdapterCrash("AGENT_CRASHED", msg));
    });

    await this.request("agent.health", {}, 5000);
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      this.hooks.onLog(`[adapter-stdout] ${redact(text).slice(0, 2000)}`);
      return;
    }
    if (msg.method === "agent.event") {
      this.handleEvent(msg.params ?? {});
      return;
    }
    if (msg.method === "agent.result") {
      const result = msg.params as AdapterResult;
      this.resultNotify = result;
      this.resultWaiter?.(result);
      return;
    }
    if (msg.method === "tool.call" && msg.id !== undefined) {
      void this.handleToolRequest(msg);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(
          new AdapterCrash(
            String(msg.error.code ?? "AGENT_RPC_ERROR"),
            String(msg.error.message ?? "Adapter returned an error"),
          ),
        );
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private handleEvent(params: any): void {
    const type = String(params.type ?? "");
    if (type === "progress") {
      let percent = Number(params.percent);
      if (!Number.isFinite(percent)) percent = 0;
      percent = Math.max(this.lastProgress, Math.min(100, Math.max(0, percent)));
      this.lastProgress = percent;
      this.events.push({ type, percent, phase: params.phase });
      this.hooks.onEvent({ type, percent, phase: params.phase });
      return;
    }
    if (type === "log") {
      this.hooks.onEvent({ type, level: params.level, message: params.message });
      return;
    }
    if (type === "artifact") {
      this.hooks.onEvent({ type, name: params.name, path: params.path });
      return;
    }
    this.hooks.onLog(`Unknown agent.event type: ${type}`);
  }

  private async handleToolRequest(msg: any): Promise<void> {
    try {
      const result = await this.hooks.onToolCall(msg.params);
      this.write({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e: any) {
      this.write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32001,
          message: String(e?.code ?? "TOOL_DENIED"),
          data: { code: e?.code, step: e?.step, message: e?.message },
        },
      });
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.closed) {
      return Promise.reject(new AdapterCrash("AGENT_CRASHED", "Adapter has exited"));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterCrash("AGENT_TIMEOUT", `${method} timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async prepare(params: unknown, timeoutMs: number): Promise<any> {
    return this.request("agent.prepare", params, timeoutMs);
  }

  async execute(params: unknown, timeoutMs: number): Promise<AdapterResult> {
    this.resultNotify = null;
    const waitResult = new Promise<AdapterResult>((resolve) => {
      this.resultWaiter = resolve;
    });
    const response = this.request("agent.execute", params, timeoutMs).catch((e) => {
      // The execute response may arrive after agent.result; in that case the result notification takes precedence
      if (this.resultNotify) return null;
      throw e;
    });
    return Promise.race([
      waitResult,
      response.then((r) => (r as AdapterResult | null) ?? waitResult),
    ]);
  }

  async cancel(reason: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("agent.cancel", { reason }, 1500);
    } catch {
      // If the Agent does not respond to cancel, kill it forcibly; no orphan processes may be left behind
    }
    this.kill();
  }

  kill(): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AdapterCrash("AGENT_CANCELLED", "Adapter has stopped"));
    }
    this.pending.clear();
    if (this.child && !this.child.killed) this.child.kill("SIGKILL");
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.resultWaiter?.({ status: "FAILED", error: { code: "AGENT_CRASHED", message: e.message } });
  }

  private write(msg: unknown): void {
    if (!this.child || this.closed) return;
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }
}

export function redact(line: string): string {
  return line
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
    .replace(/((?:secret|token|password|passwd|api[_-]?key)\s*[=:]\s*)[^\s,"'}]+/gi, "$1<redacted>")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>");
}
