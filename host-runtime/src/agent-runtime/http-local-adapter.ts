import type { AgentProfile } from "./types.js";
import type { AdapterHooks, AdapterResult } from "./stdio-adapter.js";
import { AdapterCrash } from "./stdio-adapter.js";

/**
 * localhost HTTP Adapter（`http-local`）。
 *
 * 参考实现只支持请求/响应，不支持 Adapter 反向发起 tool.call——需要工具回调的
 * Agent 必须用 `stdio-jsonrpc`。这一点在 README 中明确写出，避免“看起来支持”。
 */
export class HttpLocalAdapter {
  private seq = 0;
  private closed = false;

  constructor(
    private readonly profile: AgentProfile,
    private readonly hooks: AdapterHooks,
  ) {}

  private get base(): string {
    const u = this.profile.entrypoint[0];
    if (!u || !/^https?:\/\//.test(u)) {
      throw new AdapterCrash("AGENT_PROFILE_INVALID", "http-local 需要 entrypoint[0] = http://127.0.0.1:<port>");
    }
    return u.replace(/\/+$/, "");
  }

  async start(): Promise<void> {
    await this.request("agent.health", {}, 5000);
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.closed) throw new AdapterCrash("AGENT_CRASHED", "Adapter 已退出");
    const id = ++this.seq;
    let res: Response;
    try {
      res = await fetch(this.base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new AdapterCrash("AGENT_CRASHED", `Adapter 不可达：${e instanceof Error ? e.message : String(e)}`);
    }
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new AdapterCrash("AGENT_CRASHED", `Adapter HTTP ${res.status}`);
    for (const ev of data.events ?? []) this.hooks.onEvent(ev);
    if (data.error) {
      throw new AdapterCrash(String(data.error.code ?? "AGENT_RPC_ERROR"), String(data.error.message ?? "Adapter 错误"));
    }
    return data.result;
  }

  prepare(params: unknown, timeoutMs: number): Promise<any> {
    return this.request("agent.prepare", params, timeoutMs);
  }

  async execute(params: unknown, timeoutMs: number): Promise<AdapterResult> {
    const out = await this.request("agent.execute", params, timeoutMs);
    return out as AdapterResult;
  }

  async cancel(reason: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("agent.cancel", { reason }, 1500);
    } catch {
      // 无状态或已崩溃
    }
    this.closed = true;
  }

  kill(): void {
    this.closed = true;
  }
}

export type AnyAdapter = import("./stdio-adapter.js").StdioAdapter | HttpLocalAdapter;
