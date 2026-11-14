import type { AgentProfile } from "./types.js";
import type { AdapterEvent, AdapterHooks, AdapterResult } from "./stdio-adapter.js";
import { AdapterCrash } from "./stdio-adapter.js";

/**
 * localhost HTTP Adapter (`http-local`).
 *
 * The reference implementation only supports request/response and does not let the Adapter initiate tool.call in reverse—Agents
 * that need tool callbacks must use `stdio-jsonrpc`. This is stated explicitly in the README to avoid "looks like it's supported".
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
      throw new AdapterCrash("AGENT_PROFILE_INVALID", "http-local requires entrypoint[0] = http://127.0.0.1:<port>");
    }
    return u.replace(/\/+$/, "");
  }

  async start(): Promise<void> {
    await this.request("agent.health", {}, 5000);
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) throw new AdapterCrash("AGENT_CRASHED", "Adapter has exited");
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
      throw new AdapterCrash("AGENT_CRASHED", `Adapter unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const data = recordOf(await res.json().catch(() => ({}))) ?? {};
    if (!res.ok) throw new AdapterCrash("AGENT_CRASHED", `Adapter HTTP ${res.status}`);
    const events = Array.isArray(data.events) ? data.events : [];
    for (const ev of events) this.hooks.onEvent(ev as AdapterEvent);
    if (data.error !== undefined && data.error !== null) {
      const error = recordOf(data.error) ?? {};
      throw new AdapterCrash(String(error.code ?? "AGENT_RPC_ERROR"), String(error.message ?? "Adapter error"));
    }
    return data.result;
  }

  async prepare(params: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    return recordOf(await this.request("agent.prepare", params, timeoutMs)) ?? {};
  }

  async execute(params: unknown, timeoutMs: number): Promise<AdapterResult> {
    const out = await this.request("agent.execute", params, timeoutMs);
    return (recordOf(out) ?? { status: "FAILED" }) as unknown as AdapterResult;
  }

  async cancel(reason: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("agent.cancel", { reason }, 1500);
    } catch {
      // Stateless or already crashed
    }
    this.closed = true;
  }

  kill(): void {
    this.closed = true;
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type AnyAdapter = import("./stdio-adapter.js").StdioAdapter | HttpLocalAdapter;
