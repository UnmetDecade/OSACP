import { q, q1 } from "../db.js";
import { ApiError } from "../errors.js";
import { config } from "../config.js";

/** 连续错过若干次上报的子结点不再计入 ΣW：主机脱离或结点下线后能力要立刻回落。 */
const STALE_CHILD_SECONDS = Math.max(
  90,
  Math.ceil(config.federationIntervalMs / 1000) * 3,
);

/**
 * 结点调度机之间的能力上报（架构规则 2/3）。
 *
 * 每台主机的调度机既可能是根，也可能是子结点：
 *   - 子结点把自己「本地构建机 + 已上报子结点」的 ΣW 推到上一级；
 *   - 父结点只保存直接子结点的一行，取总数时把它们的 subtree_score 相加，
 *     因此每次上报都已经是“整棵子树”的值，父结点不需要递归查询。
 *
 * 调度机只相信带了 FEDERATION_TOKEN 的上报；没有配置 token 时该接口整体关闭。
 */
export interface ReportedInstance {
  instance_id: string;
  role_id: "builder" | "scheduler";
  host_id: string;
  state: string;
  capability_score: number;
}

export interface NodeReportInput {
  node_id: string;
  parent_node_id?: string | null;
  host_id: string;
  role?: "root" | "node";
  local_score?: number;
  subtree_score?: number;
  builder_count?: number;
  child_count?: number;
  /** 本调度机的可达地址；父结点中继任务时用它。 */
  url?: string | null;
  /** 本地在线构建机的最大 W，父结点据此判断难度 D 的任务能否下推。 */
  max_builder_score?: number;
  /** 本地没有活跃租约的构建机数量，父结点据此在多个子结点间挑更闲的。 */
  idle_builder_count?: number;
  /** 子树内实例名册（本地 + 已上报子结点），用于把 target_instance_id 路由到正确的子结点。 */
  instances?: ReportedInstance[];
}

function clampScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1000_000, Math.round(n));
}

function count(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1_000_000, Math.round(n));
}

/** 只接受 http(s) 地址；父结点会把它拼进中继请求，不能是任意协议。 */
function sanitizeUrl(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "").slice(0, 500);
  } catch {
    return null;
  }
}

const REPORTED_ROLES = new Set(["builder", "scheduler"]);
const INSTANCE_LIMIT = 1000;

function sanitizeInstances(value: unknown): ReportedInstance[] {
  if (!Array.isArray(value)) return [];
  const out: ReportedInstance[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const instanceId = String(row.instance_id ?? "").trim();
    const roleId = String(row.role_id ?? "");
    if (!instanceId || !REPORTED_ROLES.has(roleId)) continue;
    out.push({
      instance_id: instanceId.slice(0, 200),
      role_id: roleId as ReportedInstance["role_id"],
      host_id: String(row.host_id ?? "").slice(0, 200),
      state: String(row.state ?? "").slice(0, 40),
      capability_score: clampScore(row.capability_score),
    });
    if (out.length >= INSTANCE_LIMIT) break;
  }
  return out;
}

export async function upsertNodeReport(input: NodeReportInput) {
  const nodeId = String(input.node_id ?? "").trim();
  const hostId = String(input.host_id ?? "").trim();
  if (!nodeId || !hostId) {
    throw new ApiError(400, "BAD_REQUEST", "node_id / host_id 必填");
  }
  const role = input.role === "root" ? "root" : "node";
  const row = await q1(
    `INSERT INTO scheduler_nodes
       (node_id, parent_node_id, host_id, role, local_score, subtree_score,
        builder_count, child_count, url, max_builder_score, idle_builder_count,
        instances, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, app_now())
     ON CONFLICT (node_id) DO UPDATE SET
       parent_node_id = EXCLUDED.parent_node_id,
       host_id = EXCLUDED.host_id,
       role = EXCLUDED.role,
       local_score = EXCLUDED.local_score,
       subtree_score = EXCLUDED.subtree_score,
       builder_count = EXCLUDED.builder_count,
       child_count = EXCLUDED.child_count,
       url = EXCLUDED.url,
       max_builder_score = EXCLUDED.max_builder_score,
       idle_builder_count = EXCLUDED.idle_builder_count,
       instances = EXCLUDED.instances,
       updated_at = app_now()
     RETURNING *`,
    [
      nodeId,
      input.parent_node_id ?? null,
      hostId,
      role,
      clampScore(input.local_score),
      clampScore(input.subtree_score),
      count(input.builder_count),
      count(input.child_count),
      sanitizeUrl(input.url),
      clampScore(input.max_builder_score),
      count(input.idle_builder_count),
      JSON.stringify(sanitizeInstances(input.instances)),
    ],
  );
  return row;
}

export async function listNodes() {
  return q(
    `SELECT node_id, parent_node_id, host_id, role, local_score, subtree_score,
            builder_count, child_count, url, max_builder_score, idle_builder_count,
            instances, updated_at,
            EXTRACT(EPOCH FROM (app_now() - updated_at))::int AS age_seconds
       FROM scheduler_nodes
      ORDER BY role DESC, node_id`,
  );
}

export interface CapabilitySnapshot {
  node_id: string;
  /** 本机在册构建机的 ΣW */
  local_score: number;
  builder_count: number;
  /** 本机在线构建机的最大 W；难度 D 的任务只有 max >= D 才接得住 */
  max_builder_score: number;
  /** 本机没有活跃租约的构建机数量 */
  idle_builder_count: number;
  /** 本机 + 子树的在线构建机数量：父结点按它判断子树里有没有可派的机器 */
  subtree_builder_count: number;
  /** 本机 + 子树的最大 W：父结点按难度 D 选结点 */
  subtree_max_builder_score: number;
  /** 本机 + 子树的空闲构建机数量：父结点在多个子结点间挑更闲的 */
  subtree_idle_builder_count: number;
  /** 直接子结点上报的子树 ΣW */
  child_score: number;
  child_count: number;
  /** 本机 + 全部子结点 */
  subtree_score: number;
  /** 本机与子树的实例名册，随上报交给父结点做目标实例路由 */
  instances: ReportedInstance[];
  children: Array<{
    node_id: string;
    host_id: string;
    role: string;
    local_score: number;
    subtree_score: number;
    builder_count: number;
    child_count: number;
    url: string | null;
    max_builder_score: number;
    idle_builder_count: number;
    instances: ReportedInstance[];
    age_seconds: number;
  }>;
}

/**
 * 当前调度机的能力快照。local 只统计未离线的构建机；
 * offline/failed 的实例不再贡献 W，避免根调度机按一台已经消失的机器派活。
 */
export async function capabilitySnapshot(nodeId: string): Promise<CapabilitySnapshot> {
  const local = await q1<{ score: number; n: number; max_score: number; idle: number }>(
    `SELECT COALESCE(SUM(r.capability_score), 0)::int AS score,
            count(*)::int AS n,
            COALESCE(MAX(r.capability_score), 0)::int AS max_score,
            count(*) FILTER (
              WHERE NOT EXISTS (
                SELECT 1 FROM leases l
                 WHERE l.instance_id = r.instance_id
                   AND l.released_at IS NULL AND l.expires_at > app_now()
              )
            )::int AS idle
       FROM role_instances r
      WHERE r.role_id = 'builder' AND r.state NOT IN ('OFFLINE','FAILED')`,
  );
  const localInstances = await q<ReportedInstance>(
    `SELECT instance_id, role_id, host_id, state, capability_score
       FROM role_instances
      WHERE role_id IN ('builder','scheduler')
      ORDER BY role_id, instance_id`,
  );
  const children = await q(
    `SELECT node_id, host_id, role, local_score, subtree_score, builder_count, child_count,
            url, max_builder_score, idle_builder_count, instances,
            EXTRACT(EPOCH FROM (app_now() - updated_at))::int AS age_seconds
       FROM scheduler_nodes
      WHERE parent_node_id = $1
        AND updated_at > app_now() - make_interval(secs => $2)
      ORDER BY node_id`,
    [nodeId, STALE_CHILD_SECONDS],
  );
  const childScore = children.reduce((sum: number, c: any) => sum + Number(c.subtree_score ?? 0), 0);
  // 容量类指标也要随层级汇总，否则中间结点只报自己的本地构建机，
  // 上层的根会以为整棵子树没有能接住难度 D 的机器。
  const childBuilders = children.reduce((sum: number, c: any) => sum + Number(c.builder_count ?? 0), 0);
  const childIdle = children.reduce(
    (sum: number, c: any) => sum + Number(c.idle_builder_count ?? 0),
    0,
  );
  const childMax = children.reduce(
    (max: number, c: any) => Math.max(max, Number(c.max_builder_score ?? 0)),
    0,
  );
  // 实例名册随层级向上汇总：根结点不直接接触孙结点的构建机，也能把
  // target_instance_id 路由到包含它的那个直接子结点。
  const instances = [...localInstances];
  const seen = new Set(instances.map((i) => i.instance_id));
  for (const child of children as CapabilitySnapshot["children"]) {
    for (const item of Array.isArray(child.instances) ? child.instances : []) {
      if (!item?.instance_id || seen.has(item.instance_id)) continue;
      seen.add(item.instance_id);
      instances.push(item);
    }
  }
  return {
    node_id: nodeId,
    local_score: Number(local?.score ?? 0),
    builder_count: Number(local?.n ?? 0),
    max_builder_score: Number(local?.max_score ?? 0),
    idle_builder_count: Number(local?.idle ?? 0),
    subtree_builder_count: Number(local?.n ?? 0) + childBuilders,
    subtree_max_builder_score: Math.max(Number(local?.max_score ?? 0), childMax),
    subtree_idle_builder_count: Number(local?.idle ?? 0) + childIdle,
    child_score: childScore,
    child_count: children.length,
    subtree_score: Number(local?.score ?? 0) + childScore,
    instances,
    children: children as CapabilitySnapshot["children"],
  };
}
