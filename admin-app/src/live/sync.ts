import { db } from "../store";
import type {
  AgentProfile,
  ApiProfile,
  BuilderOs,
  Fleet,
  Host,
  HostState,
  Instance,
  InstanceState,
  LogEntry,
  Role,
  Task,
  TaskEvent,
  TaskState,
} from "../types";
import { BUILDER_OS } from "../types";
import { pcs, scheduler, schedulerFor } from "./client";
import type { LiveConnection } from "./config";

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function replace<T>(target: T[], items: T[]): void {
  target.splice(0, target.length, ...items);
}

function settled<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}

function hostState(status: string): HostState {
  switch (status) {
    case "ONLINE":
      return "ONLINE";
    case "DEGRADED":
      return "WARNING";
    case "OFFLINE":
      return "OFFLINE";
    case "REVOKED":
      return "REVOKED";
    default:
      return "PENDING";
  }
}

function instanceState(status: string, actual = "", deploymentStatus = ""): InstanceState {
  switch (status) {
    case "ONLINE":
    case "SUSPECT":
    case "DRAINING":
    case "OFFLINE":
    case "FAILED":
    case "STARTING":
    case "PROVISIONING":
      return status as InstanceState;
    default:
      break;
  }
  // 镜像还没到目标主机：控制面正在后台同步，容器尚未创建。
  if (deploymentStatus === "SYNCING") return "SYNCING";
  if (deploymentStatus === "HEALTHY" || actual === "RUNNING") return "ONLINE";
  if (deploymentStatus === "STOPPED" || actual === "STOPPED") return "OFFLINE";
  if (actual === "MISSING") return "SUSPECT";
  return "STARTING";
}

function taskState(status: string): TaskState {
  switch (status) {
    case "QUEUED":
    case "RUNNING":
    case "SUCCEEDED":
    case "FAILED":
    case "BLOCKED":
    case "CANCELLED":
      return status;
    case "ASSIGNED":
      return "RUNNING";
    default:
      return "QUEUED";
  }
}

/**
 * 构建机系统：运行时上报的 capabilities.os 最准（入口脚本从 BUILDER_OS 写进配置），
 * 官方 ubuntu 镜像的 digest 里没有版本号，只能靠上报；旧镜像再退回按镜像名匹配。
 */
function osOf(reported: string | undefined, image: string | undefined): BuilderOs {
  const hit =
    BUILDER_OS.find((o) => o.id === reported) ?? BUILDER_OS.find((o) => image?.includes(o.id));
  return hit?.id ?? "ubuntu22.04";
}

function roleOf(raw: string | undefined, taskType = ""): Role {
  if (raw === "scheduler" || taskType.startsWith("task.chat.scheduler") || taskType.startsWith("task.console.scheduler")) {
    return "scheduler";
  }
  return "builder";
}

/**
 * 调度机注册行里带着 allowed_task_types；但管理端只连一台调度机，
 * 其他主机（或联邦子树）的实例只有控制面部署记录，没有注册行。
 * 这时按角色给默认能力，否则「创建任务」会误报没有可接任务的构建机。
 */
const ROLE_TASK_TYPES: Record<Role, string[]> = {
  builder: ["task.build", "task.chat.builder", "task.console.builder"],
  scheduler: ["task.chat.scheduler", "task.console.scheduler"],
};

export type SyncSummary = {
  builders: number;
  tasks: number;
  logs: number;
  at: string;
};

/**
 * 从调度机（必需）与控制面（可选）读取事实，覆盖内存视图。
 * 任一步失败时保留该部分的旧数据，界面不因单点故障清空。
 */
export async function syncLive(connection: LiveConnection): Promise<SyncSummary> {
  const [
    instancesRes,
    tasksRes,
    hostsRes,
    deploymentsRes,
    agentsRes,
    apisRes,
    bindingsRes,
    auditsRes,
    fleetRes,
  ] = await Promise.allSettled([
    scheduler(connection, "/v1/instances"),
    scheduler(connection, "/v1/tasks?limit=300"),
    pcs(connection, "/api/v1/platform/hosts"),
    pcs(connection, "/api/v1/platform/deployments"),
    pcs(connection, "/api/v1/platform/agent-profiles"),
    pcs(connection, "/api/v1/platform/api-profiles"),
    pcs(connection, "/api/v1/platform/bindings"),
    pcs(connection, "/api/v1/platform/audit-logs?limit=300"),
    pcs(connection, "/api/v1/platform/fleet"),
  ]);

  // 控制面是管理页的必需依赖；调度机只是任务视图。
  // 调度机停掉时仍要能用（否则点完“停止”就再也点不到“启动”）。
  if (hostsRes.status === "rejected") throw hostsRes.reason;
  const instancesOut = settled(instancesRes);

  // ---- 联邦树（控制面）：并入关系与逐级 ΣW
  const fleetOut = settled(fleetRes);
  if (fleetOut) {
    const fleet: Fleet = {
      hosts: ((fleetOut?.hosts ?? []) as any[]).map((h) => ({
        host_id: String(h.host_id),
        hostname: String(h.hostname ?? h.host_id),
        status: String(h.status ?? ""),
        parent_host_id: h.parent_host_id ?? null,
        role_mode:
          h.role_mode === "builder" || h.role_mode === "scheduler" ? h.role_mode : "containers",
        local_score: num(h.local_score),
        subtree_score: num(h.subtree_score),
        builder_count: num(h.builder_count),
        subtree_builder_count: num(h.subtree_builder_count),
        child_host_ids: Array.isArray(h.child_host_ids) ? h.child_host_ids.map(String) : [],
        depth: num(h.depth),
        is_root: h.is_root !== false,
      })),
      total_score: num(fleetOut?.total_score),
      generated_at: String(fleetOut?.generated_at ?? ""),
    };
    db.fleet = fleet;
  }
  const fleetById = new Map(db.fleet.hosts.map((h) => [h.host_id, h]));

  // ---- 主机（控制面）
  const hostsOut = settled(hostsRes);
  if (hostsOut) {
    // 已吊销的主机视为已删除：从所有页面和主机切换器里消失。
    const hosts: Host[] = ((hostsOut?.hosts ?? []) as any[])
      .filter((h) => h.status !== "REVOKED")
      .map((h) => {
      const resources = (h.resources ?? h.last_report?.resources ?? {}) as Record<string, any>;
      const disks = Array.isArray(resources.disk) ? (resources.disk as any[]) : [];
      const disk = disks.find((d) => d.fs === "root") ?? disks[0] ?? {};
      const total = num(resources.mem_total_bytes);
      const available = num(resources.mem_available_bytes);
      const cpuCount = Math.max(1, num(resources.cpu_count, 1));
      const cpuUsage =
        resources.cpu_usage !== undefined
          ? num(resources.cpu_usage) * 100
          : (num(resources.load1) / cpuCount) * 100;
      return {
        id: h.host_id,
        name: h.hostname,
        os: /darwin|mac/i.test(h.os) ? "macOS" : /win/i.test(h.os) ? "Windows" : "Linux",
        arch: h.arch,
        runtime_version: h.runtime_version ?? "-",
        state: hostState(h.status),
        cpu: Math.max(0, Math.min(100, Math.round(cpuUsage))),
        mem: total > 0 ? Math.max(0, Math.min(100, Math.round((1 - available / total) * 100))) : 0,
        disk:
          num(disk.total_bytes) > 0
            ? Math.round((1 - num(disk.free_bytes) / num(disk.total_bytes)) * 100)
            : 0,
        cpu_total: cpuCount,
        mem_total_mb: Math.round(total / 1024 ** 2),
        mem_available_mb: Math.round(available / 1024 ** 2),
        labels: Object.fromEntries(Object.entries(h.labels ?? {}).map(([k, v]) => [k, String(v)])),
        capabilities: (h.tools ?? []).map((t: unknown) => String(t)),
        registered_at: h.enrolled_at ?? h.created_at ?? new Date().toISOString(),
        maintaining: false,
        transport: h.transport === "local" || h.transport === "ssh" ? h.transport : undefined,
        address: h.address ?? undefined,
        ssh_port: num(h.ssh_port) || undefined,
        ssh_user: h.ssh_user ?? undefined,
        auth_type: h.auth_type === "key" || h.auth_type === "password" ? h.auth_type : undefined,
        key_fingerprint: h.key_fingerprint ?? undefined,
        last_probe: h.last_probe ?? undefined,
        last_probe_at: h.last_probe_at ?? undefined,
        parent_host_id: h.parent_host_id ?? null,
        role_mode:
          h.role_mode === "builder" || h.role_mode === "scheduler" ? h.role_mode : "containers",
        local_score: fleetById.get(String(h.host_id))?.local_score,
        subtree_score: fleetById.get(String(h.host_id))?.subtree_score,
      };
      });
    replace(db.hosts, hosts);
  }

  // ---- Agent / API（控制面）
  const agentsOut = settled(agentsRes);
  if (agentsOut) {
    // v4 只有 scheduler / builder 两种角色。控制面里遗留的 v3 角色
    // （worker / tester / reviewer / after_sales）不再映射成 builder，
    // 否则它们会被当成构建机 Agent 出现在绑定弹窗里。
    const agents: AgentProfile[] = (agentsOut?.agent_profiles ?? [])
      .filter((a: any) => a.role_id === "scheduler" || a.role_id === "builder")
      .map((a: any) => ({
        id: a.agent_profile_id,
        name: a.name,
        role: a.role_id,
        version: a.version ?? "-",
        adapter: a.adapter ?? "-",
        model_api_profile_id: a.model_api_profile_id ?? undefined,
        capabilities: a.capabilities ?? [],
        artifact_image: a.artifact_image || undefined,
        entrypoint: a.entrypoint ?? [],
        args: a.args ?? [],
        task_types: a.task_types ?? [],
        description: a.description || undefined,
        system_prompt: a.system_prompt || undefined,
        persona: a.persona || undefined,
        tone: a.tone || undefined,
        goals: a.goals || undefined,
        allowed_tools: a.allowed_tools ?? [],
        limits: a.limits ?? {},
        enabled: a.enabled !== false,
      }));
    replace(db.agents, agents);
  }
  const apisOut = settled(apisRes);
  if (apisOut) {
    const apis: ApiProfile[] = (apisOut?.api_profiles ?? []).map((a: any) => ({
      id: a.api_profile_id,
      name: a.name,
      kind: a.kind,
      base_url: a.base_url,
      auth_type: a.auth_type,
      secret_ref: a.secret_ref,
      scopes: a.scopes ?? [],
      quota: a.quota
        ? Object.entries(a.quota)
            .map(([k, v]) => `${k}=${v}`)
            .join(" · ")
        : "-",
      egress: a.egress ?? "-",
      timeout_seconds: a.timeout_seconds ?? undefined,
      enabled: a.enabled !== false,
      rotated_at: a.updated_at ?? a.created_at ?? new Date().toISOString(),
    }));
    replace(db.apis, apis);
  }

  // ---- 实例绑定（Agent / API）：以控制面为准，调度机上报名可能滞后
  // 绑定按「主机/实例」作用域索引：同名实例在不同主机上是不同实例，各自有自己的绑定。
  const deploymentsOut = settled(deploymentsRes);
  const scopeOf = (hostId: unknown, instanceId: unknown) =>
    `${String(hostId ?? "")}/${String(instanceId ?? "")}`;
  const bindingsOut = settled(bindingsRes);
  const bindingsById = new Map<string, any>();
  for (const b of (bindingsOut?.bindings ?? []) as any[]) {
    bindingsById.set(scopeOf(b.host_id, b.instance_id), b);
  }

  // ---- 实例：调度机注册状态优先，控制面部署补容器信息
  // 实例名只在主机内唯一（两台主机都可以有 builder-a），所有索引都用「主机/实例」作用域键。
  // 删除实例后，调度机上那条注册记录不会自己消失（变成 OFFLINE），但控制面已经没有部署。
  // 继续展示会让「删除」看起来没生效，再点删除还会报“没有可操作的部署记录”。
  const latestDeployment = new Map<string, any>();
  const deploymentByScope = new Map<string, any>();
  // deployment_id → 部署记录：解析构建机绑定的调度机、结点调度机的父级。
  const deploymentById = new Map<string, any>();
  // deployment_id → 实例名：调度机重启后构建机/子调度机手里可能还是旧部署 id，
  // 界面按实例名匹配才不会因为一次重启就“看不见”实例。
  const instanceByDeployment = new Map<string, string>();
  // 已从列表移除（REVOKED）的主机连同它的实例、任务一起隐藏。
  const visibleHostIds = new Set(db.hosts.map((h) => h.id));
  for (const d of (deploymentsOut?.deployments ?? []) as any[]) {
    if (!visibleHostIds.has(String(d.host_id))) continue;
    if (d.deployment_id) deploymentById.set(String(d.deployment_id), d);
    if (d.deployment_id && d.instance_id) {
      instanceByDeployment.set(String(d.deployment_id), String(d.instance_id));
    }
    const key = scopeOf(d.host_id, d.instance_id);
    const latest = latestDeployment.get(key);
    if (!latest || String(d.updated_at) > String(latest.updated_at)) latestDeployment.set(key, d);
    if (d.status === "REMOVED") continue;
    const prev = deploymentByScope.get(key);
    if (!prev || String(d.updated_at) > String(prev.updated_at)) {
      deploymentByScope.set(key, d);
    }
  }
  // 每台主机上的活跃调度机部署：实例 → 它所属调度机的请求都发给这条部署。
  const activeSchedulerByScope = new Map<string, any>();
  for (const [key, dep] of deploymentByScope) {
    if (dep.role_id === "scheduler" && dep.deployment_id) {
      activeSchedulerByScope.set(key, dep);
    }
  }
  const hostRootScheduler = (hostId: string): any | undefined => {
    for (const dep of activeSchedulerByScope.values()) {
      if (String(dep.host_id) !== hostId) continue;
      if (dep.scheduler_role !== "node") return dep;
    }
    return undefined;
  };
  // 构建机部署里记的调度机部署 id 可能已经过期（调度机重启换了部署），
  // 先还原成「主机 + 实例名」再取当前部署；解析不了就退回本机根调度机。
  const resolveSchedulerDeployment = (rawDepId: unknown): any | undefined => {
    if (!rawDepId) return undefined;
    const ref = deploymentById.get(String(rawDepId));
    if (!ref) return undefined;
    const current = activeSchedulerByScope.get(scopeOf(ref.host_id, ref.instance_id));
    if (current) return current;
    return ref.status === "REMOVED" || ref.role_id !== "scheduler" ? undefined : ref;
  };

  const normalizeHostId = (row: any): string => {
    const reported = String(row?.host_id ?? "");
    if (reported && db.hosts.some((h) => h.id === reported)) return reported;
    const byName = reported ? db.hosts.find((h) => h.name === reported) : undefined;
    if (byName) return byName.id;
    // 名字对不上时，用同名实例的部署记录兜底（同名多主机时取最近一条）。
    let fallback = "";
    for (const dep of deploymentByScope.values()) {
      if (dep.instance_id === row?.instance_id) fallback = String(dep.host_id ?? "");
    }
    return fallback || reported;
  };
  const schedulerRows = ((instancesOut?.items ?? []) as any[])
    .filter((row) => row.role_id === "builder" || row.role_id === "scheduler")
    .map((row) => ({ row, id: String(row.instance_id), hostId: normalizeHostId(row) }))
    .filter(({ hostId }) => visibleHostIds.has(hostId))
    .filter(({ row, id, hostId }) => {
      // 控制面显示已删除、调度机也不再上报 ONLINE：视为已删除，不再显示。
      const latest = latestDeployment.get(scopeOf(hostId, id));
      return !(latest?.status === "REMOVED" && row.state !== "ONLINE");
    });

  // 作用域 → 实例；调度机注册行与控制面部署取并集。
  const scopes = new Map<string, { id: string; hostId: string; row?: any }>();
  for (const [key, dep] of deploymentByScope) {
    scopes.set(key, { id: String(dep.instance_id), hostId: String(dep.host_id) });
  }
  for (const { row, id, hostId } of schedulerRows) {
    const key = scopeOf(hostId, id);
    const entry = scopes.get(key);
    if (entry) entry.row = row;
    else scopes.set(key, { id, hostId, row });
  }

  const instances: Instance[] = [...scopes.keys()].sort().map((key) => {
    const { id, hostId, row } = scopes.get(key)!;
    const dep = deploymentByScope.get(key);
    const binding = bindingsById.get(key);
    const role = roleOf(String(row?.role_id ?? dep?.role_id ?? "builder"));
    const profile = (dep?.resource_profile ?? {}) as Record<string, any>;
    const cpu = num(profile.cpu_limit, role === "scheduler" ? 4 : 2);
    const memMb = Math.round(num(profile.memory_limit_bytes, role === "scheduler" ? 6144 : 4096) / 1024 ** 2);
    const image = String(dep?.image ?? "");
    // 心跳超过 90 秒视为旧行：实例已经换到本机调度机，或这行属于另一台调度机。
    const rowFresh = (() => {
      const at = row?.last_heartbeat_at;
      if (!at) return false;
      const ts = Date.parse(String(at));
      return Number.isFinite(ts) && Date.now() - ts < 90_000;
    })();
    const mappings = Array.isArray(dep?.ports) ? (dep.ports as any[]) : [];
    // 构建机 sshd 在 2222；调度机镜像用标准 22，统一映射宿主端口给 SSH 排障。
    const sshPort = Number(
      mappings.find((p) => Number(p?.container) === (role === "scheduler" ? 22 : 2222))?.host,
    );
    // 调度机 API 的宿主端口；同一台主机上多台调度机各有自己的端口。
    const schedulerPort = Number(
      mappings.find((p) => Number(p?.container) === 8443)?.host,
    );
    // 这台实例的任务请求该发给哪台调度机：调度机是自己，构建机是注册关系里的那台。
    const ownerScheduler =
      role === "scheduler"
        ? dep
        : resolveSchedulerDeployment(dep?.scheduler_deployment_id) ?? hostRootScheduler(hostId);
    return {
      // 实例名只在主机内唯一：两台主机都叫 builder-a 时用它区分。
      key,
      id,
      deployment_id: dep?.deployment_id ? String(dep.deployment_id) : undefined,
      name: String(dep?.display_name ?? id),
      role,
      os: role === "builder" ? osOf(String(row?.capabilities?.os ?? ""), image) : undefined,
      host_id: hostId,
      // SSH 要在宿主机上执行；用主机地址而不是显示名，否则复制出来连不上。
      ssh_host: (() => {
        const host = db.hosts.find((h) => h.id === hostId);
        return host?.address || host?.name;
      })(),
      ssh_port: Number.isFinite(sshPort) && sshPort > 0 ? sshPort : role === "scheduler" ? 2200 : undefined,
      ssh_user: "root",
      agent_profile_id: String(binding?.agent_profile_id || row?.agent_profile_id || ""),
      desired_agent_profile_id: undefined,
      api_profile_ids: Array.isArray(binding?.api_profile_ids)
        ? (binding.api_profile_ids as string[])
        : Array.isArray(row?.api_profile_ids)
          ? (row.api_profile_ids as string[])
          : [],
      task_types:
        Array.isArray(row?.allowed_task_types) && row.allowed_task_types.length
          ? (row.allowed_task_types as string[])
          : ROLE_TASK_TYPES[role],
      resource_profile: profile.cpu_limit
        ? `${cpu}C / ${memMb}MiB`
        : "-",
      cpu_limit: cpu,
      mem_limit_mb: memMb,
      disk_gb: num(dep?.labels?.disk_gb, 20),
      // 镜像还在运往目标主机的路上：这时调度机里可能还留着上一轮的旧状态
      // （OFFLINE / STARTING），以控制面的 SYNCING 为准，界面才会显示“同步镜像”。
      //
      // 每台主机有自己的调度机，而管理端只连其中一台：别的主机的实例在本机调度库里
      // 会留下不再心跳的旧行（OFFLINE）。心跳过期的行不动用，以容器实际状态为准，
      // 否则 112 上跑得好好的构建机会显示成离线。
      state:
        dep?.status === "SYNCING"
          ? "SYNCING"
          : row && rowFresh
            ? instanceState(String(row.state))
            : instanceState("", dep?.actual_state, dep?.status),
      config_version: num(row?.config_version ?? dep?.config_version, 1),
      last_heartbeat: row?.last_heartbeat_at ?? dep?.updated_at ?? new Date().toISOString(),
      image,
      capability_score: num(row?.capability_score ?? dep?.capability_score),
      capability_detail:
        (dep?.capability_detail && typeof dep.capability_detail === "object"
          ? dep.capability_detail
          : undefined) ?? (row?.capability_detail && typeof row.capability_detail === "object"
          ? row.capability_detail
          : undefined),
      scheduler_role:
        role === "scheduler"
          ? dep?.scheduler_role === "node"
            ? "node"
            : "root"
          : undefined,
      parent_scheduler_id:
        role === "scheduler" ? (dep?.parent_deployment_id ?? null) : undefined,
      parent_scheduler_instance_id:
        role === "scheduler" && dep?.parent_deployment_id
          ? instanceByDeployment.get(String(dep.parent_deployment_id)) ?? null
          : undefined,
      port: Number.isFinite(schedulerPort) && schedulerPort > 0 ? schedulerPort : undefined,
      scheduler_id: dep?.scheduler_deployment_id ?? null,
      scheduler_instance_id: ownerScheduler?.instance_id
        ? String(ownerScheduler.instance_id)
        : dep?.scheduler_deployment_id
          ? instanceByDeployment.get(String(dep.scheduler_deployment_id)) ?? null
          : null,
      // 请求直接发给这条部署；构建机所属调度机重启后这里换成新部署 id。
      scheduler_deployment_id: ownerScheduler?.deployment_id
        ? String(ownerScheduler.deployment_id)
        : null,
      created_at: dep?.created_at ?? new Date().toISOString(),
    };
  });
  replace(db.instances, instances);

  // ---- 任务：每台调度机各自一套库，所以逐台拉取后合并。
  // 部署列表拿不到时退回默认调度机（只有根调度机的旧环境）。
  type TaskRow = { row: any; schedulerDep: string | null; schedulerInstance: string | null };
  let taskRows: TaskRow[] = [];
  const schedulerDeps = [...activeSchedulerByScope.values()].filter((dep) => dep?.deployment_id);
  if (schedulerDeps.length) {
    const results = await Promise.allSettled(
      schedulerDeps.map((dep) =>
        schedulerFor(connection, String(dep.deployment_id), "/v1/tasks?limit=300"),
      ),
    );
    results.forEach((result, i) => {
      if (result.status !== "fulfilled") return;
      const dep = schedulerDeps[i];
      for (const row of (result.value?.items ?? []) as any[]) {
        taskRows.push({
          row,
          schedulerDep: String(dep.deployment_id),
          schedulerInstance: dep.instance_id ? String(dep.instance_id) : null,
        });
      }
    });
  }
  if (!schedulerDeps.length) {
    const tasksOut = settled(tasksRes);
    taskRows = ((tasksOut?.items ?? []) as any[]).map((row) => ({
      row,
      schedulerDep: null,
      schedulerInstance: null,
    }));
  }
  // 去掉「这台主机上刚重启、根调度机还留着旧行」之外的重名：任务 id 全局唯一，按 id 去重。
  const seenTaskIds = new Set<string>();
  const tasks: Task[] = taskRows
    .filter(({ row }) => {
      const id = String(row.task_id ?? "");
      if (!id || seenTaskIds.has(id)) return false;
      seenTaskIds.add(id);
      return true;
    })
    .map(({ row: t, schedulerDep, schedulerInstance }) => ({
      id: t.task_id,
      title: String(t.payload_ref?.split("/").filter(Boolean).pop() || t.task_type),
      type: t.task_type,
      workflow: t.workflow_run_id ?? "-",
      stage: t.status,
      target_role: roleOf(t.target_role, t.task_type),
      priority: num(t.priority_class, 2),
      difficulty: num(t.difficulty),
      state: taskState(t.status),
      instance_id: t.current_instance_id ?? undefined,
      attempts: num(t.attempt_count),
      block_reason: t.resource_block_reason ?? undefined,
      created_at: t.enqueued_at,
      scheduler_deployment_id: schedulerDep,
      scheduler_instance_id: schedulerInstance,
      relay: t.relay ?? null,
      payload: {
        requirements: t.requirements ?? {},
        payload_ref: t.payload_ref,
        resource_profile_id: t.resource_profile_id,
      },
      events: [],
    }));
  if (schedulerDeps.length || settled(tasksRes)) {
    replace(db.tasks, tasks);
  }

  // ---- 执行日志（控制面审计）
  const auditsOut = settled(auditsRes);
  if (auditsOut) {
    const logs: LogEntry[] = (auditsOut?.audit_logs ?? []).map((a: any) => ({
      id: `pcs_${a.audit_id}`,
      actor: a.operator_id,
      action: a.action,
      object: a.subject,
      result: a.detail?.error ? "FAILED" : "OK",
      at: a.created_at,
      detail:
        typeof a.detail === "object" && a.detail
          ? Object.entries(a.detail)
              .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
              .join(" · ")
          : String(a.detail ?? ""),
    }));
    replace(db.logs, logs);
  }

  return {
    builders: db.instances.filter((i) => i.role === "builder").length,
    tasks: db.tasks.length,
    logs: db.logs.length,
    at: new Date().toISOString(),
  };
}

export async function fetchTaskEvents(
  connection: LiveConnection,
  taskId: string,
  schedulerDeploymentId?: string | null,
): Promise<TaskEvent[]> {
  const out = await schedulerFor(
    connection,
    schedulerDeploymentId,
    `/v1/tasks/${encodeURIComponent(taskId)}/events`,
  );
  return ((out?.items ?? []) as any[]).map((e) => ({
    at: e.created_at,
    type: e.event_type,
    message:
      e.payload && Object.keys(e.payload).length
        ? JSON.stringify(e.payload)
        : `${e.from_status ?? "-"} → ${e.to_status ?? "-"}`,
  }));
}
