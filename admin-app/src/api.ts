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

/** Host onboarding: local host or SSH host. The SSH private key passes through browser memory only at submit time. */
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

/** Edit an onboarded host; leaving the private key/password empty keeps the existing credential. */
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
  /** Builder process created automatically by the control plane when switching to a bare-metal builder. */
  native_builder?: { deployment_id: string; created: boolean; status: string };
  /** Reason the bare-metal builder did not come up after the role switch. */
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

/** Fold one host into another host's federation tree; no scheduler is restarted. */
export async function mergeHost(
  id: string,
  parentHostId: string,
  afterRefresh: () => Promise<void>,
): Promise<void> {
  await liveMergeHost(getLiveConnection(), id, parentHostId);
  await afterRefresh();
}

/** Unfold, making this host a root again. */
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
 * The name (display name) may contain Chinese, up to 32 characters.
 * Container name, volume name, node id and database name are all derived from the instance id;
 * the control plane generates the id from the name (ASCII alphanumerics kept, other chars expanded by code point, e.g. 「测试机」 → 27979-35797-26426).
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
 * Deploy a scheduler: each host has at most one root scheduler; node schedulers hang under a parent scheduler on the same host.
 * Image, database and parent address are injected by the control plane; only the role, parent scheduler and Agent binding are sent here.
 */
export type SchedulerDraft = {
  host_id: string;
  role: "root" | "node";
  /** Parent scheduler of the node (deployment_id), on the same host. */
  parent_scheduler_id?: string;
  /** Instance name, unique only within the host; defaults to scheduler for root and node for a node. */
  name?: string;
  agent_profile_id: string;
  api_profile_ids: string[];
  port: number;
  ssh_port: number;
  cpus: number;
  mem_mb: number;
  /** Root scheduler only: static keeps the deploy-time budget; dynamic adds the cgroup pool and live grants. */
  scheduling_mode?: "static" | "dynamic";
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
  // The name is unique only within the host; an instance with the same name is rejected while still running, to avoid replacing a container in use.
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
  // The builder uses the official ubuntu image (fixed digest), delivered at runtime by PCS with the deployment;
  // historical builder images are not reused, so old custom images are not brought back.
  const image = os.image;
  if (!/@sha256:[a-f0-9]{64}$/i.test(image)) {
    throw new Error(
      t("需要 {os} 的镜像 digest。请先在 PCS 部署一台该系统的构建机，或让镜像以 @sha256:<64hex> 登记。", { os: os.label }),
    );
  }
  // When the name is empty the control plane continues per host (builder-a, builder-b, ...); if specified, it must not collide with an existing instance on the host.
  const name = normalizeDisplayName(input.name, t("构建机"));
  if (name && db.instances.some((i) => i.host_id === host.id && i.name === name)) {
    throw new Error(t("主机 {name} 已有名为 {instance} 的实例", { name: host.name, instance: name }));
  }
  // Ports continue after the existing SSH port; with multiple instances PCS increments host ports in order.
  const hostPort = Math.max(2221, ...db.instances.map((i) => i.ssh_port ?? 0)) + 1;
  // Six capability details: the resource tier supplies cores/memory/disk; clock speed and model/API capability can be filled in on the create form.
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
 * Remove the host from the list: checked containers are deleted first; other containers and data are kept.
 * The record is revoked rather than erased, so re-onboarding with the same address reuses the original host and its containers can continue directly.
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
 * Delete containers on the host; with revoke=true, wait until all containers are removed before revoking the host.
 * Waiting for host acknowledgement is necessary: revoking early means it never receives the REMOVE command.
 */
export async function removeHostContainers(
  hostId: string,
  instanceIds: string[],
  purgeHost: boolean,
  afterRefresh: () => Promise<void>,
): Promise<void> {
  const connection = getLiveConnection();
  if (!connection) throw new Error(t("实时连接未建立"));
  // "Delete all" follows the control plane's deployment records, so containers missing from the UI list are removed too.
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
  // The target builder may belong to another scheduler: the request goes to the scheduler it belongs to, so the task is scheduled there.
  const target = input.target_instance_id
    ? db.instances.find((i) => i.id === input.target_instance_id)
    : undefined;
  const connection = getLiveConnection();
  // Attachments are uploaded to the control plane first; the task carries only a one-time URL, so large files never enter the scheduler request body.
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
    /** Deployment id of the scheduler that owns the target instance; empty = default scheduler. */
    schedulerDeploymentId?: string | null;
  },
): Promise<{ reply: string; latency_ms: number; mode?: string }> {
  const out = await sendChatTask(getLiveConnection(), { instanceId, role, message, history, ...opts });
  return { reply: out.reply, latency_ms: out.latency_ms, mode: out.mode };
}

/** Stop a running chat task: cancel the scheduled task first, then abort frontend polling. */
export async function stopChatTask(
  taskId: string,
  schedulerDeploymentId?: string | null,
): Promise<void> {
  await liveCancelTask(getLiveConnection(), taskId, schedulerDeploymentId);
}

/**
 * Interactive root terminal: the admin token is used only to exchange for a one-time ticket (30 seconds, single use).
 * The ticket travels in a WebSocket subprotocol, never in the URL or browser history.
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

/** Create or edit an Agent Profile; an empty id means create. */
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

/** Create or edit an API Profile; an empty id means create; returns the Profile id. */
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

/** Write the API key into the Secret Store; the control plane only forwards it, never stores or echoes it. */
export async function writeApiKey(profileId: string, value: string): Promise<void> {
  await liveSetApiProfileSecret(getLiveConnection(), profileId, value);
}

/** Delete an unreferenced Profile; the control plane returns 409 if an instance or Agent still references it. */
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

/** Enable / disable a Profile. */
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
 * Set an instance's Agent and API bindings in one shot.
 * Only the diff is sent: added ones use bind-api, removed ones unbind-api; takes effect after the container restarts.
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

/** Call once per page to subscribe to live refreshes; returns the current refresh. */
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
