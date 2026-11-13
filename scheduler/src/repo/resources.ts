import { pool, q, q1, tx, type Client } from "../db.js";
import { config } from "../config.js";
import {
  allocateGrants,
  computeDemand,
  computeHRes,
  nextPressureState,
  normalizeDynamicPolicy,
  percentile25,
  type DynamicPolicy,
  type GrantAllocation,
} from "../core/resources.js";
import {
  dynamicGuaranteedScore,
  dynamicLiveScore,
  splitCapability,
  type CapabilityDetail,
} from "../capability.js";

const GIB = 1024 ** 3;

export interface PoolRow {
  host_id: string;
  pool_id: string;
  cgroup_available: boolean;
  cgroup_driver: string;
  cpu_total_millicores: number;
  mem_total_bytes: number;
  cpu_granted_millicores: number;
  mem_granted_bytes: number;
  cpu_used_millicores: number;
  mem_used_bytes: number;
  mem_working_set_bytes: number;
  available_commitment_bytes: number;
  pressure_state: string;
  psi: Record<string, unknown>;
  cgroup: Record<string, unknown>;
  reported_at: string | null;
}

export interface ResourceGrantRow {
  host_id: string;
  instance_id: string;
  generation: number;
  cpu_millicores: number;
  memory_bytes: number;
  memory_low_bytes: number;
  memory_high_bytes: number;
  cpu_weight: number;
  /** Instance cap: the hard limit (`cpu.max` / `memory.max`), not the fair share. */
  cap_cpu_millicores?: number;
  cap_mem_bytes?: number;
  state: string;
  applied_generation: number | null;
  applied_at: string | null;
  last_error: string | null;
  updated_at: string;
}

const b = (value: unknown): bigint => {
  try {
    return BigInt(String(value ?? 0));
  } catch {
    return 0n;
  }
};
const n = (value: unknown): number => {
  const x = Number(value);
  return Number.isFinite(x) ? x : 0;
};
const floorNonNeg = (value: unknown): number => Math.max(0, Math.trunc(n(value)));

/** DB policy overrides the deployment-provided base, which itself defaults to DEFAULT_DYNAMIC_POLICY. */
export function policyForScheduler(input?: unknown): DynamicPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.keys(input).length) {
    return config.dynamicPolicy;
  }
  const raw = input as Record<string, unknown>;
  const base = config.dynamicPolicy;
  return normalizeDynamicPolicy({
    ...base,
    ...raw,
    pressure_enter: { ...base.pressure_enter, ...((raw.pressure_enter as object) ?? {}) },
    pressure_exit: { ...base.pressure_exit, ...((raw.pressure_exit as object) ?? {}) },
  });
}

/** Current pool row; creates a zeroed row from hosts on first use. */
export async function getPool(
  c: Client,
  hostId: string,
): Promise<PoolRow & { host_state?: string }> {
  await c.query(
    `INSERT INTO host_resource_pools (host_id, cpu_total_millicores, mem_total_bytes)
     SELECT host_id, GREATEST(cpu_total, 0) * 1000, GREATEST(mem_total_bytes, 0)
       FROM hosts WHERE host_id = $1
     ON CONFLICT (host_id) DO NOTHING`,
    [hostId],
  );
  const row = (
    await c.query(
      `SELECT p.*, h.host_state
         FROM host_resource_pools p JOIN hosts h USING (host_id)
        WHERE p.host_id = $1`,
      [hostId],
    )
  ).rows[0];
  return {
    ...row,
    cpu_total_millicores: n(row?.cpu_total_millicores),
    mem_total_bytes: n(row?.mem_total_bytes),
    cpu_granted_millicores: n(row?.cpu_granted_millicores),
    mem_granted_bytes: n(row?.mem_granted_bytes),
    cpu_used_millicores: n(row?.cpu_used_millicores),
    mem_used_bytes: n(row?.mem_used_bytes),
    mem_working_set_bytes: n(row?.mem_working_set_bytes),
    available_commitment_bytes: n(row?.available_commitment_bytes),
  } as PoolRow & { host_state?: string };
}

export async function listPools(): Promise<Array<PoolRow & { host_state: string }>> {
  const rows = await q(
    `SELECT p.*, h.host_state
       FROM host_resource_pools p JOIN hosts h USING (host_id)
      ORDER BY p.host_id`,
  );
  return rows as Array<PoolRow & { host_state: string }>;
}

export async function getGrants(hostId: string): Promise<ResourceGrantRow[]> {
  return grantsWith(pool, hostId);
}

function mapGrant(r: any): ResourceGrantRow {
  return {
    ...r,
    generation: n(r.generation),
    cpu_millicores: n(r.cpu_millicores),
    memory_bytes: n(r.memory_bytes),
    memory_low_bytes: n(r.memory_low_bytes),
    memory_high_bytes: n(r.memory_high_bytes),
    cpu_weight: n(r.cpu_weight),
    cap_cpu_millicores: r.cap_cpu_millicores === undefined ? undefined : n(r.cap_cpu_millicores),
    cap_mem_bytes: r.cap_mem_bytes === undefined ? undefined : n(r.cap_mem_bytes),
    applied_generation: r.applied_generation === null ? null : n(r.applied_generation),
  } as ResourceGrantRow;
}

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

async function grantsWith(c: Queryable, hostId: string): Promise<ResourceGrantRow[]> {
  const rows = (
    await c.query(
      `SELECT g.*, r.cap_cpu_millicores, r.cap_mem_bytes
         FROM resource_grants g
         JOIN role_instances r USING (instance_id)
        WHERE g.host_id = $1
        ORDER BY g.instance_id`,
      [hostId],
    )
  ).rows;
  return rows.map(mapGrant);
}

/** What a builder daemon must apply, plus the pool state it belongs to. */
export async function getInstanceGrantState(instanceId: string): Promise<{
  instance_id: string;
  host_id: string;
  scheduling_mode: string;
  grant: ResourceGrantRow | null;
  pool: PoolRow | null;
} | null> {
  const owner = await q1<any>(
    `SELECT instance_id, host_id, scheduling_mode FROM role_instances WHERE instance_id = $1`,
    [instanceId],
  );
  if (!owner) return null;
  const grant = await q1<any>(
    `SELECT g.*, r.cap_cpu_millicores, r.cap_mem_bytes
       FROM resource_grants g
       JOIN role_instances r USING (instance_id)
      WHERE g.instance_id = $1`,
    [instanceId],
  );
  const pool = await q1<any>(
    `SELECT * FROM host_resource_pools WHERE host_id = $1`,
    [owner.host_id],
  );
  return {
    instance_id: owner.instance_id,
    host_id: owner.host_id,
    scheduling_mode: owner.scheduling_mode ?? "static",
    grant: grant ? mapGrant(grant) : null,
    pool: pool
      ? {
          ...pool,
          cpu_total_millicores: n(pool.cpu_total_millicores),
          mem_total_bytes: n(pool.mem_total_bytes),
          cpu_granted_millicores: n(pool.cpu_granted_millicores),
          mem_granted_bytes: n(pool.mem_granted_bytes),
          cpu_used_millicores: n(pool.cpu_used_millicores),
          mem_used_bytes: n(pool.mem_used_bytes),
          mem_working_set_bytes: n(pool.mem_working_set_bytes),
          available_commitment_bytes: n(pool.available_commitment_bytes),
        }
      : null,
  };
}

export async function markGrantApplied(input: {
  host_id: string;
  instance_id: string;
  generation: number;
  cpu_millicores?: number;
  memory_bytes?: number;
  memory_low_bytes?: number;
  memory_high_bytes?: number;
  cpu_weight?: number;
}): Promise<{ applied: boolean; state: string }> {
  if (!input.host_id || !input.instance_id) throw new Error("host_id / instance_id are required");
  const row = await q1(
    `UPDATE resource_grants
        SET state = CASE WHEN $3::bigint >= generation THEN 'APPLIED' ELSE 'SUPERSEDED' END,
            applied_generation = $3::bigint,
            applied_cpu_millicores = $4,
            applied_memory_bytes = $5,
            applied_memory_low_bytes = $6,
            applied_memory_high_bytes = $7,
            applied_cpu_weight = $8,
            applied_at = CASE WHEN $3::bigint >= generation THEN app_now() ELSE applied_at END,
            last_error = NULL,
            updated_at = app_now()
      WHERE host_id = $1 AND instance_id = $2
      RETURNING state`,
    [
      input.host_id,
      input.instance_id,
      Math.trunc(input.generation),
      input.cpu_millicores ?? null,
      input.memory_bytes ?? null,
      input.memory_low_bytes ?? null,
      input.memory_high_bytes ?? null,
      input.cpu_weight ?? null,
    ],
  );
  return { applied: Boolean(row), state: String(row?.state ?? "UNKNOWN") };
}

export async function markGrantFailed(input: {
  host_id: string;
  instance_id: string;
  generation: number;
  error: string;
}): Promise<void> {
  await q(
    `UPDATE resource_grants
        SET state = CASE WHEN $3::bigint >= generation THEN 'FAILED' ELSE state END,
            last_error = $4, updated_at = app_now()
      WHERE host_id = $1 AND instance_id = $2`,
    [input.host_id, input.instance_id, Math.trunc(input.generation), String(input.error).slice(0, 500)],
  );
}

interface InstanceDemandRow {
  instance_id: string;
  state: string;
  scheduling_mode: string;
  capability_score: number;
  capability_detail: CapabilityDetail | null;
  cap_cpu_millicores: number;
  cap_mem_bytes: number;
  usage_cpu_millicores: number;
  usage_mem_bytes: number;
  reserved_cpu_millicores: number;
  reserved_mem_bytes: number;
  capability_ceiling_score: number;
}

function capOf(row: InstanceDemandRow, pool: PoolRow): { cpu: number; mem: number } {
  const detail = row.capability_detail ?? {};
  const detailCpu = Math.max(0, Math.round(n(detail.cores) * 1000));
  const detailMem = Math.max(0, Math.round(n(detail.mem_gb) * GIB));
  // If a legacy registration has no cap, fall back to the detail, then to an equal share of the pool.
  const fallbackCpu = Math.max(1, Math.floor(pool.cpu_total_millicores / 4));
  const fallbackMem = Math.max(256 * 1024 ** 2, Math.floor(pool.mem_total_bytes / 8));
  return {
    cpu: Math.max(1, floorNonNeg(row.cap_cpu_millicores) || detailCpu || fallbackCpu),
    mem: Math.max(1, floorNonNeg(row.cap_mem_bytes) || detailMem || fallbackMem),
  };
}

async function demandRows(c: Client, hostId: string): Promise<InstanceDemandRow[]> {
  const rows = (
    await c.query(
      `SELECT r.instance_id, r.state, r.scheduling_mode, r.capability_score,
              r.capability_detail, r.cap_cpu_millicores, r.cap_mem_bytes,
              r.usage_cpu_millicores, r.usage_mem_bytes,
              r.capability_ceiling_score,
              COALESCE(SUM(p.cpu_millicores) FILTER (WHERE l.released_at IS NULL AND l.expires_at > app_now()), 0)::int AS reserved_cpu_millicores,
              COALESCE(SUM(p.memory_bytes) FILTER (WHERE l.released_at IS NULL AND l.expires_at > app_now()), 0)::bigint AS reserved_mem_bytes
         FROM role_instances r
         LEFT JOIN leases l ON l.instance_id = r.instance_id
         LEFT JOIN tasks t ON t.task_id = l.task_id
         LEFT JOIN resource_profiles p ON p.profile_id = t.resource_profile_id
        WHERE r.host_id = $1 AND r.role_id = 'builder'
          AND r.state NOT IN ('OFFLINE','FAILED')
        GROUP BY r.instance_id
        ORDER BY r.instance_id`,
      [hostId],
    )
  ).rows;
  return rows.map((r: any) => ({
    ...r,
    capability_score: n(r.capability_score),
    cap_cpu_millicores: n(r.cap_cpu_millicores),
    cap_mem_bytes: n(r.cap_mem_bytes),
    usage_cpu_millicores: n(r.usage_cpu_millicores),
    usage_mem_bytes: n(r.usage_mem_bytes),
    reserved_cpu_millicores: n(r.reserved_cpu_millicores),
    reserved_mem_bytes: n(r.reserved_mem_bytes),
    capability_ceiling_score: n(r.capability_ceiling_score),
  })) as InstanceDemandRow[];
}

// In-process W_dispatch history: p25 over the recent window. Losing it on restart only makes
// the first recomputation less conservative; it never changes correctness of grants.
const liveHistory = new Map<string, Array<{ at: number; score: number }>>();

function rememberAndPercentile(instanceId: string, score: number, windowSeconds: number): number {
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;
  const list = (liveHistory.get(instanceId) ?? []).filter((x) => x.at >= cutoff);
  list.push({ at: now, score });
  liveHistory.set(instanceId, list);
  return percentile25(list.map((x) => x.score));
}

/**
 * Recompute grants and live capability for one host, inside the caller's transaction.
 *
 * The host row is locked first so concurrent allocators (multiple schedulers sharing one DB,
 * or a claim-triggered recompute racing the periodic loop) serialize per host.
 */
export async function recomputeHostGrants(
  c: Client,
  hostId: string,
  policy: DynamicPolicy = config.dynamicPolicy,
): Promise<{ host_id: string; grants: GrantAllocation[]; pressure_state: string } | null> {
  await c.query(`SELECT host_id FROM hosts WHERE host_id = $1 FOR UPDATE`, [hostId]);
  const pool = await getPool(c, hostId);
  if (!pool.mem_total_bytes && !pool.cpu_total_millicores) return null;

  const memCapacity = Math.max(0, pool.mem_total_bytes);
  const cpuCapacity = Math.max(0, pool.cpu_total_millicores);
  const rawUsedMem = pool.mem_working_set_bytes > 0 ? pool.mem_working_set_bytes : pool.mem_used_bytes;
  const hRes = computeHRes({
    usedMemBytes: rawUsedMem,
    memCapacityBytes: memCapacity,
    usedCpuMillicores: pool.cpu_used_millicores,
    cpuCapacityMillicores: cpuCapacity,
    hMin: policy.h_min,
  });
  const utilization = Math.max(
    memCapacity > 0 ? rawUsedMem / memCapacity : 0,
    cpuCapacity > 0 ? pool.cpu_used_millicores / cpuCapacity : 0,
  );
  const pressureState = nextPressureState(pool.pressure_state, utilization, policy);

  const rows = await demandRows(c, hostId);
  const dynamicRows = rows.filter((r) => r.scheduling_mode === "dynamic");
  const capPairs = new Map<string, { cpu: number; mem: number }>();
  for (const row of rows) capPairs.set(row.instance_id, capOf(row, pool));

  const demands = computeDemand(
    dynamicRows.map((row) => {
      const cap = capPairs.get(row.instance_id)!;
      return {
        instanceId: row.instance_id,
        capCpuMillicores: cap.cpu,
        capMemBytes: cap.mem,
        reservedCpuMillicores: row.reserved_cpu_millicores,
        reservedMemBytes: row.reserved_mem_bytes,
        usedCpuMillicores: row.usage_cpu_millicores,
        usedMemBytes: row.usage_mem_bytes,
        idleFloorCpuMillicores: policy.idle_floor_cpu_millicores,
        idleFloorMemBytes: policy.idle_floor_mem_bytes,
      };
    }),
  );

  const grants = allocateGrants({
    cpuCapacityMillicores: cpuCapacity,
    memCapacityBytes: memCapacity,
    demands,
    pressureState,
    policy,
  });

  // Existing grants are updated only when the computed values actually change; an unchanged
  // allocation keeps its APPLIED state and does not churn generations.
  const existing = new Map(
    (await grantsWith(c, hostId)).map((g) => [g.instance_id, g]),
  );
  for (const grant of grants) {
    const prev = existing.get(grant.instanceId);
    const changed =
      !prev ||
      prev.cpu_millicores !== grant.grantCpuMillicores ||
      prev.memory_bytes !== grant.grantMemBytes ||
      prev.memory_low_bytes !== grant.memoryLowBytes ||
      prev.memory_high_bytes !== grant.memoryHighBytes ||
      prev.cpu_weight !== grant.cpuWeight;
    if (!changed) continue;
    const generation = (prev?.generation ?? 0) + 1;
    await c.query(
      `INSERT INTO resource_grants
         (host_id, instance_id, generation, cpu_millicores, memory_bytes,
          memory_low_bytes, memory_high_bytes, cpu_weight, state, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',app_now())
       ON CONFLICT (host_id, instance_id) DO UPDATE SET
         generation = EXCLUDED.generation,
         cpu_millicores = EXCLUDED.cpu_millicores,
         memory_bytes = EXCLUDED.memory_bytes,
         memory_low_bytes = EXCLUDED.memory_low_bytes,
         memory_high_bytes = EXCLUDED.memory_high_bytes,
         cpu_weight = EXCLUDED.cpu_weight,
         state = 'PENDING',
         updated_at = app_now()`,
      [
        hostId,
        grant.instanceId,
        generation,
        grant.grantCpuMillicores,
        grant.grantMemBytes,
        grant.memoryLowBytes,
        grant.memoryHighBytes,
        grant.cpuWeight,
      ],
    );
    // Pool/grant changes are audit events about an instance, not about a task; keep them out of
    // the task event stream (`task_events.task_id`) and publish on the outbox instead.
    await c.query(
      `INSERT INTO outbox_events
         (event_type, aggregate_type, aggregate_id, aggregate_version, actor_id, payload)
       VALUES ('INSTANCE_GRANT_UPDATED', 'instance', $1, $2, 'scheduler', $3::jsonb)`,
      [
        grant.instanceId,
        generation,
        JSON.stringify({
          host_id: hostId,
          generation,
          cpu_millicores: grant.grantCpuMillicores,
          memory_bytes: grant.grantMemBytes,
          memory_low_bytes: grant.memoryLowBytes,
          memory_high_bytes: grant.memoryHighBytes,
          cpu_weight: grant.cpuWeight,
          pressure_state: pressureState,
        }),
      ],
    );
  }

  // Live capability is per instance, sharing the pool-level H_res.
  const grantByInstance = new Map(grants.map((g) => [g.instanceId, g]));
  const totalCaps = [...capPairs.values()];
  const sumCpu = totalCaps.reduce((s, x) => s + x.cpu, 0) || 1;
  const sumMem = totalCaps.reduce((s, x) => s + x.mem, 0) || 1;
  for (const row of rows) {
    const cap = capPairs.get(row.instance_id)!;
    const split = splitCapability(row.capability_detail, {
      cpu_cores: cap.cpu / 1000,
      mem_gb: cap.mem / GIB,
    });
    const dynamic = row.scheduling_mode === "dynamic";
    const live = dynamic
      ? dynamicLiveScore(split, hRes, { scope: policy.w_degrade_scope, wFloor: policy.w_floor })
      : Math.round(row.capability_score);
    const dispatch = dynamic
      ? rememberAndPercentile(row.instance_id, live, policy.dispatch_window_seconds)
      : live;
    const guaranteed = dynamic
      ? dynamicGuaranteedScore(split, {
          cpu_cores: (cpuCapacity * cap.cpu) / sumCpu / 1000,
          mem_gb: (memCapacity * cap.mem) / sumMem / GIB,
        })
      : Math.round(row.capability_score);
    await c.query(
      `UPDATE role_instances
          SET cap_cpu_millicores = $2,
              cap_mem_bytes = $3,
              capability_static_score = $4,
              capability_ceiling_score = $5,
              capability_live_score = $6,
              capability_dispatch_score = $7,
              capability_guaranteed_score = $8,
              capability_schema_version = 1,
              capability_updated_at = app_now()
        WHERE instance_id = $1`,
      [
        row.instance_id,
        cap.cpu,
        cap.mem,
        split.static_score,
        dynamic ? split.ceiling : Math.round(row.capability_score),
        live,
        dispatch,
        guaranteed,
      ],
    );
    // Existing static rows must keep their frozen legacy W as the ceiling even if the detail changes.
    if (!dynamic) {
      await c.query(
        `UPDATE role_instances
            SET capability_ceiling_score = capability_score,
                capability_live_score = capability_score,
                capability_dispatch_score = capability_score,
                capability_guaranteed_score = capability_score
          WHERE instance_id = $1`,
        [row.instance_id],
      );
    }
    const grant = grantByInstance.get(row.instance_id);
    if (grant && grant.overcommitted) {
      await c.query(
        `INSERT INTO outbox_events
           (event_type, aggregate_type, aggregate_id, actor_id, payload)
         VALUES ('INSTANCE_OVERCOMMITTED', 'instance', $1, 'scheduler', $2::jsonb)`,
        [
          row.instance_id,
          JSON.stringify({
            host_id: hostId,
            grant_cpu_millicores: grant.grantCpuMillicores,
            grant_mem_bytes: grant.grantMemBytes,
            reserved_cpu_millicores: row.reserved_cpu_millicores,
            reserved_mem_bytes: row.reserved_mem_bytes,
          }),
        ],
      );
    }
  }

  // Grants belong to dynamic builders only: drop rows left behind by a removed builder or one
  // that switched back to static mode, so the daemon is never asked to apply a stale scope.
  await c.query(
    `DELETE FROM resource_grants
      WHERE host_id = $1 AND NOT (instance_id = ANY($2::text[]))`,
    [hostId, grants.map((g) => g.instanceId)],
  );

  const grantedCpu = grants.reduce((s, g) => s + g.grantCpuMillicores, 0);
  const grantedMem = grants.reduce((s, g) => s + g.grantMemBytes, 0);
  await c.query(
    `UPDATE host_resource_pools
        SET cpu_granted_millicores = $2,
            mem_granted_bytes = $3,
            available_commitment_bytes = GREATEST(0, $4 - $3),
            pressure_state = $5,
            updated_at = app_now()
      WHERE host_id = $1`,
    [hostId, grantedCpu, grantedMem, memCapacity, pressureState],
  );
  if (pressureState !== pool.pressure_state) {
    await c.query(
      `INSERT INTO outbox_events
         (event_type, aggregate_type, aggregate_id, actor_id, payload)
       VALUES ('HOST_PRESSURE_CHANGED', 'host', $1, 'scheduler', $2::jsonb)`,
      [
        hostId,
        JSON.stringify({
          host_id: hostId,
          from: pool.pressure_state,
          to: pressureState,
          utilization,
          h_res: hRes,
        }),
      ],
    );
  }
  return { host_id: hostId, grants, pressure_state: pressureState };
}

/** Recompute every host that has a pool row. Called by the periodic allocator loop. */
export async function recomputeAllGrants(
  policy: DynamicPolicy = config.dynamicPolicy,
): Promise<Array<{ host_id: string; grants: number; pressure_state: string }>> {
  const rows = await q(`SELECT host_id FROM host_resource_pools ORDER BY host_id`);
  const out: Array<{ host_id: string; grants: number; pressure_state: string }> = [];
  for (const row of rows) {
    const result = await tx((c) => recomputeHostGrants(c, String(row.host_id), policy));
    if (result) {
      out.push({
        host_id: result.host_id,
        grants: result.grants.length,
        pressure_state: result.pressure_state,
      });
    }
  }
  return out;
}

/**
 * Admission view for one instance: grant + reserved + pressure state.
 *
 * `fairShare*` is F_i = C × cap_i / Σ cap over deployed dynamic builders (§8.4). An idle builder's
 * grant is only the idle floor because demand equals reserved, so admission would never let its first
 * task in; a claim may instead commit up to its guaranteed share, and the allocator then raises the
 * grant to cover the new reservation.
 */
export async function instanceResourceState(
  c: Client,
  instanceId: string,
): Promise<{
  mode: string;
  grant: ResourceGrantRow | null;
  reservedCpuMillicores: number;
  reservedMemBytes: number;
  fairShareCpuMillicores: number;
  fairShareMemBytes: number;
  pool: PoolRow | null;
} | null> {
  const row = (
    await c.query(
      `SELECT r.instance_id, r.host_id, r.scheduling_mode
         FROM role_instances r WHERE r.instance_id = $1`,
      [instanceId],
    )
  ).rows[0];
  if (!row) return null;
  const reserved = (
    await c.query(
      `SELECT COALESCE(SUM(p.cpu_millicores),0)::int AS cpu,
              COALESCE(SUM(p.memory_bytes),0)::bigint AS mem
         FROM leases l
         JOIN tasks t ON t.task_id = l.task_id
         JOIN resource_profiles p ON p.profile_id = t.resource_profile_id
        WHERE l.instance_id = $1 AND l.released_at IS NULL AND l.expires_at > app_now()`,
      [instanceId],
    )
  ).rows[0];
  const grant = (
    await c.query(
      `SELECT * FROM resource_grants WHERE instance_id = $1 LIMIT 1`,
      [instanceId],
    )
  ).rows[0] ?? null;
  const pool = await getPool(c, String(row.host_id));
  const siblings = (await demandRows(c, String(row.host_id))).filter(
    (r) => r.scheduling_mode === "dynamic",
  );
  const capPairs = new Map(
    siblings.map((r) => [r.instance_id, capOf(r, pool)] as const),
  );
  const own = capPairs.get(instanceId) ?? { cpu: 0, mem: 0 };
  const sumCpu = [...capPairs.values()].reduce((s, x) => s + x.cpu, 0);
  const sumMem = [...capPairs.values()].reduce((s, x) => s + x.mem, 0);
  return {
    mode: String(row.scheduling_mode ?? "static"),
    grant: grant
      ? {
          ...grant,
          generation: n(grant.generation),
          cpu_millicores: n(grant.cpu_millicores),
          memory_bytes: n(grant.memory_bytes),
          memory_low_bytes: n(grant.memory_low_bytes),
          memory_high_bytes: n(grant.memory_high_bytes),
          cpu_weight: n(grant.cpu_weight),
          applied_generation: grant.applied_generation === null ? null : n(grant.applied_generation),
        }
      : null,
    reservedCpuMillicores: n(reserved?.cpu),
    reservedMemBytes: n(reserved?.mem),
    fairShareCpuMillicores:
      sumCpu > 0 ? Math.floor((pool.cpu_total_millicores * own.cpu) / sumCpu) : 0,
    fairShareMemBytes: sumMem > 0 ? Math.floor((pool.mem_total_bytes * own.mem) / sumMem) : 0,
    pool,
  };
}
