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
  // Only business fields are given to the Adapter; scheduling semantics such as lease, fencing and host do not enter the Agent context
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

/** Attachment limits: the task request body already has a limit; this adds another layer so an abnormal payload cannot fill the workspace. */
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

/** Fetch attachment content: prefer the control plane's one-time URL, with compatibility for base64 in older tasks. */
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
  // Only http(s) is allowed; a task URL should not lead the builder to schemes such as file:/gopher:.
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
 * Materialize task attachments under <workspace>/attachments/, then hand the paths to the Agent.
 *
 * Attachment content enters memory only at this step; the Agent receives file paths and metadata. Large files are downloaded
 * via the control plane's one-time URL, keeping the task JSON itself small.
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
 * Host → Agent adapter environment variable allowlist.
 *
 * The env that agent-executor gives the adapter is built from an allowlist, not a copy of process.env:
 * instance tokens, the Docker Socket and cloud provider credentials should not be inherited automatically just because "it is a child process".
 * Model credentials therefore must be listed explicitly at deploy time (PLATFORM_AGENT_PASS_ENV=ANTHROPIC_API_KEY,...),
 * and then the Profile's --pass-env decides which are actually handed to the external CLI—both layers are explicit,
 * so missing one layer only means the Agent fails to start, not that a secret leaks by accident.
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
    // The Agent only gets the local proxy handle, not a base_url, and certainly not a secret
    handle: adapter ? `${adapter.url}/${encodeURIComponent(p.api_profile_id)}` : null,
    scopes: p.scopes,
  }));
}

/**
 * Agent-backed executor.
 *
 * Shares ExecContext with the deterministic role executors; the only difference is "who does it",
 * while artifact upload, digest verification and result reporting follow exactly the same path.
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
          // Tool return content is untrusted input; this only wraps it structurally and does not expand privileges based on it
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
    // The Agent's persona config; contains no secrets, for the adapter to assemble into the prompt.
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
  // Pass through only variables the deployer listed explicitly; anything with the platform's own prefix is rejected, so a misconfiguration cannot
  // hand the tool token or API proxy handle to the Agent.
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
    // Artifacts declared in artifact events but absent from result.outputs are only noted in the log, not uploaded automatically
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
      // For chat tasks, prefer the adapter's explicit reply, falling back to summary only second.
      // The layer above renders bubbles from this; the Agent's raw log is not treated as the reply.
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
