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
import { fetchVerified, type UpstreamRef } from "../roles/common.js";
import type { ApiProfile } from "./types.js";
import { materializeAttachments, mediaFor } from "./files.js";

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

function sanitizedTask(task: Assignment) {
  // Only business fields are given to the Adapter; scheduling semantics such as lease, fencing and host do not enter the Agent context
  return {
    task_id: task.task_id,
    task_type: task.task_type,
    attempt_id: task.attempt_id,
    payload_ref: task.payload_ref,
    payload_schema: task.payload_schema,
    requirements: task.requirements,
    // Continuity: a retried or resumed task starts with an empty workspace, so the Agent must know
    // it is joining mid-task instead of assuming a fresh request.
    attempt_number: task.attempt_number,
    // Autonomy is execution policy, not scheduling: the adapter maps it onto provider flags.
    approval_mode: task.approval_mode,
    deadline_at: task.deadline_at,
  };
}

/**
 * Upstream artifact limits. A resumed fan-out parent may receive the artifacts of many children;
 * the caps keep one bad tree from filling the disk. Entries over a cap are still listed for the
 * Agent with a `skipped` marker instead of silently disappearing.
 */
const MAX_UPSTREAM_FILES = 32;
const MAX_UPSTREAM_BYTES = 64 * 1024 * 1024;
const MAX_UPSTREAM_TOTAL_BYTES = 256 * 1024 * 1024;

/** Best-effort extension from the media type; the Agent may still open the file by path alone. */
function extForMedia(media: unknown): string {
  const type = String(media ?? "").toLowerCase();
  if (type.includes("json")) return ".json";
  if (type.includes("markdown")) return ".md";
  if (type.includes("x-patch") || type.includes("x-diff")) return ".patch";
  if (type.includes("text/plain")) return ".txt";
  if (type.includes("zip")) return ".zip";
  if (type.includes("tar")) return ".tar";
  if (type.startsWith("image/")) {
    const sub = type.slice(6).split(";")[0].replace(/[^a-z0-9]/g, "");
    return sub ? `.${sub}` : ".bin";
  }
  return ".bin";
}

/** Artifact ids and task types come from the scheduler, but a filename must never be able to escape the directory. */
function sanitizePart(value: unknown, fallback: string, max: number): string {
  const cleaned = String(value ?? "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+/, "")
    .slice(0, max);
  return cleaned || fallback;
}

/**
 * Download the artifacts handed over by upstream / sibling tasks into <workspace>/upstream/.
 *
 * A fan-out parent is resumed on a fresh builder with an empty workspace: the scheduler only has
 * references (artifact_id + digest), so without this step the Agent can read the children's
 * summaries but not their output. Every download is re-verified against the handoff digest
 * (roles/common.fetchVerified); a mismatch fails the attempt instead of feeding the Agent
 * unverified content. Entries that do not fit the workspace budget stay in the list with a
 * `skipped` marker so the Agent knows what is missing.
 */
async function materializeUpstreamArtifacts(
  task: Assignment,
  ctx: ExecContext,
): Promise<Assignment> {
  const requirements = task.requirements ?? {};
  const raw = requirements.upstream_artifacts;
  if (!Array.isArray(raw) || raw.length === 0) return task;

  const dir = path.join(ctx.workspaceDir, "upstream");
  fs.mkdirSync(dir, { recursive: true });
  const materialized: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const used = new Set<string>();
  let total = 0;

  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!item || typeof item !== "object") continue;
    const ref = item as Record<string, unknown>;
    const id = typeof ref.artifact_id === "string" ? ref.artifact_id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    if (materialized.length >= MAX_UPSTREAM_FILES) {
      materialized.push({ ...ref, skipped: "too_many" });
      continue;
    }

    let buf: Buffer;
    try {
      buf = await fetchVerified(ctx, ref as unknown as UpstreamRef);
    } catch (e) {
      if (e instanceof TaskFailed) throw e;
      throw new TaskFailed(
        "UPSTREAM_ARTIFACT_FETCH_FAILED",
        `Failed to download upstream artifact ${id}: ${e instanceof Error ? e.message : String(e)}`,
        { artifact_id: id },
      );
    }

    if (buf.length > MAX_UPSTREAM_BYTES) {
      materialized.push({ ...ref, skipped: "too_large", size_bytes: buf.length });
      continue;
    }
    if (total + buf.length > MAX_UPSTREAM_TOTAL_BYTES) {
      materialized.push({ ...ref, skipped: "workspace_budget", size_bytes: buf.length });
      continue;
    }
    total += buf.length;

    const type = sanitizePart(ref.task_type, "artifact", 40);
    const short = sanitizePart(id, `a${index}`, 24);
    let name = `${index + 1}-${type}-${short}${extForMedia(ref.media_type)}`;
    if (used.has(name)) {
      const ext = path.extname(name);
      name = `${name.slice(0, name.length - ext.length)}-${index}${ext}`;
    }
    const file = path.join(dir, name);
    if (!file.startsWith(dir + path.sep)) continue;
    used.add(name);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    materialized.push({
      ...ref,
      path: `upstream/${name}`,
      size_bytes: buf.length,
      verified: true,
    });
  }

  ctx.log(`Wrote ${materialized.filter((r) => typeof r.path === "string").length} upstream artifact(s) to workspace upstream/`);
  return { ...task, requirements: { ...requirements, upstream_artifacts: materialized } };
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
  // Outward actions are forwarded the moment they are announced, before the side effect happens;
  // the set is only used to de-duplicate the report at the end.
  const outward = new Set<string>();
  const recordOutward = (action: string) => {
    const label = action.trim().slice(0, 200);
    if (!label || outward.has(label)) return;
    outward.add(label);
    ctx.outward?.(label);
  };
  const hooks = {
    onEvent: (e: AdapterEvent) => {
      events.push(e);
      if (e.type === "outward") {
        recordOutward(String(e.action ?? "external side effect"));
      } else if (e.type === "progress" && typeof e.percent === "number") {
        ctx.progress(e.percent, e.phase);
      } else if (e.type === "log") {
        ctx.log(`agent: ${redact(String(e.message ?? "")).slice(0, 2000)}`);
      } else if (e.type === "artifact") {
        const p = String(e.path ?? "");
        try {
          assertInsideWorkspace(p.replace(/^\.\/+/, ""), ctx.workspaceDir);
          artifactPaths.push({ name: String(e.name ?? "artifact"), path: p });
        } catch (err) {
          artifactError = new TaskFailed(
            "ARTIFACT_PATH_DENIED",
            err instanceof Error ? err.message : "Artifact path is outside the workspace",
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

  let agentTask = await materializeAttachments(task, ctx.workspaceDir);
  if (agentTask !== task) {
    const count = (agentTask.requirements.build as Record<string, unknown>).attachments as unknown[];
    ctx.log(`Wrote ${count.length} attachments to workspace attachments/`);
  }
  // Fan-out handoff: a resumed parent runs on a fresh builder, so children's artifacts must be
  // fetched here before the Agent starts, not left as references it cannot resolve.
  agentTask = await materializeUpstreamArtifacts(agentTask, ctx);

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
      throw new TaskFailed("AGENT_NOT_READY", "Agent prepare is not ready", prepared);
    }

    const result = await adapter.execute(
      { task: sanitizedTask(agentTask), workspace: ctx.workspaceDir },
      wallSeconds * 1000,
    );
    if (aborted) throw new TaskAborted(ctx.signal.reason === "lease_lost" ? "lease_lost" : "cancelled");
    if (artifactError) throw artifactError;
    // Actions the adapter only knew about at the end still go through the same report path.
    for (const action of result?.outward_actions ?? []) recordOutward(String(action));

    if (result?.status === "NEEDS_INPUT") {
      const question = String(result.question ?? result.summary ?? "").trim();
      if (!question) {
        throw new TaskFailed("QUESTION_MISSING", "The agent asked for input without stating a question");
      }
      return {
        summary: question.slice(0, 2000),
        question: question.slice(0, 8000),
        outward: [...outward],
      };
    }
    if (result?.status === "SPLIT") {
      const split = (result.split ?? []).filter((ch) => ch && typeof ch === "object");
      if (!split.length) {
        throw new TaskFailed("SPLIT_EMPTY", "The agent requested a split without any child task");
      }
      return {
        summary: String(result.summary ?? `Split into ${split.length} child task(s)`),
        split,
        outward: [...outward],
      };
    }
    if (!result || result.status === "FAILED") {
      // The error detail may carry the provider's reset time; the scheduler decides what to do with it.
      throw new TaskFailed(
        String(result?.error?.code ?? "AGENT_FAILED"),
        String(result?.error?.message ?? result?.summary ?? "Agent returned a failure"),
        result?.error?.detail,
      );
    }

    const outputs: Array<{ name: string; artifact_id: string; sha256: string; size_bytes: number }> = [];
    for (const out of result.outputs ?? []) {
      const rel = out.path.replace(/^\.\/+/, "");
      assertInsideWorkspace(rel, ctx.workspaceDir);
      const file = path.join(ctx.workspaceDir, rel);
      if (!fs.existsSync(file)) {
        throw new TaskFailed("AGENT_OUTPUT_MISSING", `Artifact declared by the Agent does not exist: ${rel}`);
      }
      const uploaded = await ctx.uploadArtifact(fs.readFileSync(file), mediaFor(rel));
      outputs.push({ name: out.name, ...uploaded });
    }
    // Artifacts declared in artifact events but absent from result.outputs are only noted in the log, not uploaded automatically
    for (const e of artifactPaths) {
      if (!outputs.some((o) => o.name === e.name)) {
        ctx.log(`Agent event declared artifact ${e.name} but it was not returned in the final result; ignored`);
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
      summary: String(result.summary ?? `Agent ${profile.agent_profile_id} execution completed`),
      outputs: outputsPayload,
      outward: [...outward],
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
