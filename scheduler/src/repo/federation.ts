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
  /** Dynamic-mode values; cross-node routing compares the ceiling, never the live score. */
  capability_ceiling?: number;
  capability_live?: number;
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
  /** Matching mode: the deployment's static/dynamic scheduling mode. */
  mode?: string;
  /** Max capability ceiling: the only value usable for cross-mode eligibility. */
  max_builder_ceiling?: number;
  /** Max capability live: used only for same-mode ordering among nodes. */
  max_builder_live?: number;
  /** Σ guaranteed score of the subtree; capacity planning only. */
  guaranteed_score?: number;
  /** Memory the subtree can still commit without violating pool guarantees. */
  available_commitment_mem_bytes?: number;
  pressure_state?: string;
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
      capability_ceiling: clampScore(row.capability_ceiling),
      capability_live: clampScore(row.capability_live),
    });
    if (out.length >= INSTANCE_LIMIT) break;
  }
  return out;
}

export async function upsertNodeReport(input: NodeReportInput) {
  const nodeId = String(input.node_id ?? "").trim();
  const hostId = String(input.host_id ?? "").trim();
  if (!nodeId || !hostId) {
    throw new ApiError(400, "BAD_REQUEST", "node_id / host_id are required");
  }
  const role = input.role === "root" ? "root" : "node";
  const mode = input.mode === "dynamic" ? "dynamic" : input.mode === "static" ? "static" : null;
  const pressure = String(input.pressure_state ?? "").toUpperCase();
  const row = await q1(
    `INSERT INTO scheduler_nodes
       (node_id, parent_node_id, host_id, role, local_score, subtree_score,
        builder_count, child_count, url, max_builder_score, idle_builder_count,
        instances, mode, max_builder_ceiling, max_builder_live, guaranteed_score,
        available_commitment_mem_bytes, pressure_state, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,
             COALESCE($13, 'static'), $14, $15, $16, $17, COALESCE($18, 'NORMAL'), app_now())
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
       mode = COALESCE($13, scheduler_nodes.mode),
       max_builder_ceiling = $14,
       max_builder_live = $15,
       guaranteed_score = $16,
       available_commitment_mem_bytes = $17,
       pressure_state = COALESCE($18, scheduler_nodes.pressure_state),
       stale = FALSE,
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
      mode,
      clampScore(input.max_builder_ceiling ?? input.max_builder_score),
      clampScore(input.max_builder_live ?? input.max_builder_score),
      clampScore(input.guaranteed_score),
      count(input.available_commitment_mem_bytes),
      ["NORMAL", "BUSY", "PRESSURE", "CRITICAL", "RECOVERING"].includes(pressure)
        ? pressure
        : null,
    ],
  );
  return row;
}

export async function listNodes() {
  return q(
    `SELECT node_id, parent_node_id, host_id, role, local_score, subtree_score,
            builder_count, child_count, url, max_builder_score, idle_builder_count,
            instances, mode, max_builder_ceiling, max_builder_live, guaranteed_score,
            available_commitment_mem_bytes, pressure_state,
            updated_at, EXTRACT(EPOCH FROM (app_now() - updated_at))::int AS age_seconds
       FROM scheduler_nodes
      ORDER BY role DESC, node_id`,
  );
}

export interface CapabilitySnapshot {
  node_id: string;
  /** This deployment's scheduling mode. */
  mode: "static" | "dynamic";
  /** ΣW of this machine's registered builders */
  local_score: number;
  builder_count: number;
  /** Max W among this machine's online builders; a difficulty-D task is only feasible when max >= D */
  max_builder_score: number;
  /** Max ceiling (cross-mode eligibility) and max live (same-mode ordering). */
  max_builder_ceiling: number;
  max_builder_live: number;
  guaranteed_score: number;
  available_commitment_mem_bytes: number;
  pressure_state: string;
  /** Number of this machine's builders with no active lease */
  idle_builder_count: number;
  /** Online builder count for this machine + subtree: the parent uses it to decide whether the subtree has a dispatchable machine */
  subtree_builder_count: number;
  /** Max W for this machine + subtree: the parent uses difficulty D to choose a node */
  subtree_max_builder_score: number;
  subtree_max_builder_ceiling: number;
  subtree_max_builder_live: number;
  subtree_guaranteed_score: number;
  subtree_available_commitment_mem_bytes: number;
  subtree_pressure_state: string;
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
    mode?: string;
    max_builder_ceiling?: number;
    max_builder_live?: number;
    guaranteed_score?: number;
    available_commitment_mem_bytes?: number;
    pressure_state?: string;
    instances: ReportedInstance[];
    age_seconds: number;
  }>;
}

/**
 * Capability snapshot of the current scheduler. local counts only non-offline builders;
 * offline/failed instances no longer contribute W, so the root never dispatches based on a machine that is gone.
 */
const PRESSURE_RANK: Record<string, number> = {
  NORMAL: 0,
  RECOVERING: 1,
  BUSY: 2,
  PRESSURE: 3,
  CRITICAL: 4,
};

function worstPressure(states: Array<string | null | undefined>): string {
  let worst = "NORMAL";
  for (const state of states) {
    const s = String(state ?? "NORMAL").toUpperCase();
    if ((PRESSURE_RANK[s] ?? 0) > (PRESSURE_RANK[worst] ?? 0)) worst = s;
  }
  return worst;
}

export async function capabilitySnapshot(nodeId: string): Promise<CapabilitySnapshot> {
  const local = await q1<{
    score: number;
    n: number;
    max_score: number;
    idle: number;
    ceiling_sum: number;
    max_ceiling: number;
    max_live: number;
    guaranteed_sum: number;
  }>(
    `WITH b AS (
       SELECT r.*,
              CASE WHEN r.scheduling_mode = 'dynamic' AND r.capability_ceiling_score > 0
                   THEN r.capability_ceiling_score ELSE r.capability_score END AS eff_ceiling,
              CASE WHEN r.scheduling_mode = 'dynamic' AND r.capability_live_score > 0
                   THEN r.capability_live_score ELSE r.capability_score END AS eff_live,
              CASE WHEN r.scheduling_mode = 'dynamic' AND r.capability_guaranteed_score > 0
                   THEN r.capability_guaranteed_score ELSE r.capability_score END AS eff_guaranteed
         FROM role_instances r
        WHERE r.role_id = 'builder' AND r.state NOT IN ('OFFLINE','FAILED')
     )
     SELECT COALESCE(SUM(capability_score), 0)::int AS score,
            count(*)::int AS n,
            COALESCE(MAX(capability_score), 0)::int AS max_score,
            COALESCE(SUM(eff_ceiling), 0)::int AS ceiling_sum,
            COALESCE(MAX(eff_ceiling), 0)::int AS max_ceiling,
            COALESCE(MAX(eff_live), 0)::int AS max_live,
            COALESCE(SUM(eff_guaranteed), 0)::int AS guaranteed_sum,
            count(*) FILTER (
              WHERE NOT EXISTS (
                SELECT 1 FROM leases l
                 WHERE l.instance_id = b.instance_id
                   AND l.released_at IS NULL AND l.expires_at > app_now()
              )
            )::int AS idle
       FROM b`,
  );
  const localInstances = await q<ReportedInstance>(
    `SELECT instance_id, role_id, host_id, state, capability_score,
            CASE WHEN scheduling_mode = 'dynamic' AND capability_ceiling_score > 0
                 THEN capability_ceiling_score ELSE capability_score END AS capability_ceiling,
            CASE WHEN scheduling_mode = 'dynamic' AND capability_live_score > 0
                 THEN capability_live_score ELSE capability_score END AS capability_live
       FROM role_instances
      WHERE role_id IN ('builder','scheduler')
      ORDER BY role_id, instance_id`,
  );
  const localPools = await q<{ available_commitment_bytes: string; pressure_state: string }>(
    `SELECT p.available_commitment_bytes, p.pressure_state
       FROM host_resource_pools p
      WHERE EXISTS (
        SELECT 1 FROM role_instances r
         WHERE r.host_id = p.host_id AND r.role_id = 'builder'
           AND r.state NOT IN ('OFFLINE','FAILED')
      )`,
  );
  const localAvailable = localPools.reduce(
    (sum, p) => sum + Number(p.available_commitment_bytes ?? 0),
    0,
  );
  const localPressure = worstPressure(localPools.map((p) => p.pressure_state));

  const children = await q<Record<string, unknown>>(
    `SELECT node_id, host_id, role, local_score, subtree_score, builder_count, child_count,
            url, max_builder_score, idle_builder_count, instances,
            mode, max_builder_ceiling, max_builder_live, guaranteed_score,
            available_commitment_mem_bytes, pressure_state,
            EXTRACT(EPOCH FROM (app_now() - updated_at))::int AS age_seconds
       FROM scheduler_nodes
      WHERE parent_node_id = $1
        AND updated_at > app_now() - make_interval(secs => $2)
      ORDER BY node_id`,
    [nodeId, STALE_CHILD_SECONDS],
  );
  const childScore = children.reduce((sum: number, c) => sum + Number(c.subtree_score ?? 0), 0);
  // Capacity metrics must aggregate up the hierarchy too, or an intermediate node reports only its own local builders,
  // and the root above will think the whole subtree has no machine that can handle difficulty D.
  const childBuilders = children.reduce((sum: number, c) => sum + Number(c.builder_count ?? 0), 0);
  const childIdle = children.reduce(
    (sum: number, c) => sum + Number(c.idle_builder_count ?? 0),
    0,
  );
  const childMax = children.reduce(
    (max: number, c) => Math.max(max, Number(c.max_builder_score ?? 0)),
    0,
  );
  const childCeiling = children.reduce(
    (max: number, c) => Math.max(max, Number(c.max_builder_ceiling ?? c.max_builder_score ?? 0)),
    0,
  );
  const childLive = children.reduce(
    (max: number, c) => Math.max(max, Number(c.max_builder_live ?? c.max_builder_score ?? 0)),
    0,
  );
  const childGuaranteed = children.reduce(
    (sum: number, c) => sum + Number(c.guaranteed_score ?? 0),
    0,
  );
  const childAvailable = children.reduce(
    (sum: number, c) => sum + Number(c.available_commitment_mem_bytes ?? 0),
    0,
  );
  const childPressure = worstPressure(
    children.map((c) => (typeof c.pressure_state === "string" ? c.pressure_state : null)),
  );
  // The instance roster aggregates upward too: the root never touches grandchild builders directly, yet can still
  // route target_instance_id to the direct child that contains it.
  const instances = [...localInstances];
  const seen = new Set(instances.map((i) => i.instance_id));
  for (const child of children as unknown as CapabilitySnapshot["children"]) {
    for (const item of Array.isArray(child.instances) ? child.instances : []) {
      if (!item?.instance_id || seen.has(item.instance_id)) continue;
      seen.add(item.instance_id);
      instances.push(item);
    }
  }
  return {
    node_id: nodeId,
    mode: config.schedulingMode,
    local_score: Number(local?.score ?? 0),
    builder_count: Number(local?.n ?? 0),
    max_builder_score: Number(local?.max_ceiling ?? local?.max_score ?? 0),
    max_builder_ceiling: Number(local?.max_ceiling ?? 0),
    max_builder_live: Number(local?.max_live ?? 0),
    guaranteed_score: Number(local?.guaranteed_sum ?? 0),
    available_commitment_mem_bytes: localAvailable,
    pressure_state: localPressure,
    idle_builder_count: Number(local?.idle ?? 0),
    subtree_builder_count: Number(local?.n ?? 0) + childBuilders,
    subtree_max_builder_score: Math.max(Number(local?.max_ceiling ?? 0), childCeiling),
    subtree_max_builder_ceiling: Math.max(Number(local?.max_ceiling ?? 0), childCeiling),
    subtree_max_builder_live: Math.max(Number(local?.max_live ?? 0), childLive),
    subtree_guaranteed_score: Number(local?.guaranteed_sum ?? 0) + childGuaranteed,
    subtree_available_commitment_mem_bytes: localAvailable + childAvailable,
    subtree_pressure_state: worstPressure([localPressure, childPressure]),
    subtree_idle_builder_count: Number(local?.idle ?? 0) + childIdle,
    child_score: childScore,
    child_count: children.length,
    subtree_score: Number(local?.score ?? 0) + childScore,
    instances,
    children: children as unknown as CapabilitySnapshot["children"],
  };
}
