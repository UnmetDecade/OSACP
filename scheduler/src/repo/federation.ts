import { q, q1 } from "../db.js";
import { ApiError } from "../errors.js";
import { config } from "../config.js";

/** A child that misses several reports in a row is no longer counted in ΣW: capability must drop immediately when a host leaves or a node goes offline. */
const STALE_CHILD_SECONDS = Math.max(
  90,
  Math.ceil(config.federationIntervalMs / 1000) * 3,
);

/**
 * Capability reporting between node schedulers (architecture rules 2/3).
 *
 * A scheduler on each host may be either a root or a child:
 *   - a child pushes the ΣW of "local builders + reported children" to its parent;
 *   - the parent stores only one row per direct child and sums their subtree_score for the total,
 *     so every report is already a whole-subtree value and the parent need not query recursively.
 *
 * The scheduler trusts only reports carrying FEDERATION_TOKEN; when no token is configured the endpoint is disabled entirely.
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
  /** This scheduler's reachable address; the parent uses it when relaying tasks. */
  url?: string | null;
  /** Max W among local online builders; the parent uses it to decide whether a difficulty-D task can be pushed down. */
  max_builder_score?: number;
  /** Number of local builders with no active lease; the parent uses it to pick the idler among multiple children. */
  idle_builder_count?: number;
  /** Instance roster within the subtree (local + reported children), used to route target_instance_id to the correct child. */
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

/** Only http(s) addresses are accepted; the parent embeds it into relay requests, so arbitrary schemes are not allowed. */
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
  /** ΣW of this machine's registered builders */
  local_score: number;
  builder_count: number;
  /** Max W among this machine's online builders; a difficulty-D task is only feasible when max >= D */
  max_builder_score: number;
  /** Number of this machine's builders with no active lease */
  idle_builder_count: number;
  /** Online builder count for this machine + subtree: the parent uses it to decide whether the subtree has a dispatchable machine */
  subtree_builder_count: number;
  /** Max W for this machine + subtree: the parent uses difficulty D to choose a node */
  subtree_max_builder_score: number;
  /** Idle builder count for this machine + subtree: the parent picks the idler among multiple children */
  subtree_idle_builder_count: number;
  /** Subtree ΣW reported by direct children */
  child_score: number;
  child_count: number;
  /** This machine + all children */
  subtree_score: number;
  /** Instance roster for this machine and subtree, sent with the report so the parent can route target instances */
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
 * Capability snapshot of the current scheduler. local counts only non-offline builders;
 * offline/failed instances no longer contribute W, so the root never dispatches based on a machine that is gone.
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
  // Capacity metrics must aggregate up the hierarchy too, or an intermediate node reports only its own local builders,
  // and the root above will think the whole subtree has no machine that can handle difficulty D.
  const childBuilders = children.reduce((sum: number, c: any) => sum + Number(c.builder_count ?? 0), 0);
  const childIdle = children.reduce(
    (sum: number, c: any) => sum + Number(c.idle_builder_count ?? 0),
    0,
  );
  const childMax = children.reduce(
    (max: number, c: any) => Math.max(max, Number(c.max_builder_score ?? 0)),
    0,
  );
  // The instance roster aggregates upward too: the root never touches grandchild builders directly, yet can still
  // route target_instance_id to the direct child that contains it.
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
