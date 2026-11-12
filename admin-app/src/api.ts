import { t } from "./i18n";
import { db } from "./store";
import {
  BUILDER_OS,
  type BuilderInput,
  type BuilderOs,
  type HostDraft,
  type HostProbe,
  type Role,
  type SubmitTaskInput,
  type TaskAttachmentRef,
} from "./types";
import { getLiveConnection } from "./live/config";
import { pcs } from "./live/client";
import { useLive } from "./live/context";
import {
  addLocalHost as liveAddLocalHost,
  addSshHost as liveAddSshHost,
  bindAgentProfile,
  bindApiProfile,
  bootstrapHost as liveBootstrapHost,
  cancelTask as liveCancelTask,
  createAgentProfile as liveCreateAgentProfile,
  createApiProfile as liveCreateApiProfile,
  createBuilder as liveCreateBuilder,
  createScheduler as liveCreateScheduler,
  deleteAgentProfile as liveDeleteAgentProfile,
  deleteApiProfile as liveDeleteApiProfile,
  execConsoleTask,
  instanceAction as liveInstanceAction,
  probeHost as liveProbeHost,
  activeHostInstances as liveActiveHostInstances,
  removeInstanceAndWait as liveRemoveInstanceAndWait,
  deleteHost as liveDeleteHost,
  revokeHost as liveRevokeHost,
  retryTask as liveRetryTask,
  sendChatTask,
  setApiProfileSecret as liveSetApiProfileSecret,
  submitBuild as liveSubmitBuild,
  uploadTaskAttachment as liveUploadTaskAttachment,
  unbindApiProfile,
  updateAgentProfile as liveUpdateAgentProfile,
  updateApiProfile as liveUpdateApiProfile,
  updateHost as liveUpdateHost,
  mergeHost as liveMergeHost,
  unmergeHost as liveUnmergeHost,
  type AgentProfileInput,
  type ApiProfileInput,
} from "./live/actions";
import { capabilityFromResources } from "./capability";

export type BuilderDraft = BuilderInput;

/** 主机接入：本地主机或 SSH 主机。SSH 私钥只在提交时经过浏览器内存。 */
export type { HostDraft };

export async function addHost(
  input: HostDraft,
  afterRefresh: () => Promise<void>,
): Promise<{ host_id: string; probe?: HostProbe }> {
  const live = getLiveConnection();
  const out =
    input.transport === "local"
      ? await liveAddLocalHost(live, input.name)
      : await liveAddSshHost(live, {
          name: input.name,
          address: input.address.trim(),
          port: input.port,
          user: input.user,
          private_key: input.private_key,
          password: input.password,
        });
  await afterRefresh();
  return { host_id: out.host_id, probe: out.probe as HostProbe | undefined };
}

/** 修改已接入主机的信息；私钥/密码留空表示沿用现有凭据。 */
export async function editHost(
  id: string,
  input: {
    name?: string;
    address?: string;
    port?: number;
    user?: string;
    private_key?: string;
    password?: string;
    role_mode?: "containers" | "builder" | "scheduler";
  },
  afterRefresh: () => Promise<void>,
): Promise<{
  probe?: HostProbe;
  role_mode?: "containers" | "builder" | "scheduler";
  /** 切到裸机构建机时，控制面自动创建的构建机进程。 */
  native_builder?: { deployment_id: string; created: boolean; status: string };
  /** 角色已切换，但裸机构建机没拉起来时的原因。 */
  warning?: string;
}> {
  const out = await liveUpdateHost(getLiveConnection(), id, input);
  await afterRefresh();
  return {
    probe: out.probe as HostProbe | undefined,
    ...(out.role_mode ? { role_mode: out.role_mode } : {}),
    ...(out.native_builder ? { native_builder: out.native_builder } : {}),
    ...(out.warning ? { warning: out.warning } : {}),
  };
}

/** 把一台主机并入另一台主机的联邦树；不会重启任何调度机。 */
export async function mergeHost(
  id: string,
  parentHostId: string,
  afterRefresh: () => Promise<void>,
): Promise<void> {
  await liveMergeHost(getLiveConnection(), id, parentHostId);
  await afterRefresh();
}

/** 解除并入，让这台主机重新成为根。 */
export async function unmergeHost(id: string, afterRefresh: () => Promise<void>): Promise<void> {
  await liveUnmergeHost(getLiveConnection(), id);
  await afterRefresh();
}

export async function probeHost(id: string, afterRefresh: () => Promise<void>): Promise<void> {
  await liveProbeHost(getLiveConnection(), id);
  await afterRefresh();
}

export async function bootstrapHost(
  id: string,
  afterRefresh: () => Promise<void>,
): Promise<{ online: boolean; status: string; log?: string }> {
  const out = await liveBootstrapHost(getLiveConnection(), id);
  await afterRefresh();
  return out;
}

/**
 * 名称（显示名）可以中文，最长 32 个字符。
 * 容器名、卷名、结点 id 和库名都由实例 id 派生，实例 id 由控制面按名称生成
 * （ASCII 字母数字保留，其余字符按码点展开，例如「测试机」→ 27979-35797-26426）。
 */
function normalizeDisplayName(raw: string | undefined, roleLabel: string): string {
  const name = (raw ?? "").trim();
  if (!name) return "";
  if (name.length > 32) {
    throw new Error(t("{label}名称最多 32 个字符", { label: roleLabel }));
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(t("{label}名称不能包含控制字符", { label: roleLabel }));
  }
  return name;
}

/**
 * 部署调度机：每台主机最多一个根调度机；结点调度机挂在同主机的父调度机下。
 * 镜像、数据库和上级地址由控制面注入，这里只下发角色、父调度机和 Agent 绑定。
 */
export type SchedulerDraft = {
  host_id: string;
  role: "root" | "node";
  /** node 的父调度机（deployment_id），同一台主机上。 */
  parent_scheduler_id?: string;
  /** 实例名，只在主机内唯一；根默认 scheduler，结点默认 node。 */
  name?: string;
  agent_profile_id: string;
  api_profile_ids: string[];
  port: number;
  ssh_port: number;
  cpus: number;
  mem_mb: number;
};

export async function deployScheduler(
  input: SchedulerDraft,
  afterRefresh: () => Promise<void>,
): Promise<void> {
  const host = db.hosts.find((h) => h.id === input.host_id);
  if (!host) throw new Error(t("选择的主机不存在"));
  if (host.state !== "ONLINE" && host.state !== "WARNING") {
    throw new Error(t("主机 {name} 当前是 {state}，不能部署调度机", { name: host.name, state: host.state }));
  }
  const localSchedulers = db.instances.filter(
    (i) => i.role === "scheduler" && i.host_id === host.id,
  );
  const root = localSchedulers.find((i) => (i.scheduler_role ?? "root") === "root");
  if (input.role === "root" && root) {
    throw new Error(t("主机 {name} 已经有根调度机 {root}", { name: host.name, root: root.name }));
  }
  if (input.role === "node") {
    if (!root) throw new Error(t("主机 {name} 还没有根调度机，先部署根调度机", { name: host.name }));
    const parent = localSchedulers.find(
      (i) => (i.deployment_id ?? i.id) === input.parent_scheduler_id,
    );
    if (!parent) throw new Error(t("选择的父调度机不存在"));
  }
  if (!input.agent_profile_id) throw new Error(t("先选择调度机 Agent"));
  // 名称只在主机内唯一；同名实例还在运行时拒绝，避免覆盖正在使用的容器。
  const fallback = input.role === "root" ? "scheduler" : "node";
  const name = normalizeDisplayName(input.name, t("调度机")) || fallback;
  if (db.instances.some((i) => i.host_id === host.id && i.name === name)) {
    throw new Error(t("主机 {name} 已有名为 {instance} 的实例", { name: host.name, instance: name }));
  }
  await liveCreateScheduler(getLiveConnection(), {
    ...input,
    name,
    parent_scheduler_id: input.role === "node" ? input.parent_scheduler_id : undefined,
  });
  await afterRefresh();
}

export async function createBuilder(input: BuilderDraft, afterRefresh: () => Promise<void>): Promise<void> {
  const host = input.host_id
    ? db.hosts.find((h) => h.id === input.host_id)
    : db.hosts.find((h) => h.state === "ONLINE");
  if (!host) throw new Error(input.host_id ? t("选择的主机不存在") : t("没有可用的 Docker 宿主机"));
  if (host.state !== "ONLINE" && host.state !== "WARNING") {
    throw new Error(t("主机 {name} 当前是 {state}，不能部署新容器", { name: host.name, state: host.state }));
  }
  const os = BUILDER_OS.find((o) => o.id === input.os);
  if (!os) throw new Error(t("不支持的构建机系统：{os}", { os: input.os }));
  // 构建机用官方 ubuntu 镜像（digest 固定），运行时由 PCS 随部署下发；
  // 不再复用历史构建机镜像，避免把旧的自建镜像带回来。
  const image = os.image;
  if (!/@sha256:[a-f0-9]{64}$/i.test(image)) {
    throw new Error(
      t("需要 {os} 的镜像 digest。请先在 PCS 部署一台该系统的构建机，或让镜像以 @sha256:<64hex> 登记。", { os: os.label }),
    );
  }
  // 名称留空时由控制面按主机顺延（builder-a、builder-b…）；指定了就不能和本机已有实例重名。
  const name = normalizeDisplayName(input.name, t("构建机"));
  if (name && db.instances.some((i) => i.host_id === host.id && i.name === name)) {
    throw new Error(t("主机 {name} 已有名为 {instance} 的实例", { name: host.name, instance: name }));
  }
  // 端口从现有 SSH 端口之后顺延；多实例由 PCS 按顺序递增宿主端口。
  const hostPort = Math.max(2221, ...db.instances.map((i) => i.ssh_port ?? 0)) + 1;
  // 六项能力明细：资源档位提供核数/内存/磁盘，主频与模型/API 能力可由创建表单补。
  const capability_detail =
    input.capability_detail ??
    capabilityFromResources({
      cpus: input.cpus,
      mem_mb: input.mem_mb,
      disk_gb: input.disk_gb,
    });
  await liveCreateBuilder(getLiveConnection(), {
    host_id: host.id,
    ...(name ? { name } : {}),
    os: input.os,
    count: input.count,
    tier: input.tier,
    cpus: input.cpus,
    mem_mb: input.mem_mb,
    disk_gb: input.disk_gb,
    agent_profile_id: input.agent_profile_id,
    api_profile_ids: input.api_profile_ids,
    image,
    ports: [{ container: 2222, host: hostPort }],
    scheduler_id: input.scheduler_id,
    capability_detail,
  });
  await afterRefresh();
}

export async function builderAction(
  id: string,
  action: "start" | "stop" | "restart" | "drain" | "remove",
  afterRefresh: () => Promise<void>,
  hostId?: string,
): Promise<void> {
  await liveInstanceAction(getLiveConnection(), id, action, hostId);
  await afterRefresh();
}

/**
 * 把主机从列表里移除：勾选的容器先删掉，其余容器和数据保留。
 * 吊销而不是清除记录，下次用同样的地址重新接入会复用原主机，容器可以直接继续用。
 */
export async function removeHostFromList(
  hostId: string,
  instanceIds: string[],
  afterRefresh: () => Promise<void>,
): Promise<void> {
  const connection = getLiveConnection();
  if (!connection) throw new Error(t("实时连接未建立"));
  for (const id of instanceIds) await liveRemoveInstanceAndWait(connection, id, hostId);
  await liveRevokeHost(connection, hostId);
  await afterRefresh();
}

/**
 * 删除主机上的容器；revoke=true 时等容器全部移除后再吊销主机。
 * 等待宿主确认是必要的：提前吊销会让它收不到 REMOVE 命令。
 */
export async function removeHostContainers(
  hostId: string,
  instanceIds: string[],
  purgeHost: boolean,
  afterRefresh: () => Promise<void>,
): Promise<void> {
  const connection = getLiveConnection();
  if (!connection) throw new Error(t("实时连接未建立"));
  // 「全部删除」以控制面的部署记录为准，界面列表漏掉的容器也会一起移除。
  const ids = purgeHost
    ? [...new Set([...instanceIds, ...(await liveActiveHostInstances(connection, hostId))])]
    : instanceIds;
  for (const id of ids) {
    await liveRemoveInstanceAndWait(connection, id, hostId);
  }
  if (purgeHost) await liveDeleteHost(connection, hostId);
  await afterRefresh();
}

export async function submitBuild(input: SubmitTaskInput, afterRefresh: () => Promise<void>): Promise<string> {
  const instruction = input.description.trim();
  // 目标构建机可能属于另一台调度机：请求发给它所属的那台，任务才会被本机调度。
  const target = input.target_instance_id
    ? db.instances.find((i) => i.id === input.target_instance_id)
    : undefined;
  const connection = getLiveConnection();
  // 附件先上传控制面，任务里只带一次性地址；大文件不进入调度机请求体。
  const attachments: TaskAttachmentRef[] = [];
  for (const item of input.attachments ?? []) {
    attachments.push(await liveUploadTaskAttachment(connection, item));
  }
  const out = await liveSubmitBuild(connection, {
    title: instruction.slice(0, 40),
    instruction,
    target_instance_id: input.target_instance_id,
    priority: input.priority ?? 2,
    difficulty: input.difficulty,
    attachments: attachments.length ? attachments : undefined,
    schedulerDeploymentId: input.scheduler_deployment_id ?? target?.scheduler_deployment_id ?? null,
  });
  await afterRefresh();
  return out.task_id;
}

export async function retryBuild(
  id: string,
  afterRefresh: () => Promise<void>,
  schedulerDeploymentId?: string | null,
): Promise<void> {
  await liveRetryTask(getLiveConnection(), id, schedulerDeploymentId);
  await afterRefresh();
}

export async function cancelBuild(
  id: string,
  afterRefresh: () => Promise<void>,
  schedulerDeploymentId?: string | null,
): Promise<void> {
  await liveCancelTask(getLiveConnection(), id, schedulerDeploymentId);
  await afterRefresh();
}

export async function sendChat(
  instanceId: string,
  role: Role,
  message: string,
  history: Array<{ role: "user" | "assistant"; text: string }>,
  opts?: {
    signal?: AbortSignal;
    onTaskCreated?: (taskId: string) => void;
    /** 目标实例所属调度机的部署 id；空 = 默认调度机。 */
    schedulerDeploymentId?: string | null;
  },
): Promise<{ reply: string; latency_ms: number; mode?: string }> {
  const out = await sendChatTask(getLiveConnection(), { instanceId, role, message, history, ...opts });
  return { reply: out.reply, latency_ms: out.latency_ms, mode: out.mode };
}

/** 停止一条还在跑的对话任务：先取消调度任务，再中断前端轮询。 */
export async function stopChatTask(
  taskId: string,
  schedulerDeploymentId?: string | null,
): Promise<void> {
  await liveCancelTask(getLiveConnection(), taskId, schedulerDeploymentId);
}

/**
 * 交互式 root 终端：管理员令牌只用来换一次性票据（30 秒、单次使用）。
 * 票据放在 WebSocket 子协议里，不写 URL、不进浏览器历史。
 */
export async function openTerminal(
  hostId: string,
  instanceId: string,
  cols: number,
  rows: number,
): Promise<{ ticket: string; path: string; expires_in: number }> {
  return pcs(getLiveConnection(), "/api/v1/platform/terminal-ticket", {
    method: "POST",
    body: { host_id: hostId, instance_id: instanceId, cols, rows },
  });
}

export async function execCommand(
  instanceId: string,
  command: string,
  schedulerDeploymentId?: string | null,
): Promise<{ stdout: string; stderr: string; exit_code: number; latency_ms: number }> {
  const out = await execConsoleTask(getLiveConnection(), {
    instanceId,
    command,
    schedulerDeploymentId,
  });
  return {
    stdout: out.stdout,
    stderr: out.stderr,
    exit_code: out.exit_code,
    latency_ms: out.latency_ms,
  };
}

export async function bindAgent(
  hostId: string,
  instanceId: string,
  agentProfileId: string,
  afterRefresh: () => Promise<void>,
  role: Role = "builder",
): Promise<void> {
  await bindAgentProfile(getLiveConnection(), hostId, instanceId, agentProfileId, role);
  await afterRefresh();
}

/** 新建或修改 Agent Profile；id 为空表示新建。 */
export async function saveAgentProfile(
  id: string | null,
  input: AgentProfileInput,
  afterRefresh: () => Promise<void>,
): Promise<void> {
  const live = getLiveConnection();
  if (id) await liveUpdateAgentProfile(live, id, input);
  else await liveCreateAgentProfile(live, input);
  await afterRefresh();
}

/** 新建或修改 API Profile；id 为空表示新建，返回 Profile id。 */
export async function saveApiProfile(
  id: string | null,
  input: ApiProfileInput,
  afterRefresh: () => Promise<void>,
): Promise<string> {
  const live = getLiveConnection();
  const out = id
    ? await liveUpdateApiProfile(live, id, input)
    : await liveCreateApiProfile(live, input);
  await afterRefresh();
  return String(out?.api_profile_id ?? id ?? "");
}

/** 把 API 密钥写入 Secret Store；控制面只转发，不落库、不回显。 */
export async function writeApiKey(profileId: string, value: string): Promise<void> {
  await liveSetApiProfileSecret(getLiveConnection(), profileId, value);
}

/** 删除未被引用的 Profile；仍被实例或 Agent 引用时控制面返回 409。 */
export async function deleteProfile(
  kind: "agent" | "api",
  id: string,
  afterRefresh: () => Promise<void>,
): Promise<void> {
  const live = getLiveConnection();
  if (kind === "agent") await liveDeleteAgentProfile(live, id);
  else await liveDeleteApiProfile(live, id);
  await afterRefresh();
}

/** 启用 / 停用一个 Profile。 */
export async function setProfileEnabled(
  kind: "agent" | "api",
  id: string,
  enabled: boolean,
  afterRefresh: () => Promise<void>,
): Promise<void> {
  const live = getLiveConnection();
  if (kind === "agent") await liveUpdateAgentProfile(live, id, { enabled });
  else await liveUpdateApiProfile(live, id, { enabled });
  await afterRefresh();
}

/**
 * 一次性设置实例的 Agent 与 API 绑定。
 * 只发送差异：新增的 bind-api，移除的 unbind-api；容器重启后生效。
 */
export async function setInstanceProfiles(
  hostId: string,
  instanceId: string,
  agentProfileId: string,
  role: Role,
  apiProfileIds: string[],
  currentApiProfileIds: string[],
  afterRefresh: () => Promise<void>,
): Promise<void> {
  const live = getLiveConnection();
  if (agentProfileId) await bindAgentProfile(live, hostId, instanceId, agentProfileId, role);
  const wanted = new Set(apiProfileIds);
  const current = new Set(currentApiProfileIds);
  for (const id of apiProfileIds) {
    if (!current.has(id)) await bindApiProfile(live, hostId, instanceId, id);
  }
  for (const id of currentApiProfileIds) {
    if (!wanted.has(id)) await unbindApiProfile(live, hostId, instanceId, id);
  }
  await afterRefresh();
}

/** 页面里调用一次即可订阅实时刷新；返回当前 refresh。 */
export function useRefresh(): () => Promise<void> {
  return useLive().refresh;
}

export function osLabel(os: BuilderOs | undefined): string {
  return BUILDER_OS.find((o) => o.id === os)?.label ?? "-";
}

export function sshCommand(host?: string, port?: number, user?: string): string {
  if (!host) return t("ssh root@<容器地址>");
  return `ssh -p ${port ?? 22} ${user ?? "root"}@${host}`;
}
