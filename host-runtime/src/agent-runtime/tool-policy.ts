import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ApiProfile, AgentProfile } from "./types.js";
import { TOOL_CATALOG } from "./types.js";

export class ToolDenied extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly step: number,
  ) {
    super(message);
    this.name = "ToolDenied";
  }
}

export interface ToolAuditRecord {
  ts: string;
  instance_id: string;
  attempt_id: string;
  task_id: string;
  tool_id: string;
  decision: "ALLOW" | "DENY";
  code?: string;
  step?: number;
  args_sha256?: string;
  duration_ms?: number;
  result_sha256?: string;
}

export type ToolAudit = (record: ToolAuditRecord) => void;

export interface ApiCallFn {
  (input: {
    api_profile_id: string;
    method: string;
    path: string;
    body?: string;
    scope?: string;
  }): Promise<unknown>;
}

export interface ToolGuardOptions {
  instanceId: string;
  attemptId: string;
  taskId: string;
  workspace: string;
  profile: AgentProfile;
  apiProfiles: Map<string, ApiProfile>;
  phase: string;
  approvedActionScope: string[];
  /** 每次 attempt 随机生成，只交给该 attempt 的 Adapter */
  toolToken: string;
  audit: ToolAudit;
  apiCall?: ApiCallFn;
  maxTurns?: number;
}

interface ToolCallInput {
  tool_id: string;
  args: Record<string, unknown>;
  tool_token: string;
  idempotency_key?: string;
}

/**
 * Tool Policy Guard（§3.6）。顺序固定，任何一步失败就拒绝。
 *
 * 模型输出只是“请求”，不是授权凭据；这里不看模型说了什么，
 * 只看实例身份、PCS Profile、任务阶段与参数本身。
 */
export class ToolGuard {
  private turns = 0;
  private readonly seen = new Map<string, { hash: string; result: unknown }>();

  constructor(private readonly opts: ToolGuardOptions) {
    if (!opts.toolToken) throw new Error("ToolGuard 需要每次 attempt 的 tool_token");
  }

  get turnsUsed(): number {
    return this.turns;
  }

  async call(raw: unknown): Promise<unknown> {
    const started = Date.now();
    let input: ToolCallInput | null = null;
    const deny = (code: string, message: string, step: number) => {
      const err = new ToolDenied(code, message, step);
      this.record({
        tool_id: input?.tool_id ?? "(invalid)",
        decision: "DENY",
        code,
        step,
        args_sha256: input ? sha256(stable(input.args)) : undefined,
        duration_ms: Date.now() - started,
      });
      return err;
    };

    try {
      // 1. 身份：调用必须来自当前 attempt，且持有本 attempt 的令牌
      input = parseCall(raw);
      if (!sameToken(input.tool_token, this.opts.toolToken)) {
        throw deny("TOOL_IDENTITY_MISMATCH", "tool_token 与当前 attempt 不匹配", 1);
      }
      this.turns++;
      if (this.opts.maxTurns !== undefined && this.turns > this.opts.maxTurns) {
        throw deny("TOOL_TURN_LIMIT", `工具调用超过 max_turns=${this.opts.maxTurns}`, 1);
      }

      // 2. Profile 权限；留空表示全部权限。只有平台已注册的 tool_id 才会收窄范围，
      //    面板里手填的其他词（描述性权限）不会误伤所有工具。
      const allowed = this.opts.profile.allowed_tools.filter((id) => TOOL_CATALOG[id]);
      if (allowed.length > 0 && !allowed.includes(input.tool_id)) {
        throw deny("TOOL_NOT_ALLOWED", `Agent Profile 未允许工具 ${input.tool_id}`, 2);
      }
      const descriptor = TOOL_CATALOG[input.tool_id];
      if (!descriptor) {
        throw deny("TOOL_UNKNOWN", `工具未在平台目录注册：${input.tool_id}`, 2);
      }

      // 3. 阶段
      if (descriptor.phases.length && !descriptor.phases.includes(this.opts.phase)) {
        throw deny(
          "TOOL_PHASE_DENIED",
          `阶段 ${this.opts.phase} 不允许工具 ${input.tool_id}`,
          3,
        );
      }

      // 4. 输入 Schema + 工作区路径
      validateArgs(input.tool_id, input.args, this.opts.workspace);

      // 5. 资源 / 网络 / 副作用
      for (const scope of descriptor.action_scopes) {
        if (!this.opts.approvedActionScope.includes(scope)) {
          throw deny("TOOL_SCOPE_DENIED", `缺少审批 action_scope：${scope}`, 5);
        }
      }
      if (descriptor.egress) {
        const apiId = String(input.args.api_profile_id ?? "");
        if (!this.opts.apiProfiles.has(apiId)) {
          throw deny("API_PROFILE_NOT_ALLOWED", `API ${apiId} 不在实例绑定内`, 5);
        }
      }

      // 6. 幂等：同键不同参数拒绝；同键同参数返回第一次结果
      const argsHash = sha256(stable(input.args));
      if (input.idempotency_key) {
        const prev = this.seen.get(input.idempotency_key);
        if (prev) {
          if (prev.hash !== argsHash) {
            throw deny("TOOL_IDEMPOTENCY_CONFLICT", "同一幂等键对应了不同参数", 6);
          }
          this.record({
            tool_id: input.tool_id,
            decision: "ALLOW",
            args_sha256: argsHash,
            result_sha256: sha256(stable(prev.result)),
            duration_ms: Date.now() - started,
          });
          return prev.result;
        }
      }

      // 执行（执行本身仍可能失败，但授权已经通过）
      const result = await this.execute(input);
      if (input.idempotency_key) {
        this.seen.set(input.idempotency_key, { hash: argsHash, result });
      }

      // 7. 审计：只记摘要，不记参数正文/密钥/工具返回全文
      this.record({
        tool_id: input.tool_id,
        decision: "ALLOW",
        args_sha256: argsHash,
        result_sha256: sha256(stable(result)),
        duration_ms: Date.now() - started,
      });
      return result;
    } catch (e) {
      if (e instanceof ToolDenied) throw e;
      // 执行层错误若自带稳定的错误码（如 EGRESS_IP_BLOCKED / ENOENT），保留它，
      // 否则审计与 Agent 只能看到笼统的 TOOL_EXECUTION_FAILED，无法定位拒绝原因。
      const rawCode = (e as { code?: unknown } | null)?.code;
      const code =
        typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(rawCode)
          ? rawCode
          : "TOOL_EXECUTION_FAILED";
      const message = e instanceof Error ? e.message : String(e);
      this.record({
        tool_id: input?.tool_id ?? "(invalid)",
        decision: "DENY",
        code,
        step: 7,
        duration_ms: Date.now() - started,
      });
      throw new ToolDenied(code, message, 7);
    }
  }

  private async execute(input: ToolCallInput): Promise<unknown> {
    const args = input.args;
    if (input.tool_id === "demo.echo") {
      return { echo: String(args.text ?? ""), tool: "demo.echo" };
    }
    if (input.tool_id === "workspace.write") {
      const rel = normalizeRel(String(args.path ?? ""));
      const file = path.join(this.opts.workspace, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(args.content ?? ""), "utf8");
      return { path: rel, bytes: Buffer.byteLength(String(args.content ?? "")) };
    }
    if (input.tool_id === "workspace.read") {
      const rel = normalizeRel(String(args.path ?? ""));
      const file = path.join(this.opts.workspace, rel);
      if (!fs.existsSync(file)) throw new Error(`文件不存在：${rel}`);
      return { path: rel, content: fs.readFileSync(file, "utf8") };
    }
    if (input.tool_id === "api.call") {
      if (!this.opts.apiCall) throw new Error("API Adapter 未启动");
      return this.opts.apiCall({
        api_profile_id: String(args.api_profile_id),
        method: String(args.method ?? "GET").toUpperCase(),
        path: String(args.path ?? "/"),
        body: args.body === undefined ? undefined : String(args.body),
        scope: args.scope === undefined ? undefined : String(args.scope),
      });
    }
    throw new Error(`工具没有实现：${input.tool_id}`);
  }

  private record(r: Omit<ToolAuditRecord, "ts" | "instance_id" | "attempt_id" | "task_id">): void {
    try {
      this.opts.audit({
        ts: new Date().toISOString(),
        instance_id: this.opts.instanceId,
        attempt_id: this.opts.attemptId,
        task_id: this.opts.taskId,
        ...r,
      });
    } catch {
      // 审计落盘失败不能反过来阻塞业务，但调用方仍有本地日志
    }
  }
}

function parseCall(raw: unknown): ToolCallInput {
  if (!raw || typeof raw !== "object") throw new ToolDenied("TOOL_INPUT_INVALID", "工具参数必须是对象", 1);
  const o = raw as Record<string, unknown>;
  if (typeof o.tool_id !== "string" || !o.tool_id) {
    throw new ToolDenied("TOOL_INPUT_INVALID", "缺少 tool_id", 1);
  }
  if (!o.args || typeof o.args !== "object" || Array.isArray(o.args)) {
    throw new ToolDenied("TOOL_INPUT_INVALID", "args 必须是对象", 1);
  }
  if (typeof o.tool_token !== "string") {
    throw new ToolDenied("TOOL_IDENTITY_MISMATCH", "缺少 tool_token", 1);
  }
  return {
    tool_id: o.tool_id,
    args: o.args as Record<string, unknown>,
    tool_token: o.tool_token,
    idempotency_key: typeof o.idempotency_key === "string" ? o.idempotency_key : undefined,
  };
}

function validateArgs(toolId: string, args: Record<string, unknown>, workspace: string): void {
  const fail = (m: string) => {
    throw new ToolDenied("TOOL_INPUT_INVALID", m, 4);
  };
  if (toolId === "demo.echo") {
    if (typeof args.text !== "string" || args.text.length > 2000) fail("demo.echo.text 必须是 <=2000 字符的字符串");
    return;
  }
  if (toolId === "workspace.write") {
    if (typeof args.path !== "string" || typeof args.content !== "string") fail("workspace.write 需要 path/content");
    if ((args.content as string).length > 1024 * 1024) fail("写入内容超过 1MiB");
    assertInsideWorkspace(args.path as string, workspace);
    return;
  }
  if (toolId === "workspace.read") {
    if (typeof args.path !== "string") fail("workspace.read 需要 path");
    assertInsideWorkspace(args.path as string, workspace);
    return;
  }
  if (toolId === "api.call") {
    if (typeof args.api_profile_id !== "string" || !args.api_profile_id) fail("需要 api_profile_id");
    const method = String(args.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) fail(`method 不允许：${method}`);
    if (typeof args.path !== "string" || !args.path.startsWith("/") || args.path.length > 512) {
      fail("path 必须是以 / 开头的相对路径");
    }
    const p = args.path as string;
    if (p.includes("..") || p.includes("//") || p.includes("\\") || /[\r\n]/.test(p)) fail("path 含非法段");
    if (args.body !== undefined && String(args.body).length > 64 * 1024) fail("body 超过 64KiB");
    if (args.scope !== undefined && typeof args.scope !== "string") fail("scope 必须是字符串");
    return;
  }
  fail(`工具没有参数校验规则：${toolId}`);
}

export function assertInsideWorkspace(rel: string, workspace: string): void {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) {
    throw new ToolDenied("WORKSPACE_PATH_DENIED", `路径必须位于工作区内：${rel}`, 4);
  }
  const root = path.resolve(workspace);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new ToolDenied("WORKSPACE_PATH_DENIED", `路径逃逸工作区：${rel}`, 4);
  }
}

function normalizeRel(rel: string): string {
  return rel.replace(/^\.\/+/, "");
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

function sha256(s: string): string {
  return `sha256:${createHash("sha256").update(s).digest("hex")}`;
}
