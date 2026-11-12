import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TaskAborted, TaskFailed, type ExecContext, type ExecOutcome } from "../exec-types.js";
import type { Assignment } from "../client.js";
import type { ApiAdapter } from "./api-adapter.js";
import type { RuntimeProfiles } from "./profiles.js";
import { AdapterCrash, StdioAdapter, redact, type AdapterEvent } from "./stdio-adapter.js";
import { HttpLocalAdapter } from "./http-local-adapter.js";
import { ToolDenied, ToolGuard, assertInsideWorkspace, type ToolAuditRecord } from "./tool-policy.js";
import type { ApiProfile } from "./types.js";

export interface AgentExecutionOptions {
  profiles: RuntimeProfiles;
  apiAdapter?: ApiAdapter;
  toolAudit: (r: ToolAuditRecord) => void;
  maxWallSeconds?: number;
}

function phaseFor(taskType: string): string {
  if (taskType === "task.build") return "EXECUTE";
  if (taskType === "task.review.snapshot") return "REVIEW";
  if (taskType === "task.commit") return "COMMIT";
  if (taskType === "task.test.run") return "VERIFY";
  if (taskType.startsWith("task.ticket.")) return taskType.split(".")[2].toUpperCase();
  return "EXECUTE";
}

function mediaFor(file: string): string {
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".patch") || file.endsWith(".diff")) return "text/x-patch";
  if (file.endsWith(".md")) return "text/markdown";
  if (file.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

function sanitizedTask(task: Assignment) {
  // 只给 Adapter 业务字段；租约、fencing、主机等调度语义不进入 Agent 上下文
  return {
    task_id: task.task_id,
    task_type: task.task_type,
    attempt_id: task.attempt_id,
    payload_ref: task.payload_ref,
    payload_schema: task.payload_schema,
    requirements: task.requirements,
    deadline_at: task.deadline_at,
  };
}

/** 附件上限：任务请求体本身有上限，这里再兜一层，防止异常载荷写满工作区。 */
const MAX_ATTACHMENT_FILES = 16;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 128 * 1024 * 1024;

function attachmentName(raw: unknown, index: number): string {
  const source = typeof raw === "string" ? raw.replace(/\\/g, "/") : "";
  const base = path
    .basename(source)
    .replace(/[^\p{L}\p{N}._()\- ]/gu, "_")
    .trim()
    .slice(0, 120);
  const name = base && base !== "." && base !== ".." ? base : `attachment-${index + 1}`;
  return name.startsWith(".") ? `_${name}` : name;
}

/** 取附件内容：优先用控制面的一次性地址，兼容旧任务里的 base64。 */
async function loadAttachment(rec: Record<string, unknown>): Promise<Buffer | null> {
  let data = String(rec.data_base64 ?? "");
  const comma = data.indexOf(",");
  if (data.startsWith("data:") && comma >= 0) data = data.slice(comma + 1);
  if (data) {
    const buf = Buffer.from(data, "base64");
    return buf.length ? buf : null;
  }
  const rawUrl = typeof rec.url === "string" ? rec.url.trim() : "";
  if (!rawUrl) return null;
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new TaskFailed("ATTACHMENT_URL_INVALID", "附件地址不合法");
  }
  // 只允许 http(s)；任务里的地址不应把构建机引到 file:/gopher: 之类的协议。
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TaskFailed("ATTACHMENT_URL_INVALID", "附件地址必须是 http 或 https");
  }
  let res: Response;
  try {
    res = await fetch(target, {
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
  } catch (err: any) {
    throw new TaskFailed(
      "ATTACHMENT_FETCH_FAILED",
      `取附件失败：${String(err?.message ?? err)}`,
    );
  }
  if (!res.ok) {
    throw new TaskFailed("ATTACHMENT_FETCH_FAILED", `取附件失败：HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length ? buf : null;
}

/**
 * 把任务附件落到 <workspace>/attachments/，再把路径交给 Agent。
 *
 * 附件内容只在这一步进内存；Agent 拿到的是文件路径和元数据。大文件通过
 * 控制面的一次性地址下载，任务 JSON 本身保持很小。
 */
async function materializeAttachments(
  task: Assignment,
  workspaceDir: string,
): Promise<Assignment> {
  const requirements = task.requirements ?? {};
  const build = requirements.build;
  if (!build || typeof build !== "object") return task;
  const list = (build as Record<string, unknown>).attachments;
  if (!Array.isArray(list) || list.length === 0) return task;

  const dir = path.join(workspaceDir, "attachments");
  fs.mkdirSync(dir, { recursive: true });
  const materialized: Array<Record<string, unknown>> = [];
  const used = new Set<string>();
  let total = 0;

  for (let i = 0; i < list.length && materialized.length < MAX_ATTACHMENT_FILES; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const buf = await loadAttachment(rec);
    if (!buf) continue;
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      throw new TaskFailed("ATTACHMENT_TOO_LARGE", "附件超过 32MiB");
    }
    total += buf.length;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) break;

    let name = attachmentName(rec.name, i);
    if (used.has(name)) {
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n++;
      name = `${stem}-${n}${ext}`;
    }
    const file = path.join(dir, name);
    if (!file.startsWith(dir + path.sep)) continue;
    used.add(name);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    materialized.push({
      name,
      path: `attachments/${name}`,
      media_type: typeof rec.media_type === "string" ? rec.media_type : "application/octet-stream",
      size_bytes: buf.length,
    });
  }

  const nextBuild = { ...(build as Record<string, unknown>), attachments: materialized };
  return { ...task, requirements: { ...requirements, build: nextBuild } };
}

/**
 * 宿主 → Agent 适配器的环境变量放行表。
 *
 * agent-executor 交给适配器的 env 是白名单构造的，不是 process.env 的拷贝：
 * 实例令牌、Docker Socket、云厂商凭据都不该因为“是子进程”就被自动继承。
 * 模型凭据因此要在部署时显式列出（PLATFORM_AGENT_PASS_ENV=ANTHROPIC_API_KEY,...），
 * 再由 Profile 的 --pass-env 决定哪些真正交给外部 CLI——两层都显式，
 * 少配一层就只是 Agent 起不来，而不是密钥意外外泄。
 */
function agentPassEnv(): string[] {
  return (process.env.PLATFORM_AGENT_PASS_ENV ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
}

function apiHandles(profiles: RuntimeProfiles, adapter?: ApiAdapter) {
  return [...profiles.api.values()].map((p: ApiProfile) => ({
    api_profile_id: p.api_profile_id,
    kind: p.kind,
    // Agent 只拿到本地代理句柄，不是 base_url，更不是 secret
    handle: adapter ? `${adapter.url}/${encodeURIComponent(p.api_profile_id)}` : null,
    scopes: p.scopes,
  }));
}

/**
 * Agent-backed 执行器。
 *
 * 与确定性角色执行器共用 ExecContext；区别只在于“谁来做”，
 * 上传制品、摘要校验、结果上报的路径完全一致。
 */
export async function runAgentTask(
  task: Assignment,
  ctx: ExecContext,
  opts: AgentExecutionOptions,
): Promise<ExecOutcome> {
  const profile = opts.profiles.agent;
  const toolToken = randomBytes(24).toString("base64url");
  const phase = phaseFor(task.task_type);
  const start = Date.now();
  const maxWall =
    opts.maxWallSeconds ??
    profile.limits?.max_wall_seconds ??
    3600;
  const deadline = task.deadline_at ? Date.parse(task.deadline_at) : Number.NaN;
  const remaining = Number.isFinite(deadline) ? Math.max(1, Math.floor((deadline - Date.now()) / 1000)) : maxWall;
  const wallSeconds = Math.max(1, Math.min(maxWall, remaining));
  const maxTurns = profile.limits?.max_turns;

  const guard = new ToolGuard({
    instanceId: ctx.instanceId,
    attemptId: task.attempt_id,
    taskId: task.task_id,
    workspace: ctx.workspaceDir,
    profile,
    apiProfiles: opts.profiles.api,
    phase,
    approvedActionScope: Array.isArray(task.requirements?.approved_action_scope)
      ? (task.requirements.approved_action_scope as string[])
      : [],
    toolToken,
    audit: opts.toolAudit,
    maxTurns,
    apiCall: opts.apiAdapter
      ? async (input) => {
          const out = await opts.apiAdapter!.call(input.api_profile_id, input.method, input.path, {
            body: input.body,
          });
          // 工具返回内容是不可信输入；这里只做结构包装，不据此扩权
          return {
            untrusted: true,
            status: out.status,
            content_type: out.contentType,
            body: out.body.toString("utf8").slice(0, 64 * 1024),
          };
        }
      : undefined,
  });

  const events: AdapterEvent[] = [];
  const artifactPaths: Array<{ name: string; path: string }> = [];
  let artifactError: TaskFailed | null = null;
  const hooks = {
    onEvent: (e: AdapterEvent) => {
      events.push(e);
      if (e.type === "progress" && typeof e.percent === "number") {
        ctx.progress(e.percent, e.phase);
      } else if (e.type === "log") {
        ctx.log(`agent: ${redact(String(e.message ?? "")).slice(0, 2000)}`);
      } else if (e.type === "artifact") {
        const p = String(e.path ?? "");
        try {
          assertInsideWorkspace(p.replace(/^\.\/+/, ""), ctx.workspaceDir);
          artifactPaths.push({ name: String(e.name ?? "artifact"), path: p });
        } catch (err: any) {
          artifactError = new TaskFailed(
            "ARTIFACT_PATH_DENIED",
            String(err?.message ?? "制品路径不在工作区"),
          );
        }
      }
    },
    onLog: (line: string) => ctx.log(redact(line).slice(0, 2000)),
    onToolCall: (params: unknown) => guard.call(params),
  };

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: ctx.workspaceDir,
    TMPDIR: ctx.workspaceDir,
    PLATFORM_INSTANCE_ID: ctx.instanceId,
    PLATFORM_ATTEMPT_ID: task.attempt_id,
    PLATFORM_TASK_ID: task.task_id,
    PLATFORM_TASK_TYPE: task.task_type,
    PLATFORM_WORKSPACE: ctx.workspaceDir,
    PLATFORM_TOOL_TOKEN: toolToken,
    PLATFORM_PHASE: phase,
    PLATFORM_DEADLINE: task.deadline_at ?? "",
    PLATFORM_API_PROFILES: JSON.stringify(apiHandles(opts.profiles, opts.apiAdapter)),
    // Agent 的人格配置；不含任何密钥，供适配器拼进提示词。
    PLATFORM_AGENT_PROFILE: JSON.stringify({
      name: profile.name,
      role_id: profile.role_id,
      description: profile.description ?? "",
      system_prompt: profile.system_prompt ?? "",
      persona: profile.persona ?? "",
      tone: profile.tone ?? "",
      goals: profile.goals ?? "",
    }),
  };
  if (opts.apiAdapter) env.PLATFORM_API_PROXY = opts.apiAdapter.url;
  // 只放行部署方显式列出的变量；平台自身前缀的一律拒绝，避免误配把
  // 工具令牌或 API 代理句柄交给 Agent。
  for (const name of agentPassEnv()) {
    if (name.startsWith("PLATFORM_")) continue;
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }

  const adapter =
    profile.adapter === "http-local"
      ? new HttpLocalAdapter(profile, hooks)
      : new StdioAdapter(profile, ctx.workspaceDir, env, hooks);

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void adapter.cancel(String(ctx.signal.reason ?? "cancelled"));
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const agentTask = await materializeAttachments(task, ctx.workspaceDir);
  if (agentTask !== task) {
    const count = (agentTask.requirements.build as Record<string, unknown>).attachments as unknown[];
    ctx.log(`已把 ${count.length} 个附件写入工作区 attachments/`);
  }

  try {
    await adapter.start();

    const prepared = await adapter.prepare(
      {
        task: sanitizedTask(agentTask),
        workspace: ctx.workspaceDir,
        api_profiles: apiHandles(opts.profiles, opts.apiAdapter),
        deadline: task.deadline_at,
      },
      10_000,
    );
    if (aborted) throw new TaskAborted(ctx.signal.reason === "lease_lost" ? "lease_lost" : "cancelled");
    if (!prepared || prepared.ready !== true) {
      throw new TaskFailed("AGENT_NOT_READY", "Agent prepare 未就绪", prepared);
    }

    const result = await adapter.execute(
      { task: sanitizedTask(agentTask), workspace: ctx.workspaceDir },
      wallSeconds * 1000,
    );
    if (aborted) throw new TaskAborted(ctx.signal.reason === "lease_lost" ? "lease_lost" : "cancelled");
    if (artifactError) throw artifactError;
    if (!result || result.status === "FAILED") {
      throw new TaskFailed(
        String(result?.error?.code ?? "AGENT_FAILED"),
        String(result?.error?.message ?? result?.summary ?? "Agent 返回失败"),
      );
    }

    const outputs: Array<{ name: string; artifact_id: string; sha256: string; size_bytes: number }> = [];
    for (const out of result.outputs ?? []) {
      const rel = out.path.replace(/^\.\/+/, "");
      assertInsideWorkspace(rel, ctx.workspaceDir);
      const file = path.join(ctx.workspaceDir, rel);
      if (!fs.existsSync(file)) {
        throw new TaskFailed("AGENT_OUTPUT_MISSING", `Agent 声明的产物不存在：${rel}`);
      }
      const uploaded = await ctx.uploadArtifact(fs.readFileSync(file), mediaFor(rel));
      outputs.push({ name: out.name, ...uploaded });
    }
    // artifact 事件里声明但没有出现在 result.outputs 的，也只在日志提示，不自动上传
    for (const e of artifactPaths) {
      if (!outputs.some((o) => o.name === e.name)) {
        ctx.log(`Agent 事件声明了产物 ${e.name}，但未在最终 result 中返回，已忽略`);
      }
    }

    const outputsPayload: Record<string, unknown> = {
      agent_profile_id: profile.agent_profile_id,
      agent_version: profile.version,
      adapter: profile.adapter,
      tool_calls: {
        used: guard.turnsUsed,
      },
      artifacts: outputs,
      metrics: result.metrics ?? {},
      duration_ms: Date.now() - start,
      log_events: events.filter((e) => e.type === "log").length,
    };
    if (task.task_type.startsWith("task.chat.")) {
      // 对话任务的回复优先取适配器显式 reply，其次才退回 summary。
      // 上层据此渲染气泡；不把 Agent 的原始日志当成回复。
      outputsPayload.reply = String(result.reply ?? result.summary ?? "");
      outputsPayload.mode = "agent";
    }

    return {
      summary: String(result.summary ?? `Agent ${profile.agent_profile_id} 执行完成`),
      outputs: outputsPayload,
    };
  } catch (e) {
    if (e instanceof TaskAborted || e instanceof TaskFailed) throw e;
    if (e instanceof ToolDenied) {
      throw new TaskFailed(e.code, e.message, { step: e.step });
    }
    if (e instanceof AdapterCrash) {
      if (aborted) throw new TaskAborted(ctx.signal.reason === "lease_lost" ? "lease_lost" : "cancelled");
      throw new TaskFailed(e.code, e.message);
    }
    throw new TaskFailed("AGENT_ERROR", e instanceof Error ? e.message : String(e));
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    adapter.kill();
  }
}
