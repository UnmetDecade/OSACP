import { t } from "../i18n";
import type { BuilderOs, CapabilityDetail, HostRoleMode, Role, TaskAttachment, TaskAttachmentRef } from "../types";
import { pcs, scheduler, schedulerFor } from "./client";
import type { LiveConnection } from "./config";

const MIB = 1024 ** 2;

export async function testConnection(connection: LiveConnection): Promise<void> {
  await scheduler(connection, "/healthz");
  // 控制面是可选项：只创建构建机时需要；连不上不阻止进入实时模式。
  if (connection.pcsUrl) {
    try {
      await pcs(connection, "/api/v1/platform/hosts");
    } catch {
      // ignore
    }
  }
}

/**
 * 主机接入：私钥只随这一次请求发送，控制面加密落库后只回 fingerprint。
 * 这里不做任何本地持久化，组件卸载即丢。
 */
export async function addSshHost(
  connection: LiveConnection,
  input: {
    name?: string;
    address: string;
    port?: number;
    user?: string;
    /** 私钥认证；与 password 二选一。 */
    private_key?: string;
    /** 密码认证；与 private_key 二选一。 */
    password?: string;
  },
): Promise<{ host_id: string; key_fingerprint: string; probe: unknown }> {
  if (!connection.pcsUrl) throw new Error(t("未配置控制面地址，无法添加主机"));
  return pcs(connection, "/api/v1/platform/hosts/ssh", { method: "POST", body: input });
}

/** 修改已接入主机的信息；私钥留空表示沿用现有密钥。 */
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

/** 引导 host-runtime：写入并启动常驻守护进程，等主机入网。 */
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

/** 主机并入：只改联邦树，不重启任何调度机。 */
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

/** 解除并入：该主机重新成为联邦树的根。 */
export async function unmergeHost(connection: LiveConnection, hostId: string): Promise<void> {
  if (!connection.pcsUrl) throw new Error(t("未配置控制面地址，无法解除并入"));
  await pcs(connection, `/api/v1/platform/hosts/${encodeURIComponent(hostId)}/unmerge`, {
    method: "POST",
  });
}

/** 通过控制面创建构建机：先出部署计划，再用计划摘要应用。 */
export async function createBuilder(
  connection: LiveConnection,
  input: {
    host_id: string;
    /** 实例名；留空由控制面按主机自动顺延。 */
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
    /** 注册到哪台调度机（deployment_id）。 */
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
      // 名称是显示名（可以中文）；实例 id 由控制面按名称派生，界面不传。
      ...(input.name ? { display_name: input.name } : {}),
      count: Math.max(1, Math.min(4, input.count)),
      agent_profile_id: input.agent_profile_id,
      api_profile_ids: input.api_profile_ids,
      image: input.image,
      builder_os: input.os,
      ports: input.ports ?? [],
      ...(input.scheduler_id ? { scheduler_id: input.scheduler_id } : {}),
      // 环境跨部署保留：state 卷按实例隔离，apt deb 缓存全主机共享。
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
      // W 由控制面按六项明细加权后冻结；调度机领取任务时按它过滤难度。
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
 * 部署调度机：每台主机最多一个根调度机；结点调度机挂在同主机的父调度机下。
 *
 * 实例名只在主机内唯一：同一台主机上的根、结点各用各的名字。
 * 镜像、DATABASE_URL 和父调度机地址由控制面注入，不经过浏览器；
 * 这里只下发角色、父子关系和 Agent / API Profile 绑定。
 */
export async function createScheduler(
  connection: LiveConnection,
  input: {
    host_id: string;
    /** 显示名（可以中文）；实例 id 由控制面按名称派生。 */
    name: string;
    role: "root" | "node";
    parent_scheduler_id?: string;
    agent_profile_id: string;
    api_profile_ids: string[];
    port: number;
    ssh_port: number;
    cpus: number;
    mem_mb: number;
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
        // SCHEDULER_INSTANCE_ID 由控制面按派生出的实例 id 注入，这里不传。
        SCHEDULER_HOST_ID: input.host_id,
      },
      resource_profile: {
        cpu_limit: input.cpus,
        memory_limit_bytes: input.mem_mb * MIB,
        pids_limit: 512,
      },
      network_policy: "default",
      labels: { role: "scheduler" },
    },
  });
  await pcs(
    connection,
    `/api/v1/platform/deployment-plans/${encodeURIComponent(String(plan.plan_id))}/apply`,
    { method: "POST", body: { plan_digest: plan.plan_digest } },
  );
}

export async function instanceAction(
  connection: LiveConnection,
  instanceId: string,
  action: "start" | "stop" | "restart" | "drain" | "remove",
  hostId?: string,
): Promise<void> {
  const out = await pcs(connection, "/api/v1/platform/deployments");
  const deployments = (out?.deployments ?? []) as any[];
  // 实例名只在主机内唯一；带上主机才不会操作到另一台主机的同名实例。
  const dep = deployments
    .filter(
      (d) =>
        d.instance_id === instanceId &&
        d.status !== "REMOVED" &&
        (!hostId || d.host_id === hostId),
    )
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  if (!dep) throw new Error(t("实例 {id} 没有可操作的部署记录", { id: instanceId }));
  const verb = action === "drain" ? "stop" : action;
  await pcs(
    connection,
    `/api/v1/platform/deployments/${encodeURIComponent(dep.deployment_id)}/${verb}`,
    { method: "POST" },
  );
}

/**
 * 删除一个实例并等宿主真正移除它。
 *
 * REMOVE 是异步命令：只入队会让调用方以为删完了，而立即吊销主机会让宿主
 * 再也拉不到命令，容器反而留下。这里盯住同一个 deployment_id 直到宿主确认。
 */
export async function removeInstanceAndWait(
  connection: LiveConnection,
  instanceId: string,
  hostId: string | undefined,
  timeoutMs = 60_000,
): Promise<void> {
  const pick = (rows: any[]) =>
    rows
      .filter(
        (d) =>
          d.instance_id === instanceId &&
          d.status !== "REMOVED" &&
          (!hostId || d.host_id === hostId),
      )
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  const first = pick(((await pcs(connection, "/api/v1/platform/deployments"))?.deployments ?? []) as any[]);
  if (!first) return; // 已经没有部署记录，视为已删除。
  await pcs(
    connection,
    `/api/v1/platform/deployments/${encodeURIComponent(first.deployment_id)}/remove`,
    { method: "POST" },
  );
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1000));
    const rows = ((await pcs(connection, "/api/v1/platform/deployments"))?.deployments ?? []) as any[];
    const dep = rows.find((d) => d.deployment_id === first.deployment_id);
    if (!dep || dep.status === "REMOVED") return;
    if (dep.status === "FAILED") {
      const reason = dep.observed?.error?.message ?? dep.observed?.error ?? dep.status;
      throw new Error(t("移除实例 {id} 失败：{reason}", { id: instanceId, reason: String(reason) }));
    }
  }
  throw new Error(t("实例 {id} 在 {sec} 秒内没有移除完成", { id: instanceId, sec: Math.round(timeoutMs / 1000) }));
}

/** 控制面里这台主机上所有还没移除的实例名（以部署记录为准，避免漏删）。 */
export async function activeHostInstances(
  connection: LiveConnection,
  hostId: string,
): Promise<string[]> {
  const rows = ((await pcs(connection, "/api/v1/platform/deployments"))?.deployments ?? []) as any[];
  return [
    ...new Set(
      rows
        .filter((d) => d.host_id === hostId && d.status !== "REMOVED" && d.instance_id)
        .map((d) => String(d.instance_id)),
    ),
  ];
}

/** 彻底删除主机记录；控制面要求容器已全部移除。 */
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
 * 上传一个任务附件到控制面。
 *
 * 附件内容不经过调度机：任务里只放一次性地址，大文件不会撑大任务 JSON，
 * 构建机执行时再按地址取回。
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
  /** 自然语言任务描述，由构建机绑定的 Agent 执行；不再是 shell 命令。 */
  instruction: string;
  target_instance_id?: string;
  priority: number;
  /** 任务难度 D；0 = 不限制。 */
  difficulty?: number;
  /** 构建机所属调度机的部署 id；空 = 默认调度机。 */
  schedulerDeploymentId?: string | null;
  /** 已上传的附件引用；构建机落盘后把路径交给 Agent。 */
  attachments?: TaskAttachmentRef[];
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
      deadline_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      trace_id: `build_${Date.now()}`,
      payload_ref: `admin://builds/${Date.now()}`,
      requirements: {
        ...(input.target_instance_id ? { target_instance_id: input.target_instance_id } : {}),
        build: {
          title: input.title,
          // Agent 直接读 requirements；不写 command，确定性 Shell 执行器就不会误跑自然语言。
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

export interface TaskOutput {
  state: string;
  summary: string;
  outputs: Record<string, unknown>;
  attempts: number;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"]);

function attemptOutputs(detail: any): Record<string, unknown> {
  const list = Array.isArray(detail?.attempts) ? detail.attempts : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const raw = list[i]?.outputs;
    if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  }
  return {};
}

/**
 * 轮询任务状态的间隔：先密后退。
 * 控制台的一条命令通常 1 秒左右跑完，固定 800ms 一档等于平白多等半秒多；
 * 而长任务（构建、模型对话）几十秒内状态很少变，密轮询只是白打调度机。
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
  let last: any = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException(t("已停止"), "AbortError");
    last = await schedulerFor(connection, schedulerDeploymentId, `/v1/tasks/${encodeURIComponent(taskId)}`);
    const state = String(last?.status ?? last?.state ?? "");
    if (TERMINAL.has(state)) {
      const attempts = Array.isArray(last?.attempts) ? last.attempts.length : 0;
      // 中继任务的执行发生在子调度机：父任务没有 attempt，输出在 relay.child_result 里。
      const own = attemptOutputs(last);
      const relayed = last?.relay?.child_result?.outputs;
      const outputs =
        Object.keys(own).length || typeof relayed !== "object" || !relayed
          ? own
          : (relayed as Record<string, unknown>);
      return {
        state,
        summary: String(last?.result_summary ?? last?.attempts?.[attempts - 1]?.result_summary ?? ""),
        outputs,
        attempts,
      };
    }
    await new Promise((r) => setTimeout(r, pollDelay(Date.now() - started)));
  }
  throw new Error(t("任务 {id} 在 {sec} 秒内没有完成（当前 {status}）", { id: taskId, sec: Math.round(timeoutMs / 1000), status: last?.status ?? t("未知") }));
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
    /** 停止按钮：中断轮询并取消任务。 */
    signal?: AbortSignal;
    /** 任务创建后立刻回调，供「停止」在回复返回前拿到 task_id。 */
    onTaskCreated?: (taskId: string) => void;
    /** 目标实例所属调度机的部署 id；空 = 默认调度机。 */
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
  /** Agent 自带镜像；留空表示跑在实例镜像里。 */
  artifact_image?: string;
  /** stdio 为启动命令；http-local 为 http://127.0.0.1:<port>。 */
  entrypoint?: string[];
  /** 入口参数，例如 --provider claude。 */
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
): Promise<any> {
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

/** 修改 Agent Profile；角色不可改（PCS 拒绝）。 */
export async function updateAgentProfile(
  connection: LiveConnection,
  profileId: string,
  input: Partial<Omit<AgentProfileInput, "role_id">> & { enabled?: boolean },
): Promise<any> {
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
): Promise<any> {
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
): Promise<any> {
  return pcs(connection, `/api/v1/platform/api-profiles/${encodeURIComponent(profileId)}`, {
    method: "PATCH",
    body: input,
  });
}

/** 写入 API 密钥：只发给控制面转存 Secret Store，浏览器与 PCS 都不保留明文。 */
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
): Promise<any[]> {
  const out = await schedulerFor(connection, schedulerDeploymentId, `/v1/tasks/${encodeURIComponent(taskId)}/events`);
  return out?.items ?? [];
}
