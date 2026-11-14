import { db } from "../store";
import type {
  AgentProfile,
  ApiProfile,
  ApprovalMode,
  BuilderOs,
  CapabilityDetail,
  FailureSignature,
  Fleet,
  FleetHost,
  Host,
  HostProbe,
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
import type {
  AgentProfileRow,
  AgentProfilesResponse,
  ApiProfileRow,
  ApiProfilesResponse,
  AttemptRow,
  AuditsResponse,
  BindingRow,
  BindingsResponse,
  DeploymentRow,
  DeploymentsResponse,
  FailureSignaturesResponse,
  FleetHostRow,
  FleetResponse,
  HostRow,
  HostsResponse,
  InstanceRow,
  InstancesResponse,
  JsonObject,
  PortMappingRow,
  SideloadRow,
  SideloadsResponse,
  TaskDetailResponse,
  TaskEventRow,
  TaskEventsResponse,
  TaskRowData,
  TasksResponse,
} from "./rows";

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Wire values are `unknown`; convert to text once at the boundary so the page model never holds a non-string. */
function str(value: unknown, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/** Narrow a JSON field to an object before reading nested properties. */
function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" ? (value as JsonObject) : {};
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
function taskTitle(t: TaskRowData): string {
  const req = record(t.requirements);
  const build = record(req.build);
  const chat = record(req.chat);
  const consoleReq = record(req.console);
  const raw = build.title ?? chat.message ?? build.instruction ?? consoleReq.command ?? "";
  const text = String(raw).trim().split("\n")[0].trim();
  if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return String(str(t.payload_ref).split("/").filter(Boolean).pop() || str(t.task_type));
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
    scheduler<InstancesResponse>(connection, "/v1/instances"),
    scheduler<TasksResponse>(connection, "/v1/tasks?limit=300"),
    pcs<HostsResponse>(connection, "/api/v1/platform/hosts"),
    pcs<DeploymentsResponse>(connection, "/api/v1/platform/deployments"),
    pcs<AgentProfilesResponse>(connection, "/api/v1/platform/agent-profiles"),
    pcs<ApiProfilesResponse>(connection, "/api/v1/platform/api-profiles"),
    pcs<BindingsResponse>(connection, "/api/v1/platform/bindings"),
    pcs<AuditsResponse>(connection, "/api/v1/platform/audit-logs?limit=300"),
    pcs<FleetResponse>(connection, "/api/v1/platform/fleet"),
    pcs<SideloadsResponse>(connection, "/api/v1/platform/sideloads"),
  ]);

  // The control plane is a required dependency of the admin pages; the scheduler only feeds the task view.
  // It must still work when the scheduler is down (otherwise after clicking "Stop" you could never reach "Start").
  if (hostsRes.status === "rejected") throw hostsRes.reason;
  const instancesOut = settled(instancesRes);

  // ---- Federation tree (control plane): fold relationships and per-level ΣW
  const fleetOut = settled(fleetRes);
  if (fleetOut) {
    const fleet: Fleet = {
      hosts: (fleetOut.hosts ?? []).map(
        (h: FleetHostRow): FleetHost => ({
          host_id: str(h.host_id),
          hostname: str(h.hostname, str(h.host_id)),
          status: str(h.status),
          parent_host_id: h.parent_host_id ? str(h.parent_host_id) : null,
          role_mode:
            h.role_mode === "builder" || h.role_mode === "scheduler" ? h.role_mode : "containers",
          local_score: num(h.local_score),
          subtree_score: num(h.subtree_score),
          builder_count: num(h.builder_count),
          subtree_builder_count: num(h.subtree_builder_count),
          child_host_ids: strArray(h.child_host_ids),
          depth: num(h.depth),
          is_root: h.is_root !== false,
        }),
      ),
      total_score: num(fleetOut.total_score),
      generated_at: str(fleetOut.generated_at),
    };
    db.fleet = fleet;
  }
  const fleetById = new Map(db.fleet.hosts.map((h) => [h.host_id, h]));

  // ---- Hosts (control plane)
  const hostsOut = settled(hostsRes);
  if (hostsOut) {
    // Revoked hosts count as deleted: they disappear from all pages and the host switcher.
    const hosts: Host[] = (hostsOut.hosts ?? [])
      .filter((h: HostRow) => h.status !== "REVOKED")
      .map((h: HostRow): Host => {
        const resources = record(h.resources ?? h.last_report?.resources);
        const disks = Array.isArray(resources.disk)
          ? resources.disk.map((d) => record(d))
          : [];
        const disk = disks.find((d) => d.fs === "root") ?? disks[0] ?? {};
        const total = num(resources.mem_total_bytes);
        const available = num(resources.mem_available_bytes);
        const cpuCount = Math.max(1, num(resources.cpu_count, 1));
        const cpuUsage =
          resources.cpu_usage !== undefined
            ? num(resources.cpu_usage) * 100
            : (num(resources.load1) / cpuCount) * 100;
        const os = str(h.os);
        const hostId = str(h.host_id);
        return {
          id: hostId,
          name: str(h.hostname, hostId),
          os: /darwin|mac/i.test(os) ? "macOS" : /win/i.test(os) ? "Windows" : "Linux",
          arch: str(h.arch),
          runtime_version: str(h.runtime_version, "-"),
          state: hostState(str(h.status)),
          cpu: Math.max(0, Math.min(100, Math.round(cpuUsage))),
          mem:
            total > 0 ? Math.max(0, Math.min(100, Math.round((1 - available / total) * 100))) : 0,
          disk:
            num(disk.total_bytes) > 0
              ? Math.round((1 - num(disk.free_bytes) / num(disk.total_bytes)) * 100)
              : 0,
          cpu_total: cpuCount,
          mem_total_mb: Math.round(total / 1024 ** 2),
          mem_available_mb: Math.round(available / 1024 ** 2),
          labels: Object.fromEntries(
            Object.entries(h.labels ?? {}).map(([k, v]) => [k, String(v)]),
          ),
          capabilities: strArray(h.tools),
          registered_at:
            str(h.enrolled_at) || str(h.created_at) || new Date().toISOString(),
          last_report_at: h.last_report_at
            ? str(h.last_report_at)
            : h.last_seen_at
              ? str(h.last_seen_at)
              : undefined,
          maintaining: false,
          transport: h.transport === "local" || h.transport === "ssh" ? h.transport : undefined,
          address: h.address ? str(h.address) : undefined,
          ssh_port: num(h.ssh_port) || undefined,
          ssh_user: h.ssh_user ? str(h.ssh_user) : undefined,
          auth_type: h.auth_type === "key" || h.auth_type === "password" ? h.auth_type : undefined,
          key_fingerprint: h.key_fingerprint ? str(h.key_fingerprint) : undefined,
          last_probe: (h.last_probe ?? undefined) as HostProbe | undefined,
          last_probe_at: h.last_probe_at ? str(h.last_probe_at) : undefined,
          parent_host_id: h.parent_host_id ? str(h.parent_host_id) : null,
          role_mode:
            h.role_mode === "builder" || h.role_mode === "scheduler" ? h.role_mode : "containers",
          local_score: fleetById.get(hostId)?.local_score,
          subtree_score: fleetById.get(hostId)?.subtree_score,
        };
      });
    replace(db.hosts, hosts);
  }

  // ---- Sideloads (control plane): the studio shows only the current host's rows; the API keeps them per host.
  const sideloadsOut = settled(sideloadsRes);
  if (sideloadsOut) {
    replace(
      db.sideloads,
      (sideloadsOut.sideloads ?? []).map(
        (s: SideloadRow): Sideload => ({
          sideload_id: str(s.sideload_id),
          host_id: str(s.host_id),
          name: str(s.name),
          token_hint: str(s.token_hint),
          scopes: strArray(s.scopes) as SideloadScope[],
          created_by: s.created_by ? str(s.created_by) : null,
          created_at: str(s.created_at),
          expires_at: s.expires_at ? str(s.expires_at) : null,
          last_seen_at: s.last_seen_at ? str(s.last_seen_at) : null,
          last_ip: s.last_ip ? str(s.last_ip) : null,
          revoked_at: s.revoked_at ? str(s.revoked_at) : null,
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
    const agents: AgentProfile[] = (agentsOut.agent_profiles ?? [])
      .filter((a: AgentProfileRow) => a.role_id === "scheduler" || a.role_id === "builder")
      .map((a: AgentProfileRow): AgentProfile => {
        const limits = record(a.limits);
        return {
          id: str(a.agent_profile_id),
          name: str(a.name),
          role: a.role_id === "scheduler" ? "scheduler" : "builder",
          version: str(a.version, "-"),
          adapter: str(a.adapter, "-"),
          model_api_profile_id: str(a.model_api_profile_id) || undefined,
          capabilities: strArray(a.capabilities),
          artifact_image: str(a.artifact_image) || undefined,
          entrypoint: strArray(a.entrypoint),
          args: strArray(a.args),
          task_types: strArray(a.task_types),
          description: str(a.description) || undefined,
          system_prompt: str(a.system_prompt) || undefined,
          persona: str(a.persona) || undefined,
          tone: str(a.tone) || undefined,
          goals: str(a.goals) || undefined,
          allowed_tools: strArray(a.allowed_tools),
          limits: {
            max_turns: num(limits.max_turns) || undefined,
            max_wall_seconds: num(limits.max_wall_seconds) || undefined,
            max_output_tokens: num(limits.max_output_tokens) || undefined,
          },
          enabled: a.enabled !== false,
        };
      });
    replace(db.agents, agents);
  }
  const apisOut = settled(apisRes);
  if (apisOut) {
    const apis: ApiProfile[] = (apisOut.api_profiles ?? []).map(
      (a: ApiProfileRow): ApiProfile => ({
        id: str(a.api_profile_id),
        name: str(a.name),
        // The control plane validates kind on write; the boundary cast keeps unknown values from widening the page model.
        kind: str(a.kind) as ApiProfile["kind"],
        base_url: str(a.base_url),
        auth_type: str(a.auth_type),
        secret_ref: str(a.secret_ref),
        scopes: strArray(a.scopes),
        quota: Object.keys(record(a.quota)).length
          ? Object.entries(record(a.quota))
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(" · ")
          : "-",
        egress: str(a.egress, "-"),
        timeout_seconds: num(a.timeout_seconds) || undefined,
        enabled: a.enabled !== false,
        rotated_at: str(a.updated_at) || str(a.created_at) || new Date().toISOString(),
      }),
    );
    replace(db.apis, apis);
  }

  // ---- Instance bindings (Agent / API): the control plane is authoritative; scheduler reports may lag
  // Bindings are indexed by host/instance scope: same-named instances on different hosts are distinct and have their own bindings.
  const deploymentsOut = settled(deploymentsRes);
  const scopeOf = (hostId: unknown, instanceId: unknown) =>
    `${String(hostId ?? "")}/${String(instanceId ?? "")}`;
  const bindingsOut = settled(bindingsRes);
  const bindingsById = new Map<string, BindingRow>();
  for (const b of bindingsOut?.bindings ?? []) {
    bindingsById.set(scopeOf(b.host_id, b.instance_id), b);
  }

  // ---- Instances: scheduler registration state wins; control plane deployments fill in container info
  // Instance names are unique only within a host (both hosts may have builder-a); all indexes use a host/instance scope key.
  // After an instance is deleted, its scheduler registration does not disappear on its own (it becomes OFFLINE), but the control plane has no deployment.
  // Continuing to show it makes deletion look ineffective, and clicking delete again reports "no deployment record to act on".
  const latestDeployment = new Map<string, DeploymentRow>();
  const deploymentByScope = new Map<string, DeploymentRow>();
  // deployment_id → deployment record: resolves the scheduler a builder is bound to and the parent of a node scheduler.
  const deploymentById = new Map<string, DeploymentRow>();
  // deployment_id → instance name: after a scheduler restart, builders/child schedulers may still hold the old deployment id,
  // so matching by instance name keeps instances visible across a restart.
  const instanceByDeployment = new Map<string, string>();
  // Hosts removed from the list (REVOKED) are hidden together with their instances and tasks.
  const visibleHostIds = new Set(db.hosts.map((h) => h.id));
  for (const d of deploymentsOut?.deployments ?? []) {
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
  const activeSchedulerByScope = new Map<string, DeploymentRow>();
  for (const [key, dep] of deploymentByScope) {
    if (dep.role_id === "scheduler" && dep.deployment_id) {
      activeSchedulerByScope.set(key, dep);
    }
  }
  const hostRootScheduler = (hostId: string): DeploymentRow | undefined => {
    for (const dep of activeSchedulerByScope.values()) {
      if (String(dep.host_id) !== hostId) continue;
      if (dep.scheduler_role !== "node") return dep;
    }
    return undefined;
  };
  // The scheduler deployment id recorded in a builder deployment may be stale (the scheduler restarted with a new deployment),
  // so resolve it to host + instance name first, then take the current deployment; if that fails, fall back to the local root scheduler.
  const resolveSchedulerDeployment = (rawDepId: unknown): DeploymentRow | undefined => {
    if (!rawDepId) return undefined;
    const ref = deploymentById.get(String(rawDepId));
    if (!ref) return undefined;
    const current = activeSchedulerByScope.get(scopeOf(ref.host_id, ref.instance_id));
    if (current) return current;
    return ref.status === "REMOVED" || ref.role_id !== "scheduler" ? undefined : ref;
  };

  const normalizeHostId = (row: InstanceRow | undefined): string => {
    const reported = str(row?.host_id);
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
  const schedulerRows = (instancesOut?.items ?? [])
    .filter((row: InstanceRow) => row.role_id === "builder" || row.role_id === "scheduler")
    .map((row: InstanceRow) => ({
      row,
      id: str(row.instance_id),
      hostId: normalizeHostId(row),
    }))
    .filter(({ hostId }) => visibleHostIds.has(hostId))
    .filter(({ row, id, hostId }) => {
      // Deleted in the control plane and no longer reported ONLINE by the scheduler: treat as deleted and stop showing it.
      const latest = latestDeployment.get(scopeOf(hostId, id));
      return !(latest?.status === "REMOVED" && row.state !== "ONLINE");
    });

  // Scope → instance; union of scheduler registration rows and control plane deployments.
  const scopes = new Map<string, { id: string; hostId: string; row?: InstanceRow }>();
  for (const [key, dep] of deploymentByScope) {
    scopes.set(key, { id: str(dep.instance_id), hostId: str(dep.host_id) });
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
    const role = roleOf(row?.role_id ? str(row.role_id) : str(dep?.role_id, "builder"));
    const profile = record(dep?.resource_profile);
    const cpu = num(profile.cpu_limit, role === "scheduler" ? 4 : 2);
    const memMb = Math.round(num(profile.memory_limit_bytes, role === "scheduler" ? 6144 : 4096) / 1024 ** 2);
    const image = str(dep?.image);
    const deploymentDetail = record(dep?.capability_detail);
    const rowDetail = record(row?.capability_detail);
    // A heartbeat older than 90 seconds counts as a stale row: the instance moved to the local scheduler, or the row belongs to another scheduler.
    const rowFresh = (() => {
      const at = row?.last_heartbeat_at;
      if (!at) return false;
      const ts = Date.parse(String(at));
      return Number.isFinite(ts) && Date.now() - ts < 90_000;
    })();
    const mappings: PortMappingRow[] = Array.isArray(dep?.ports)
      ? dep.ports.map((p) => record(p))
      : [];
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
      deployment_id: dep?.deployment_id ? str(dep.deployment_id) : undefined,
      name: str(dep?.display_name, id),
      role,
      // Bare-metal roles run directly on the host instead of a container; the studio uses this to avoid
      // offering a scheduler slot on a host that a bare builder has taken over.
      execution: dep?.execution === "native" ? "native" : "container",
      os: role === "builder" ? osOf(str(row?.capabilities?.os), image) : undefined,
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
      workspace: str(
        (Array.isArray(dep?.volumes) ? dep.volumes : []).map((v) => record(v)).find(
          (v) => v.name === "workspace",
        )?.mount ?? (dep?.execution === "native" ? "~/platform/workspace" : "/opt/platform/workspace"),
      ),
      agent_profile_id: str(binding?.agent_profile_id || row?.agent_profile_id),
      desired_agent_profile_id: undefined,
      api_profile_ids:
        binding?.api_profile_ids !== undefined
          ? strArray(binding.api_profile_ids)
          : strArray(row?.api_profile_ids),
      task_types:
        Array.isArray(row?.allowed_task_types) && row.allowed_task_types.length
          ? strArray(row.allowed_task_types)
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
        num(record(dep?.capability_detail).disk_gb, 20),
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
            ? instanceState(str(row.state))
            : instanceState("", str(dep?.actual_state), str(dep?.status)),
      config_version: num(row?.config_version ?? dep?.config_version, 1),
      last_heartbeat:
        str(row?.last_heartbeat_at) || str(dep?.updated_at) || new Date().toISOString(),
      image,
      capability_score: num(row?.capability_score ?? dep?.capability_score),
      capability_detail: Object.keys(deploymentDetail).length
        ? (dep?.capability_detail as CapabilityDetail)
        : Object.keys(rowDetail).length
          ? (row?.capability_detail as CapabilityDetail)
          : undefined,
      scheduling_mode:
        str(row?.scheduling_mode ?? dep?.env?.SCHEDULING_MODE) === "dynamic"
          ? "dynamic"
          : "static",
      scheduler_role:
        role === "scheduler"
          ? dep?.scheduler_role === "node"
            ? "node"
            : "root"
          : undefined,
      parent_scheduler_id:
        role === "scheduler"
          ? dep?.parent_deployment_id
            ? str(dep.parent_deployment_id)
            : null
          : undefined,
      parent_scheduler_instance_id:
        role === "scheduler" && dep?.parent_deployment_id
          ? instanceByDeployment.get(str(dep.parent_deployment_id)) ?? null
          : undefined,
      port: Number.isFinite(schedulerPort) && schedulerPort > 0 ? schedulerPort : undefined,
      scheduler_id: dep?.scheduler_deployment_id ? str(dep.scheduler_deployment_id) : null,
      scheduler_instance_id: ownerScheduler?.instance_id
        ? str(ownerScheduler.instance_id)
        : dep?.scheduler_deployment_id
          ? instanceByDeployment.get(str(dep.scheduler_deployment_id)) ?? null
          : null,
      // Requests go directly to this deployment; after the builder's scheduler restarts, this switches to the new deployment id.
      scheduler_deployment_id: ownerScheduler?.deployment_id
        ? str(ownerScheduler.deployment_id)
        : null,
      created_at: str(dep?.created_at) || new Date().toISOString(),
    };
  });
  replace(db.instances, instances);

  // ---- Tasks: each scheduler has its own database, so fetch per scheduler and merge.
  // Fall back to the default scheduler when the deployment list is unavailable (legacy setups with only a root scheduler).
  type TaskRow = {
    row: TaskRowData;
    schedulerDep: string | null;
    schedulerInstance: string | null;
  };
  let taskRows: TaskRow[] = [];
  const schedulerDeps = [...activeSchedulerByScope.values()].filter((dep) => dep?.deployment_id);
  if (schedulerDeps.length) {
    const results = await Promise.allSettled(
      schedulerDeps.map((dep) =>
        schedulerFor<TasksResponse>(connection, str(dep.deployment_id), "/v1/tasks?limit=300"),
      ),
    );
    results.forEach((result, i) => {
      if (result.status !== "fulfilled") return;
      const dep = schedulerDeps[i];
      for (const row of result.value?.items ?? []) {
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
    taskRows = (tasksOut?.items ?? []).map((row: TaskRowData) => ({
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
    .map(({ row: t, schedulerDep, schedulerInstance }): Task => ({
      id: str(t.task_id),
      // Prefer the title the submitter wrote; older tasks only carry the instruction, then the payload ref.
      title: taskTitle(t),
      type: str(t.task_type),
      workflow: str(t.workflow_run_id, "-"),
      stage: str(t.status),
      target_role: roleOf(str(t.target_role), str(t.task_type)),
      priority: num(t.priority_class, 2),
      difficulty: num(t.difficulty),
      state: taskState(str(t.status)),
      instance_id: t.current_instance_id ? str(t.current_instance_id) : undefined,
      attempts: num(t.attempt_count),
      block_reason: t.resource_block_reason ? str(t.resource_block_reason) : undefined,
      created_at: str(t.enqueued_at),
      scheduler_deployment_id: schedulerDep,
      scheduler_instance_id: schedulerInstance,
      relay: (t.relay ?? null) as Task["relay"],
      payload: {
        requirements: record(t.requirements),
        payload_ref: t.payload_ref,
        resource_profile_id: t.resource_profile_id,
      },
      events: [],
      approval_mode: (t.approval_mode ?? undefined) as ApprovalMode | undefined,
      outcome: t.outcome ? str(t.outcome) : null,
      pending_question: (t.pending_question ?? null) as Task["pending_question"],
      parent_task_id: t.parent_task_id ? str(t.parent_task_id) : null,
      fanout_id: t.fanout_id ? str(t.fanout_id) : null,
      fanout_depth: num(t.fanout_depth) || 0,
    }));
  if (schedulerDeps.length || settled(tasksRes)) {
    replace(db.tasks, tasks);
  }

  // ---- Execution logs (control plane audit)
  const auditsOut = settled(auditsRes);
  if (auditsOut) {
    const logs: LogEntry[] = (auditsOut.audit_logs ?? []).map((a): LogEntry => {
      const detail = a.detail;
      const detailObject =
        detail !== null && typeof detail === "object" ? record(detail) : undefined;
      return {
        id: `pcs_${str(a.audit_id)}`,
        actor: str(a.operator_id),
        action: str(a.action),
        object: str(a.subject),
        result: detailObject?.error ? "FAILED" : "OK",
        at: str(a.created_at),
        detail: detailObject
          ? Object.entries(detailObject)
              .map(
                ([k, v]) => `${k}=${v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)}`,
              )
              .join(" · ")
          : detail === undefined || detail === null
            ? ""
            : String(detail),
      };
    });
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
  const out = await schedulerFor<TaskDetailResponse>(
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
  const out = await schedulerFor<TaskDetailResponse>(
    connection,
    schedulerDeploymentId,
    `/v1/tasks/${encodeURIComponent(taskId)}`,
  );
  return {
    attempts: mapAttempts(out),
    children: (out?.children ?? []).map(
      (c): TaskChild => ({
        task_id: str(c.task_id),
        task_type: str(c.task_type),
        status: taskState(str(c.status)),
        outcome: c.outcome ? str(c.outcome) : null,
        title: c.title ? str(c.title) : null,
        created_at: c.created_at ? str(c.created_at) : undefined,
        updated_at: c.updated_at ? str(c.updated_at) : undefined,
      }),
    ),
  };
}

function mapAttempts(out: TaskDetailResponse | null | undefined): TaskAttempt[] {
  return (out?.attempts ?? []).map(
    (a: AttemptRow): TaskAttempt => ({
      attempt_number: num(a.attempt_number),
      status: str(a.status),
      error: a.error
        ? {
            code: a.error.code ? str(a.error.code) : undefined,
            message: a.error.message ? str(a.error.message) : undefined,
          }
        : null,
      failure_class: a.failure_class ? str(a.failure_class) : null,
      failure_signature: a.failure_signature ? str(a.failure_signature) : null,
      started_at: a.started_at ? str(a.started_at) : null,
      finished_at: a.finished_at ? str(a.finished_at) : null,
    }),
  );
}

/** Fleet-wide failure triage: one row per normalized failure, newest first. */
export async function fetchFailureSignatures(
  connection: LiveConnection,
  schedulerDeploymentId?: string | null,
  limit = 50,
): Promise<FailureSignature[]> {
  const out = await schedulerFor<FailureSignaturesResponse>(
    connection,
    schedulerDeploymentId,
    `/v1/failure-signatures?limit=${encodeURIComponent(String(limit))}`,
  );
  return (out?.items ?? []).map(
    (s): FailureSignature => ({
      signature: str(s.signature),
      kind: str(s.kind),
      code: str(s.code),
      sample: s.sample ? str(s.sample) : null,
      occurrences: num(s.occurrences),
      first_seen_at: s.first_seen_at ? str(s.first_seen_at) : null,
      last_seen_at: s.last_seen_at ? str(s.last_seen_at) : null,
    }),
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
  return (out?.items ?? []).map(
    (e: TaskEventRow): TaskEvent => {
      const payload = record(e.payload);
      return {
        at: str(e.created_at),
        type: str(e.event_type),
        message: Object.keys(payload).length
          ? JSON.stringify(payload)
          : `${str(e.from_status, "-")} → ${str(e.to_status, "-")}`,
      };
    },
  );
}
