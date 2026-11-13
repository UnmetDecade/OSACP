import { db } from "../store";
import type {
  AgentProfile,
  ApiProfile,
  BuilderOs,
  FailureSignature,
  Fleet,
  Host,
  HostState,
  Instance,
  InstanceState,
  LogEntry,
  Role,
  Sideload,
  SideloadScope,
  Task,
  TaskAttempt,
  TaskChild,
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
  // The image has not reached the target host yet: the control plane is syncing in the background and the container is not created.
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
    case "NEEDS_INPUT":
    case "WAITING_CHILDREN":
      return status;
    case "ASSIGNED":
      return "RUNNING";
    default:
      return "QUEUED";
  }
}

/**
 * Builder OS: the runtime-reported capabilities.os is most accurate (the entry script writes it from BUILDER_OS into config),
 * the official ubuntu image digest carries no version, so reporting is the only source; legacy images fall back to image-name matching.
 */
function osOf(reported: string | undefined, image: string | undefined): BuilderOs {
  const hit =
    BUILDER_OS.find((o) => o.id === reported) ?? BUILDER_OS.find((o) => image?.includes(o.id));
  return hit?.id ?? "ubuntu22.04";
}

/**
 * Human-readable task title. Older rows have no build.title, so fall back to the instruction's first line instead of
 * the payload ref number (admin://builds/1794555162975 means nothing in a list).
 */
function taskTitle(t: any): string {
  const req = (t.requirements ?? {}) as Record<string, any>;
  const raw =
    req.build?.title ??
    req.chat?.message ??
    req.build?.instruction ??
    req.console?.command ??
    "";
  const text = String(raw).trim().split("\n")[0].trim();
  if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return String(t.payload_ref?.split("/").filter(Boolean).pop() || t.task_type);
}

function roleOf(raw: string | undefined, taskType = ""): Role {
  if (raw === "scheduler" || taskType.startsWith("task.chat.scheduler") || taskType.startsWith("task.console.scheduler")) {
    return "scheduler";
  }
  return "builder";
}

/**
 * Scheduler registration rows carry allowed_task_types; but the admin app connects to only one scheduler,
 * so instances on other hosts (or in the federation subtree) have only control plane deployment records, no registration row.
 * Give them default capabilities by role in that case, otherwise "Create task" wrongly reports no builder available.
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
 * Read facts from the scheduler (required) and control plane (optional) to overwrite the in-memory view.
 * If either step fails, keep the previous data for that part so a single point of failure does not blank the UI.
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
    sideloadsRes,
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
    pcs(connection, "/api/v1/platform/sideloads"),
  ]);

  // The control plane is a required dependency of the admin pages; the scheduler only feeds the task view.
  // It must still work when the scheduler is down (otherwise after clicking "Stop" you could never reach "Start").
  if (hostsRes.status === "rejected") throw hostsRes.reason;
  const instancesOut = settled(instancesRes);

  // ---- Federation tree (control plane): fold relationships and per-level ΣW
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

  // ---- Hosts (control plane)
  const hostsOut = settled(hostsRes);
  if (hostsOut) {
    // Revoked hosts count as deleted: they disappear from all pages and the host switcher.
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
        last_report_at: h.last_report_at ?? h.last_seen_at ?? undefined,
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

  // ---- Sideloads (control plane): the studio shows only the current host's rows; the API keeps them per host.
  const sideloadsOut = settled(sideloadsRes);
  if (sideloadsOut) {
    replace(
      db.sideloads,
      ((sideloadsOut?.sideloads ?? []) as any[]).map(
        (s): Sideload => ({
          sideload_id: String(s.sideload_id),
          host_id: String(s.host_id),
          name: String(s.name ?? ""),
          token_hint: String(s.token_hint ?? ""),
          scopes: (Array.isArray(s.scopes) ? s.scopes.map(String) : []) as SideloadScope[],
          created_by: s.created_by ?? null,
          created_at: s.created_at ?? "",
          expires_at: s.expires_at ?? null,
          last_seen_at: s.last_seen_at ?? null,
          last_ip: s.last_ip ?? null,
          revoked_at: s.revoked_at ?? null,
        }),
      ),
    );
  }

  // ---- Agent / API (control plane)
  const agentsOut = settled(agentsRes);
  if (agentsOut) {
    // v4 has only the scheduler / builder roles. Legacy v3 roles left in the control plane
    // (worker / tester / reviewer / after_sales) are no longer mapped to builder,
    // otherwise they would appear as builder Agents in the binding dialog.
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

  // ---- Instance bindings (Agent / API): the control plane is authoritative; scheduler reports may lag
  // Bindings are indexed by host/instance scope: same-named instances on different hosts are distinct and have their own bindings.
  const deploymentsOut = settled(deploymentsRes);
  const scopeOf = (hostId: unknown, instanceId: unknown) =>
    `${String(hostId ?? "")}/${String(instanceId ?? "")}`;
  const bindingsOut = settled(bindingsRes);
  const bindingsById = new Map<string, any>();
  for (const b of (bindingsOut?.bindings ?? []) as any[]) {
    bindingsById.set(scopeOf(b.host_id, b.instance_id), b);
  }

  // ---- Instances: scheduler registration state wins; control plane deployments fill in container info
  // Instance names are unique only within a host (both hosts may have builder-a); all indexes use a host/instance scope key.
  // After an instance is deleted, its scheduler registration does not disappear on its own (it becomes OFFLINE), but the control plane has no deployment.
  // Continuing to show it makes deletion look ineffective, and clicking delete again reports "no deployment record to act on".
  const latestDeployment = new Map<string, any>();
  const deploymentByScope = new Map<string, any>();
  // deployment_id → deployment record: resolves the scheduler a builder is bound to and the parent of a node scheduler.
  const deploymentById = new Map<string, any>();
  // deployment_id → instance name: after a scheduler restart, builders/child schedulers may still hold the old deployment id,
  // so matching by instance name keeps instances visible across a restart.
  const instanceByDeployment = new Map<string, string>();
  // Hosts removed from the list (REVOKED) are hidden together with their instances and tasks.
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
  // Active scheduler deployment per host: requests for an instance → its owning scheduler all go to this deployment.
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
  // The scheduler deployment id recorded in a builder deployment may be stale (the scheduler restarted with a new deployment),
  // so resolve it to host + instance name first, then take the current deployment; if that fails, fall back to the local root scheduler.
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
    // When names do not match, fall back to deployment records of same-named instances (the most recent one when multiple hosts share the name).
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
      // Deleted in the control plane and no longer reported ONLINE by the scheduler: treat as deleted and stop showing it.
      const latest = latestDeployment.get(scopeOf(hostId, id));
      return !(latest?.status === "REMOVED" && row.state !== "ONLINE");
    });

  // Scope → instance; union of scheduler registration rows and control plane deployments.
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
    // A heartbeat older than 90 seconds counts as a stale row: the instance moved to the local scheduler, or the row belongs to another scheduler.
    const rowFresh = (() => {
      const at = row?.last_heartbeat_at;
      if (!at) return false;
      const ts = Date.parse(String(at));
      return Number.isFinite(ts) && Date.now() - ts < 90_000;
    })();
    const mappings = Array.isArray(dep?.ports) ? (dep.ports as any[]) : [];
    // Builder sshd listens on 2222; the scheduler image uses standard 22; host ports are mapped uniformly for SSH troubleshooting.
    const sshPort = Number(
      mappings.find((p) => Number(p?.container) === (role === "scheduler" ? 22 : 2222))?.host,
    );
    // Host port for the scheduler API; multiple schedulers on one host each have their own port.
    const schedulerPort = Number(
      mappings.find((p) => Number(p?.container) === 8443)?.host,
    );
    // Which scheduler receives task requests for this instance: itself for a scheduler, or the registered scheduler for a builder.
    const ownerScheduler =
      role === "scheduler"
        ? dep
        : resolveSchedulerDeployment(dep?.scheduler_deployment_id) ?? hostRootScheduler(hostId);
    return {
      // Instance names are unique only within a host; this distinguishes when both hosts have builder-a.
      key,
      id,
      deployment_id: dep?.deployment_id ? String(dep.deployment_id) : undefined,
      name: String(dep?.display_name ?? id),
      role,
      // Bare-metal roles run directly on the host instead of a container; the studio uses this to avoid
      // offering a scheduler slot on a host that a bare builder has taken over.
      execution: dep?.execution === "native" ? "native" : "container",
      os: role === "builder" ? osOf(String(row?.capabilities?.os ?? ""), image) : undefined,
      host_id: hostId,
      // SSH runs on the host machine, so use the host address rather than the display name, or the copied command will not connect.
      ssh_host: (() => {
        const host = db.hosts.find((h) => h.id === hostId);
        return host?.address || host?.name;
      })(),
      ssh_port: Number.isFinite(sshPort) && sshPort > 0 ? sshPort : role === "scheduler" ? 2200 : undefined,
      ssh_user: "root",
      // Builder containers mount /opt/platform/workspace. A bare-metal builder runs as the host login
      // user, which cannot write under /opt, so its workspace root sits in that user's home instead
      // (attempt subdirectories are kept after the task). The terminal opens in the same directory.
      workspace: String(
        (Array.isArray(dep?.volumes) ? (dep.volumes as any[]) : []).find(
          (v) => v?.name === "workspace",
        )?.mount ?? (dep?.execution === "native" ? "~/platform/workspace" : "/opt/platform/workspace"),
      ),
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
      // The deployment row has no labels column, so the declared capacity lives in capability_detail; 20 GiB is
      // only the last-resort display fallback for deployments created before that detail was recorded.
      disk_gb: num(
        dep?.labels?.disk_gb,
        num((dep?.capability_detail as Record<string, unknown> | undefined)?.disk_gb, 20),
      ),
      // The image is still on its way to the target host: the scheduler may still hold stale state from the previous round
      // (OFFLINE / STARTING); trust the control plane's SYNCING so the UI shows "syncing image".
      //
      // Each host has its own scheduler and the admin app connects to only one: instances from other hosts leave
      // stale rows that no longer heartbeat (OFFLINE) in the local scheduler database. Ignore rows with expired heartbeats and use the actual container state,
      // otherwise a healthy builder on 112 would show as offline.
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
      scheduling_mode:
        String(row?.scheduling_mode ?? dep?.env?.SCHEDULING_MODE ?? "") === "dynamic"
          ? "dynamic"
          : "static",
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
      // Requests go directly to this deployment; after the builder's scheduler restarts, this switches to the new deployment id.
      scheduler_deployment_id: ownerScheduler?.deployment_id
        ? String(ownerScheduler.deployment_id)
        : null,
      created_at: dep?.created_at ?? new Date().toISOString(),
    };
  });
  replace(db.instances, instances);

  // ---- Tasks: each scheduler has its own database, so fetch per scheduler and merge.
  // Fall back to the default scheduler when the deployment list is unavailable (legacy setups with only a root scheduler).
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
  // Deduplicate beyond the "just restarted host with a stale root scheduler row" case: task ids are globally unique, so dedupe by id.
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
      // Prefer the title the submitter wrote; older tasks only carry the instruction, then the payload ref.
      title: taskTitle(t),
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
      approval_mode: t.approval_mode ?? undefined,
      outcome: t.outcome ?? null,
      pending_question: t.pending_question ?? null,
      parent_task_id: t.parent_task_id ?? null,
      fanout_id: t.fanout_id ?? null,
      fanout_depth: num(t.fanout_depth) || 0,
    }));
  if (schedulerDeps.length || settled(tasksRes)) {
    replace(db.tasks, tasks);
  }

  // ---- Execution logs (control plane audit)
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

/** Attempt history carries the failure reason; the task list projection only carries counters. */
export async function fetchTaskAttempts(
  connection: LiveConnection,
  taskId: string,
  schedulerDeploymentId?: string | null,
): Promise<TaskAttempt[]> {
  const out = await schedulerFor(
    connection,
    schedulerDeploymentId,
    `/v1/tasks/${encodeURIComponent(taskId)}`,
  );
  return mapAttempts(out);
}

export type TaskDetail = {
  attempts: TaskAttempt[];
  /** Fan-out children, in creation order; the parent detail page renders them as a tree. */
  children: TaskChild[];
};

/** One round trip for the detail page: the list projection carries neither attempts nor children. */
export async function fetchTaskDetail(
  connection: LiveConnection,
  taskId: string,
  schedulerDeploymentId?: string | null,
): Promise<TaskDetail> {
  const out = await schedulerFor(
    connection,
    schedulerDeploymentId,
    `/v1/tasks/${encodeURIComponent(taskId)}`,
  );
  return {
    attempts: mapAttempts(out),
    children: ((out?.children ?? []) as any[]).map((c) => ({
      task_id: String(c.task_id),
      task_type: String(c.task_type ?? ""),
      status: taskState(String(c.status ?? "")),
      outcome: c.outcome ?? null,
      title: c.title ?? null,
      created_at: c.created_at ?? undefined,
      updated_at: c.updated_at ?? undefined,
    })),
  };
}

function mapAttempts(out: any): TaskAttempt[] {
  return ((out?.attempts ?? []) as any[]).map((a) => ({
    attempt_number: Number(a.attempt_number) || 0,
    status: String(a.status ?? ""),
    error:
      a.error && typeof a.error === "object"
        ? { code: a.error.code, message: a.error.message }
        : null,
    failure_class: a.failure_class ?? null,
    failure_signature: a.failure_signature ?? null,
    started_at: a.started_at ?? null,
    finished_at: a.finished_at ?? null,
  }));
}

/** Fleet-wide failure triage: one row per normalized failure, newest first. */
export async function fetchFailureSignatures(
  connection: LiveConnection,
  schedulerDeploymentId?: string | null,
  limit = 50,
): Promise<FailureSignature[]> {
  const out = await schedulerFor(
    connection,
    schedulerDeploymentId,
    `/v1/failure-signatures?limit=${encodeURIComponent(String(limit))}`,
  );
  return ((out?.items ?? []) as any[]).map((s) => ({
    signature: String(s.signature ?? ""),
    kind: String(s.kind ?? ""),
    code: String(s.code ?? ""),
    sample: s.sample ?? null,
    occurrences: Number(s.occurrences) || 0,
    first_seen_at: s.first_seen_at ?? null,
    last_seen_at: s.last_seen_at ?? null,
  }));
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
