import { t } from "../i18n";
import type {
  BuilderOs,
  CapabilityDetail,
  HostRoleMode,
  Role,
  TaskAttachment,
  TaskAttachmentRef,
  TaskEvent,
} from "../types";
import { ApiError, pcs, scheduler, schedulerFor } from "./client";
import type { LiveConnection } from "./config";
import type {
  DeploymentRow,
  DeploymentsResponse,
  TaskDetailResponse,
  TaskEventsResponse,
} from "./rows";

const MIB = 1024 ** 2;

export async function testConnection(connection: LiveConnection): Promise<void> {
  await scheduler(connection, "/healthz");
  // The control plane is optional: needed only to create builders; failure to connect does not block entering live mode.
  if (connection.pcsUrl) {
    try {
      await pcs(connection, "/api/v1/platform/hosts");
    } catch {
      // ignore
    }
  }
}

/**
 * Host onboarding: the private key is sent with this request only; the control plane stores it encrypted and returns only a fingerprint.
 * Nothing is persisted locally here; it is lost when the component unmounts.
 */
export async function addSshHost(
  connection: LiveConnection,
  input: {
    name?: string;
    address: string;
    port?: number;
    user?: string;
    /** Private key auth; mutually exclusive with password. */
    private_key?: string;
    /** Password auth; mutually exclusive with private_key. */
    password?: string;
  },
): Promise<{ host_id: string; key_fingerprint: string; probe: unknown }> {
  if (!connection.pcsUrl) throw new Error(t("未配置控制面地址，无法添加主机"));
  return pcs(connection, "/api/v1/platform/hosts/ssh", { method: "POST", body: input });
}

/** Edit an onboarded host; leaving the private key empty keeps the existing key. */
export async function updateHost(
  connection: LiveConnection,
  hostId: string,
  input: {
    name?: string;
    address?: string;
    port?: number;
    user?: string;
    private_key?: string;
    password?: string;
    role_mode?: HostRoleMode;
    /** Choices for the bare-metal builder created by the role switch. */
    native_builder?: {
      display_name?: string;
      agent_profile_id?: string;
      api_profile_ids?: string[];
    };
  },
): Promise<{
  host_id: string;
  key_fingerprint: string | null;
  probe: unknown;
  role_mode?: HostRoleMode;
  native_builder?: { deployment_id: string; created: boolean; status: string };
  warning?: string;
}> {
  if (!connection.pcsUrl) throw new Error(t("未配置控制面地址，无法修改主机"));
  return pcs(connection, `/api/v1/platform/hosts/${encodeURIComponent(hostId)}`, {
    method: "PATCH",
    body: input,
  });
}

export async function addLocalHost(
  connection: LiveConnection,
  name?: string,
): Promise<{ host_id: string; created: boolean; probe: unknown }> {
  if (!connection.pcsUrl) throw new Error(t("未配置控制面地址，无法添加主机"));
  return pcs(connection, "/api/v1/platform/hosts/local", { method: "POST", body: { name } });
}

/** Bootstrap host-runtime: install and start the resident daemon, then wait for the host to join. */
export async function bootstrapHost(
  connection: LiveConnection,
  hostId: string,
): Promise<{ online: boolean; status: string; log?: string }> {
  if (!connection.pcsUrl) throw new Error(t("未配置控制面地址，无法引导主机"));
  return pcs(connection, `/api/v1/platform/hosts/${encodeURIComponent(hostId)}/bootstrap`, {
    method: "POST",
  });
}

export async function probeHost(
  connection: LiveConnection,
  hostId: string,
): Promise<unknown> {
  if (!connection.pcsUrl) throw new Error(t("未配置控制面地址，无法探测主机"));
  const out = await pcs(
    connection,
    `/api/v1/platform/hosts/${encodeURIComponent(hostId)}/probe`,
    { method: "POST" },
  );
  return out?.probe;
}

/** Fold hosts: only the federation tree changes; no scheduler is restarted. */
export async function mergeHost(
  connection: LiveConnection,
  hostId: string,
  parentHostId: string,
): Promise<void> {
  if (!connection.pcsUrl) throw new Error(t("未配置控制面地址，无法并入主机"));
  await pcs(connection, `/api/v1/platform/hosts/${encodeURIComponent(hostId)}/merge`, {
    method: "POST",
    body: { parent_host_id: parentHostId },
  });
}

/** Unfold: the host becomes a root of the federation tree again. */
export async function unmergeHost(connection: LiveConnection, hostId: string): Promise<void> {
  if (!connection.pcsUrl) throw new Error(t("未配置控制面地址，无法解除并入"));
  await pcs(connection, `/api/v1/platform/hosts/${encodeURIComponent(hostId)}/unmerge`, {
    method: "POST",
  });
}

/** Create a builder through the control plane: generate a deployment plan first, then apply it with the plan digest. */
export async function createBuilder(
  connection: LiveConnection,
  input: {
    host_id: string;
    /** Instance name; if empty, the control plane continues automatically per host. */
    name?: string;
    os: BuilderOs;
    count: number;
    tier?: string;
    cpus: number;
    mem_mb: number;
    disk_gb: number;
    agent_profile_id: string;
    api_profile_ids: string[];
    image: string;
    ports?: Array<{ container: number; host: number }>;
    /** Which scheduler to register with (deployment_id). */
    scheduler_id?: string;
    capability_detail?: CapabilityDetail;
  },
): Promise<void> {
  if (!connection.pcsUrl) throw new Error(t("未配置控制面地址，无法创建构建机"));
  const plan = await pcs(connection, "/api/v1/platform/deployment-plans", {
    method: "POST",
    body: {
      host_id: input.host_id,
      role_id: "builder",
      // The name is a display name (Chinese allowed); the instance id is derived from it by the control plane and is not sent from the UI.
      ...(input.name ? { display_name: input.name } : {}),
      count: Math.max(1, Math.min(4, input.count)),
      agent_profile_id: input.agent_profile_id,
      api_profile_ids: input.api_profile_ids,
      image: input.image,
      builder_os: input.os,
      ports: input.ports ?? [],
      ...(input.scheduler_id ? { scheduler_id: input.scheduler_id } : {}),
      // The environment persists across deployments: the state volume is isolated per instance, while the apt deb cache is shared per host.
      volumes: [
        { name: "state", mount: "/opt/platform/state" },
        { name: "shared-apt-cache", mount: "/opt/platform/apt-cache" },
      ],
      resource_profile: {
        cpu_limit: input.cpus,
        memory_limit_bytes: input.mem_mb * MIB,
        pids_limit: input.mem_mb >= 4096 ? 1024 : 512,
      },
      network_policy: "default",
      labels: { os: input.os, disk_gb: String(input.disk_gb), ...(input.tier ? { tier: input.tier } : {}) },
      // W is frozen by the control plane after weighting the six details; the scheduler filters tasks by difficulty when claiming them.
      ...(input.capability_detail ? { capability_detail: input.capability_detail } : {}),
    },
  });
  await pcs(
    connection,
    `/api/v1/platform/deployment-plans/${encodeURIComponent(String(plan.plan_id))}/apply`,
    { method: "POST", body: { plan_digest: plan.plan_digest } },
  );
}

/**
 * Deploy a scheduler: each host has at most one root scheduler; node schedulers hang under a parent scheduler on the same host.
 *
 * Instance names are unique only within a host: root and nodes on the same host each use their own name.
 * Image, DATABASE_URL and parent scheduler address are injected by the control plane without passing through the browser;
 * only the role, parent-child relationship and Agent / API Profile bindings are sent here.
 */
export async function createScheduler(
  connection: LiveConnection,
  input: {
    host_id: string;
    /** Display name (Chinese allowed); the instance id is derived from it by the control plane. */
    name: string;
    role: "root" | "node";
    parent_scheduler_id?: string;
    agent_profile_id: string;
    api_profile_ids: string[];
    port: number;
    ssh_port: number;
    cpus: number;
    mem_mb: number;
    /** Inherited by the schedulers and builders deployed under this root; node schedulers always inherit. */
    scheduling_mode?: "static" | "dynamic";
  },
): Promise<void> {
  if (!connection.pcsUrl) throw new Error(t("未配置控制面地址，无法部署调度机"));
  const plan = await pcs(connection, "/api/v1/platform/deployment-plans", {
    method: "POST",
    body: {
      host_id: input.host_id,
      role_id: "scheduler",
      scheduler_role: input.role,
      ...(input.role === "node" && input.parent_scheduler_id
        ? { parent_scheduler_id: input.parent_scheduler_id }
        : {}),
      count: 1,
      display_name: input.name,
      agent_profile_id: input.agent_profile_id,
      api_profile_ids: input.api_profile_ids,
      ports: [
        { container: 22, host: input.ssh_port },
        { container: 8443, host: input.port },
      ],
      env: {
        HOST: "0.0.0.0",
        PORT: "8443",
        // SCHEDULER_INSTANCE_ID is injected by the control plane from the derived instance id and is not sent here.
        SCHEDULER_HOST_ID: input.host_id,
      },
      resource_profile: {
        cpu_limit: input.cpus,
        memory_limit_bytes: input.mem_mb * MIB,
        pids_limit: 512,
      },
      network_policy: "default",
      labels: { role: "scheduler" },
      ...(input.role === "root" && input.scheduling_mode
        ? { scheduling_mode: input.scheduling_mode }
        : {}),
    },
  });
  await pcs(
    connection,
    `/api/v1/platform/deployment-plans/${encodeURIComponent(String(plan.plan_id))}/apply`,
    { method: "POST", body: { plan_digest: plan.plan_digest } },
  );
}

/**
 * Remove a scheduler registration left behind by a deployment that no longer exists.
 * INSTANCE_UNKNOWN means it is already gone; ROUTE_NOT_FOUND means the scheduler predates this endpoint
 * and must be upgraded, which is worth surfacing instead of pretending the deletion worked.
 */
async function forgetInstance(connection: LiveConnection, instanceId: string): Promise<void> {
  try {
    await scheduler(connection, `/v1/instances/${encodeURIComponent(instanceId)}`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof ApiError && e.code === "INSTANCE_UNKNOWN") return;
    throw e;
  }
}

export async function instanceAction(
  connection: LiveConnection,
  instanceId: string,
  action: "start" | "stop" | "restart" | "drain" | "remove",
  hostId?: string,
): Promise<void> {
  const out = await pcs<DeploymentsResponse>(connection, "/api/v1/platform/deployments");
  const deployments = out?.deployments ?? [];
  // Instance names are unique only within a host; including the host prevents acting on a same-named instance on another host.
  const dep = deployments
    .filter(
      (d) =>
        d.instance_id === instanceId &&
        d.status !== "REMOVED" &&
        (!hostId || d.host_id === hostId),
    )
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  if (!dep) {
    // The deployment is already gone; only a stale scheduler registration remains (common for builders deleted
    // before this app version, and for native builders whose deployment record was lost). Deleting the
    // registration is the removal in that case; other actions have nothing to act on.
    if (action !== "remove") throw new Error(t("实例 {id} 没有可操作的部署记录", { id: instanceId }));
    await forgetInstance(connection, instanceId);
    return;
  }
  const verb = action === "drain" ? "stop" : action;
  await pcs(
    connection,
    `/api/v1/platform/deployments/${encodeURIComponent(String(dep.deployment_id))}/${verb}`,
    { method: "POST" },
  );
}

/**
 * Delete an instance and wait for the host to actually remove it.
 *
 * REMOVE is an asynchronous command: enqueueing it alone makes the caller think deletion finished, while revoking the host
 * immediately means the host never fetches the command and the container is left behind. Watch the same deployment_id until the host acknowledges.
 */
export async function removeInstanceAndWait(
  connection: LiveConnection,
  instanceId: string,
  hostId: string | undefined,
  timeoutMs = 60_000,
): Promise<void> {
  const pick = (rows: DeploymentRow[]) =>
    rows
      .filter(
        (d) =>
          d.instance_id === instanceId &&
          d.status !== "REMOVED" &&
          (!hostId || d.host_id === hostId),
      )
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  const first = pick(
    (await pcs<DeploymentsResponse>(connection, "/api/v1/platform/deployments"))?.deployments ?? [],
  );
  if (!first) {
    // No deployment record remains; treat it as deleted, but clear the stale scheduler registration too.
    await forgetInstance(connection, instanceId);
    return;
  }
  try {
    await pcs(
      connection,
      `/api/v1/platform/deployments/${encodeURIComponent(String(first.deployment_id))}/remove`,
      { method: "POST" },
    );
  } catch (e) {
    // An older control plane answers a repeated remove with 409 DEPLOYMENT_REMOVED: the remove was already
    // requested, so keep waiting for the acknowledgement instead of aborting the host removal.
    if (!(e instanceof ApiError) || e.code !== "DEPLOYMENT_REMOVED") throw e;
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1000));
    const rows =
      (await pcs<DeploymentsResponse>(connection, "/api/v1/platform/deployments"))?.deployments ?? [];
    const dep = rows.find((d) => d.deployment_id === first.deployment_id);
    if (!dep || dep.status === "REMOVED") {
      // The host acknowledged; drop the registration as well, but never fail the deletion if the
      // instance is still finishing its own shutdown.
      await forgetInstance(connection, instanceId).catch(() => undefined);
      return;
    }
    if (dep.status === "FAILED") {
      const observedError = dep.observed?.error;
      const reason =
        observedError !== null && typeof observedError === "object"
          ? String((observedError as { message?: unknown }).message ?? "")
          : String(observedError ?? dep.status ?? "");
      throw new Error(t("移除实例 {id} 失败：{reason}", { id: instanceId, reason }));
    }
  }
  throw new Error(t("实例 {id} 在 {sec} 秒内没有移除完成", { id: instanceId, sec: Math.round(timeoutMs / 1000) }));
}

/** Names of all instances not yet removed on this host in the control plane (based on deployment records, to avoid missing any). */
export async function activeHostInstances(
  connection: LiveConnection,
  hostId: string,
): Promise<string[]> {
  const rows =
    (await pcs<DeploymentsResponse>(connection, "/api/v1/platform/deployments"))?.deployments ?? [];
  return [
    ...new Set(
      rows
        .filter((d) => d.host_id === hostId && d.status !== "REMOVED" && d.instance_id)
        .map((d) => String(d.instance_id)),
    ),
  ];
}

/** Permanently delete the host record; the control plane requires all containers to be removed first. */
export async function deleteHost(connection: LiveConnection, hostId: string): Promise<void> {
  await pcs(connection, `/api/v1/platform/hosts/${encodeURIComponent(hostId)}`, {
    method: "DELETE",
  });
}

export async function revokeHost(connection: LiveConnection, hostId: string): Promise<void> {
  await pcs(connection, `/api/v1/platform/hosts/${encodeURIComponent(hostId)}/revoke`, {
    method: "POST",
  });
}

/**
 * Upload a task attachment to the control plane.
 *
 * Attachment contents never pass through the scheduler: the task carries only a one-time URL, so large files do not bloat the task JSON,
 * and the builder fetches them by URL when it runs.
 */
export async function uploadTaskAttachment(
  connection: LiveConnection,
  input: TaskAttachment,
): Promise<TaskAttachmentRef> {
  const out = await pcs(connection, "/api/v1/platform/attachments", {
    method: "POST",
    body: {
      name: input.name,
      media_type: input.media_type,
      data_base64: input.data_base64,
    },
  });
  return {
    attachment_id: String(out?.attachment_id ?? ""),
    name: String(out?.name ?? input.name),
    media_type: String(out?.media_type ?? input.media_type),
    size: Number(out?.size ?? input.size),
    url: String(out?.url ?? ""),
  };
}

export interface SubmitBuildInput {
  title: string;
  /** Natural-language task description executed by the Agent bound to the builder; no longer a shell command. */
  instruction: string;
  target_instance_id?: string;
  priority: number;
  /** Task difficulty D; 0 = unlimited. */
  difficulty?: number;
  /** Deployment id of the scheduler the builder belongs to; empty = default scheduler. */
  schedulerDeploymentId?: string | null;
  /** References to uploaded attachments; the builder writes them to disk and passes the paths to the Agent. */
  attachments?: TaskAttachmentRef[];
  /** Autonomy level: ask / edits / auto / full; omitted means the scheduler's configured default. */
  approval_mode?: string;
}

export async function submitBuild(
  connection: LiveConnection,
  input: SubmitBuildInput,
): Promise<{ task_id: string }> {
  const out = await schedulerFor(connection, input.schedulerDeploymentId, "/v1/tasks", {
    method: "POST",
    body: {
      task_type: "task.build",
      priority_class: Math.max(0, Math.min(3, input.priority)),
      ...(input.difficulty && input.difficulty > 0
        ? { difficulty: Math.max(1, Math.min(1000, Math.round(input.difficulty))) }
        : {}),
      max_attempts: 2,
      ...(input.approval_mode ? { approval_mode: input.approval_mode } : {}),
      deadline_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      trace_id: `build_${Date.now()}`,
      payload_ref: `admin://builds/${Date.now()}`,
      requirements: {
        ...(input.target_instance_id ? { target_instance_id: input.target_instance_id } : {}),
        build: {
          title: input.title,
          // The Agent reads requirements directly; with no command set, the deterministic shell executor will not mistakenly run natural language.
          instruction: input.instruction,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        },
      },
    },
  });
  return { task_id: String(out?.task_id ?? "") };
}

export async function cancelTask(
  connection: LiveConnection,
  taskId: string,
  schedulerDeploymentId?: string | null,
): Promise<void> {
  await schedulerFor(connection, schedulerDeploymentId, `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
    body: { actor: connection.operator },
  });
}

export async function retryTask(
  connection: LiveConnection,
  taskId: string,
  schedulerDeploymentId?: string | null,
): Promise<void> {
  await schedulerFor(connection, schedulerDeploymentId, `/v1/tasks/${encodeURIComponent(taskId)}/retry`, {
    method: "POST",
    body: { actor: connection.operator },
  });
}

/**
 * Answer a parked question. The scheduler appends the answer to the task and requeues it, so the
 * next attempt sees both the question and the answer instead of guessing again.
 */
export async function answerTask(
  connection: LiveConnection,
  taskId: string,
  answer: string,
  schedulerDeploymentId?: string | null,
): Promise<void> {
  await schedulerFor(connection, schedulerDeploymentId, `/v1/tasks/${encodeURIComponent(taskId)}/answer`, {
    method: "POST",
    body: { answer, actor: connection.operator },
  });
}

export interface TaskOutput {
  state: string;
  summary: string;
  outputs: Record<string, unknown>;
  attempts: number;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"]);

function attemptOutputs(detail: TaskDetailResponse | null | undefined): Record<string, unknown> {
  const list = Array.isArray(detail?.attempts) ? detail.attempts : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const raw = list[i]?.outputs;
    if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  }
  return {};
}

/**
 * Task-status polling interval: dense at first, then backing off.
 * A console command usually finishes in about 1 second, so a fixed 800ms step wastes more than half a second;
 * long tasks (builds, model chats) rarely change state within tens of seconds, so dense polling just hammers the scheduler for nothing.
 */
function pollDelay(elapsedMs: number): number {
  if (elapsedMs < 5_000) return 150;
  if (elapsedMs < 20_000) return 500;
  return 1_000;
}

async function waitTaskResult(
  connection: LiveConnection,
  taskId: string,
  timeoutMs = 90_000,
  signal?: AbortSignal,
  schedulerDeploymentId?: string | null,
): Promise<TaskOutput> {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let last: TaskDetailResponse | null = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException(t("已停止"), "AbortError");
    last = await schedulerFor<TaskDetailResponse>(
      connection,
      schedulerDeploymentId,
      `/v1/tasks/${encodeURIComponent(taskId)}`,
    );
    const state = String(last?.status ?? last?.state ?? "");
    if (TERMINAL.has(state)) {
      const attempts = Array.isArray(last?.attempts) ? last.attempts.length : 0;
      // Relay tasks execute on the child scheduler: the parent task has no attempt, and output lives in relay.child_result.
      const own = attemptOutputs(last);
      const relayed = last?.relay?.child_result?.outputs;
      const outputs =
        Object.keys(own).length || typeof relayed !== "object" || !relayed
          ? own
          : (relayed as Record<string, unknown>);
      return {
        state,
        summary: String(
          last?.result_summary ?? last?.attempts?.[attempts - 1]?.result_summary ?? "",
        ),
        outputs,
        attempts,
      };
    }
    await new Promise((r) => setTimeout(r, pollDelay(Date.now() - started)));
  }
  const status = last?.status ? String(last.status) : t("未知");
  throw new Error(
    t("任务 {id} 在 {sec} 秒内没有完成（当前 {status}）", {
      id: taskId,
      sec: Math.round(timeoutMs / 1000),
      status,
    }),
  );
}

export interface ChatTurnResult {
  task_id: string;
  state: string;
  reply: string;
  mode: "deterministic" | "agent" | "unknown";
  latency_ms: number;
  error?: string;
}

export async function sendChatTask(
  connection: LiveConnection,
  input: {
    instanceId: string;
    role: Role;
    message: string;
    history: Array<{ role: "user" | "assistant"; text: string }>;
    /** Stop button: abort polling and cancel the task. */
    signal?: AbortSignal;
    /** Call back immediately after task creation so "Stop" can get the task_id before the reply returns. */
    onTaskCreated?: (taskId: string) => void;
    /** Deployment id of the scheduler that owns the target instance; empty = default scheduler. */
    schedulerDeploymentId?: string | null;
  },
): Promise<ChatTurnResult> {
  const started = Date.now();
  const sessionId = `chat_${input.instanceId}`;
  const out = await schedulerFor(connection, input.schedulerDeploymentId, "/v1/tasks", {
    method: "POST",
    body: {
      task_type: `task.chat.${input.role}`,
      priority_class: 0,
      max_attempts: 1,
      deadline_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      trace_id: sessionId,
      requirements: {
        target_instance_id: input.instanceId,
        chat: {
          session_id: sessionId,
          message: input.message,
          history: input.history.slice(-12),
        },
      },
    },
  });
  const taskId = String(out?.task_id ?? "");
  if (!taskId) throw new Error(t("调度机没有返回 task_id"));
  input.onTaskCreated?.(taskId);
  const result = await waitTaskResult(
    connection,
    taskId,
    120_000,
    input.signal,
    input.schedulerDeploymentId,
  );
  const reply = String(result.outputs.reply ?? result.summary ?? "");
  const mode =
    result.outputs.mode === "agent" || result.outputs.mode === "deterministic"
      ? result.outputs.mode
      : "unknown";
  return {
    task_id: taskId,
    state: result.state,
    reply: reply || (result.state === "SUCCEEDED" ? t("（机器人没有返回文本）") : t("任务 {state}", { state: result.state })),
    mode,
    latency_ms: Date.now() - started,
    error: result.state === "SUCCEEDED" ? undefined : result.summary || result.state,
  };
}

export interface ConsoleResult {
  task_id: string;
  state: string;
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  latency_ms: number;
}

export async function execConsoleTask(
  connection: LiveConnection,
  input: { instanceId: string; command: string; schedulerDeploymentId?: string | null },
): Promise<ConsoleResult> {
  const started = Date.now();
  const out = await schedulerFor(connection, input.schedulerDeploymentId, "/v1/tasks", {
    method: "POST",
    body: {
      task_type: "task.console.builder",
      priority_class: 0,
      max_attempts: 1,
      deadline_at: new Date(Date.now() + 2 * 60_000).toISOString(),
      requirements: {
        target_instance_id: input.instanceId,
        console: { command: input.command, operator: connection.operator },
      },
    },
  });
  const taskId = String(out?.task_id ?? "");
  if (!taskId) throw new Error(t("调度机没有返回 task_id"));
  const result = await waitTaskResult(
    connection,
    taskId,
    60_000,
    undefined,
    input.schedulerDeploymentId,
  );
  const o = result.outputs;
  return {
    task_id: taskId,
    state: result.state,
    command: input.command,
    stdout: String(o.stdout ?? result.summary ?? ""),
    stderr: String(o.stderr ?? ""),
    exit_code: Number(o.exit_code ?? (result.state === "SUCCEEDED" ? 0 : 1)),
    latency_ms: Date.now() - started,
  };
}

export async function bindAgentProfile(
  connection: LiveConnection,
  hostId: string,
  instanceId: string,
  agentProfileId: string,
  role: Role = "builder",
): Promise<void> {
  await pcs(connection, `/api/v1/platform/instances/${encodeURIComponent(instanceId)}/bind-agent`, {
    method: "POST",
    body: { host_id: hostId, agent_profile_id: agentProfileId, role_id: role },
  });
}

/** Drop the Agent binding; the instance keeps running the current Agent until it restarts, then only runs shell tasks. */
export async function unbindAgentProfile(
  connection: LiveConnection,
  hostId: string,
  instanceId: string,
): Promise<void> {
  await pcs(
    connection,
    `/api/v1/platform/instances/${encodeURIComponent(instanceId)}/bind-agent?host_id=${encodeURIComponent(hostId)}`,
    { method: "DELETE" },
  );
}

const ROLE_TASKS: Record<Role, string[]> = {
  builder: ["task.build", "task.chat.builder", "task.console.builder"],
  scheduler: ["task.chat.scheduler", "task.console.scheduler"],
};

export interface AgentProfileInput {
  role_id: Role;
  name: string;
  version: string;
  adapter: "stdio-jsonrpc" | "http-local";
  model_api_profile_id?: string | null;
  /** Agent brings its own image; empty means run in the instance image. */
  artifact_image?: string;
  /** stdio means a launch command; http-local means http://127.0.0.1:<port>. */
  entrypoint?: string[];
  /** Entry arguments, e.g. --provider claude. */
  args?: string[];
  capabilities: string[];
  description?: string;
  system_prompt?: string;
  persona?: string;
  tone?: string;
  goals?: string;
  allowed_tools?: string[];
  limits?: { max_turns?: number; max_wall_seconds?: number; max_output_tokens?: number };
}

export async function createAgentProfile(
  connection: LiveConnection,
  input: AgentProfileInput,
): Promise<{ agent_profile_id?: string }> {
  return pcs(connection, "/api/v1/platform/agent-profiles", {
    method: "POST",
    body: {
      role_id: input.role_id,
      name: input.name,
      version: input.version,
      adapter: input.adapter,
      artifact_image: input.artifact_image ?? "",
      entrypoint: input.entrypoint ?? [],
      args: input.args ?? [],
      task_types: ROLE_TASKS[input.role_id],
      model_api_profile_id: input.model_api_profile_id ?? null,
      capabilities: input.capabilities,
      description: input.description ?? "",
      system_prompt: input.system_prompt ?? "",
      persona: input.persona ?? "",
      tone: input.tone ?? "",
      goals: input.goals ?? "",
      allowed_tools: input.allowed_tools ?? [],
      limits: input.limits ?? {},
    },
  });
}

/** Edit an Agent Profile; the role is immutable (PCS rejects changes). */
export async function updateAgentProfile(
  connection: LiveConnection,
  profileId: string,
  input: Partial<Omit<AgentProfileInput, "role_id">> & { enabled?: boolean },
): Promise<{ agent_profile_id?: string }> {
  return pcs(connection, `/api/v1/platform/agent-profiles/${encodeURIComponent(profileId)}`, {
    method: "PATCH",
    body: input,
  });
}

export interface ApiProfileInput {
  name: string;
  kind: string;
  base_url: string;
  secret_ref: string;
  auth_type?: string;
  scopes?: string[];
  egress?: string;
  timeout_seconds?: number;
}

export async function createApiProfile(
  connection: LiveConnection,
  input: ApiProfileInput,
): Promise<{ api_profile_id?: string }> {
  return pcs(connection, "/api/v1/platform/api-profiles", {
    method: "POST",
    body: {
      name: input.name,
      kind: input.kind,
      base_url: input.base_url,
      auth_type: input.auth_type ?? "bearer",
      secret_ref: input.secret_ref,
      scopes: input.scopes ?? [],
      egress: input.egress ?? null,
      ...(input.timeout_seconds ? { timeout_seconds: input.timeout_seconds } : {}),
    },
  });
}

export async function updateApiProfile(
  connection: LiveConnection,
  profileId: string,
  input: Partial<ApiProfileInput> & { enabled?: boolean },
): Promise<{ api_profile_id?: string }> {
  return pcs(connection, `/api/v1/platform/api-profiles/${encodeURIComponent(profileId)}`, {
    method: "PATCH",
    body: input,
  });
}

/** Write an API key: it goes only to the control plane for Secret Store storage; neither the browser nor PCS keeps plaintext. */
export async function setApiProfileSecret(
  connection: LiveConnection,
  profileId: string,
  value: string,
): Promise<{ ok: boolean; secret_ref: string }> {
  return pcs(connection, `/api/v1/platform/api-profiles/${encodeURIComponent(profileId)}/secret`, {
    method: "PUT",
    body: { value },
  });
}

export async function deleteAgentProfile(
  connection: LiveConnection,
  profileId: string,
): Promise<void> {
  await pcs(connection, `/api/v1/platform/agent-profiles/${encodeURIComponent(profileId)}`, {
    method: "DELETE",
  });
}

export async function deleteApiProfile(
  connection: LiveConnection,
  profileId: string,
): Promise<void> {
  await pcs(connection, `/api/v1/platform/api-profiles/${encodeURIComponent(profileId)}`, {
    method: "DELETE",
  });
}

export async function bindApiProfile(
  connection: LiveConnection,
  hostId: string,
  instanceId: string,
  apiProfileId: string,
): Promise<void> {
  await pcs(connection, `/api/v1/platform/instances/${encodeURIComponent(instanceId)}/bind-api`, {
    method: "POST",
    body: { host_id: hostId, api_profile_id: apiProfileId },
  });
}

export async function unbindApiProfile(
  connection: LiveConnection,
  hostId: string,
  instanceId: string,
  apiProfileId: string,
): Promise<void> {
  await pcs(
    connection,
    `/api/v1/platform/instances/${encodeURIComponent(instanceId)}/bind-api/${encodeURIComponent(apiProfileId)}?host_id=${encodeURIComponent(hostId)}`,
    { method: "DELETE" },
  );
}

export async function fetchTaskEvents(
  connection: LiveConnection,
  taskId: string,
  schedulerDeploymentId?: string | null,
): Promise<TaskEvent[]> {
  const out = await schedulerFor<TaskEventsResponse>(
    connection,
    schedulerDeploymentId,
    `/v1/tasks/${encodeURIComponent(taskId)}/events`,
  );
  return (out?.items ?? []).map((e) => {
    const payload =
      e.payload !== null && typeof e.payload === "object" ? e.payload : undefined;
    return {
      at: e.created_at ? String(e.created_at) : "",
      type: e.event_type ? String(e.event_type) : "",
      message: payload && Object.keys(payload).length
        ? JSON.stringify(payload)
        : `${String(e.from_status ?? "-")} → ${String(e.to_status ?? "-")}`,
    };
  });
}
