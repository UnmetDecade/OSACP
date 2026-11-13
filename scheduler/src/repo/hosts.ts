import { tx, type Client } from "../db.js";
import { ApiError } from "../errors.js";
import { config } from "../config.js";

export interface PoolInstanceUsage {
  instance_id: string;
  cpu_millicores?: number;
  mem_bytes?: number;
  /** Values the daemon read back after applying a grant; used to move the grant to APPLIED. */
  applied_generation?: number;
  applied_cpu_millicores?: number;
  applied_memory_bytes?: number;
  applied_memory_low_bytes?: number;
  applied_memory_high_bytes?: number;
  applied_cpu_weight?: number;
}

/** Pool-level metrics reported by host-runtime (cgroup v2 + PSI). */
export interface PoolReportInput {
  pool_id?: string;
  cgroup_available?: boolean;
  cgroup_driver?: string;
  cpu_total_millicores?: number;
  mem_total_bytes?: number;
  cpu_used_millicores?: number;
  mem_used_bytes?: number;
  mem_working_set_bytes?: number;
  pressure_state?: string;
  psi?: Record<string, unknown>;
  cgroup?: Record<string, unknown>;
  reported_at?: string;
  instances?: PoolInstanceUsage[];
}

/** Host facts reported by the control plane (PCS) or host-runtime; the scheduler uses them only to maintain the dispatchable host table. */
export interface HostSyncInput {
  host_id: string;
  name?: string;
  os?: string;
  arch?: string;
  host_state?: string;
  cpu_total?: number;
  mem_total_bytes?: number;
  mem_available_bytes?: number;
  resource_pool?: PoolReportInput;
}

const STATES = new Set(["NORMAL", "WARNING", "THROTTLED", "PROTECTING", "RECOVERING"]);
const PRESSURE = new Set(["NORMAL", "BUSY", "PRESSURE", "CRITICAL", "RECOVERING"]);

const nonNeg = (value: unknown): number => Math.max(0, Math.trunc(Number(value) || 0));

async function upsertPoolRow(c: Client, hostId: string, pool: PoolReportInput): Promise<void> {
  const instances = Array.isArray(pool.instances) ? pool.instances : [];
  const old = (
    await c.query(
      `SELECT cpu_used_millicores, mem_used_bytes, mem_working_set_bytes
         FROM host_resource_pools WHERE host_id = $1`,
      [hostId],
    )
  ).rows[0];
  const alpha = Math.max(0, Math.min(1, config.dynamicPolicy.ewma_alpha));
  const smooth = (next: number, prev: number | undefined): number =>
    prev === undefined ? next : Math.round(alpha * next + (1 - alpha) * Number(prev));
  const cpuUsed = smooth(nonNeg(pool.cpu_used_millicores), old?.cpu_used_millicores);
  const memUsed = smooth(nonNeg(pool.mem_used_bytes), old?.mem_used_bytes);
  const workingSet = nonNeg(pool.mem_working_set_bytes) || memUsed;
  const pressure = String(pool.pressure_state ?? "").toUpperCase();

  await c.query(
    `INSERT INTO host_resource_pools
       (host_id, pool_id, cgroup_available, cgroup_driver,
        cpu_total_millicores, mem_total_bytes,
        cpu_used_millicores, mem_used_bytes, mem_working_set_bytes,
        psi, cgroup, reported_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,COALESCE($12::timestamptz,app_now()),app_now())
     ON CONFLICT (host_id) DO UPDATE SET
       pool_id = EXCLUDED.pool_id,
       cgroup_available = EXCLUDED.cgroup_available,
       cgroup_driver = EXCLUDED.cgroup_driver,
       cpu_total_millicores = CASE WHEN EXCLUDED.cpu_total_millicores > 0 THEN EXCLUDED.cpu_total_millicores ELSE host_resource_pools.cpu_total_millicores END,
       mem_total_bytes = CASE WHEN EXCLUDED.mem_total_bytes > 0 THEN EXCLUDED.mem_total_bytes ELSE host_resource_pools.mem_total_bytes END,
       cpu_used_millicores = EXCLUDED.cpu_used_millicores,
       mem_used_bytes = EXCLUDED.mem_used_bytes,
       mem_working_set_bytes = EXCLUDED.mem_working_set_bytes,
       pressure_state = CASE WHEN $13::text = ANY('{NORMAL,BUSY,PRESSURE,CRITICAL,RECOVERING}'::text[]) THEN $13::text ELSE host_resource_pools.pressure_state END,
       psi = EXCLUDED.psi,
       cgroup = EXCLUDED.cgroup,
       reported_at = EXCLUDED.reported_at,
       updated_at = app_now()`,
    [
      hostId,
      String(pool.pool_id ?? "osacp.slice/pool.slice"),
      Boolean(pool.cgroup_available),
      String(pool.cgroup_driver ?? "cgroupfs"),
      nonNeg(pool.cpu_total_millicores),
      nonNeg(pool.mem_total_bytes),
      Math.min(cpuUsed, nonNeg(pool.cpu_total_millicores) || cpuUsed),
      Math.min(memUsed, nonNeg(pool.mem_total_bytes) || memUsed),
      workingSet,
      JSON.stringify(pool.psi ?? {}),
      JSON.stringify(pool.cgroup ?? {}),
      pool.reported_at ?? null,
      // The scheduler owns the pressure state machine; a report that omits it must not reset it to NORMAL.
      PRESSURE.has(pressure) ? pressure : null,
    ],
  );

  // Per-instance usage feeds demand only; it is smoothed the same way as the pool total.
  for (const item of instances) {
    const instanceId = String(item.instance_id ?? "").trim();
    if (!instanceId) continue;
    const prev = (
      await c.query(
        `SELECT usage_cpu_millicores, usage_mem_bytes
           FROM role_instances WHERE instance_id = $1 AND host_id = $2`,
        [instanceId, hostId],
      )
    ).rows[0];
    if (!prev) continue;
    const cpu = smooth(nonNeg(item.cpu_millicores), prev.usage_cpu_millicores);
    const mem = smooth(nonNeg(item.mem_bytes), prev.usage_mem_bytes);
    await c.query(
      `UPDATE role_instances
          SET usage_cpu_millicores = $2, usage_mem_bytes = $3, usage_updated_at = app_now()
        WHERE instance_id = $1`,
      [instanceId, cpu, mem],
    );

    // The daemon reports the generation it actually applied; the scheduler trusts only this readback.
    const appliedGeneration = Number(item.applied_generation ?? 0);
    if (Number.isFinite(appliedGeneration) && appliedGeneration > 0) {
      await c.query(
        `UPDATE resource_grants
            SET state = CASE WHEN $3::bigint >= generation THEN 'APPLIED' ELSE 'SUPERSEDED' END,
                applied_generation = $3::bigint,
                applied_cpu_millicores = $4,
                applied_memory_bytes = $5,
                applied_memory_low_bytes = $6,
                applied_memory_high_bytes = $7,
                applied_cpu_weight = $8,
                applied_at = CASE WHEN $3::bigint >= generation THEN app_now() ELSE applied_at END,
                updated_at = app_now()
          WHERE host_id = $1 AND instance_id = $2
            AND $3::bigint >= COALESCE(applied_generation, 0)`,
        [
          hostId,
          instanceId,
          appliedGeneration,
          item.applied_cpu_millicores ?? null,
          item.applied_memory_bytes ?? null,
          item.applied_memory_low_bytes ?? null,
          item.applied_memory_high_bytes ?? null,
          item.applied_cpu_weight ?? null,
        ],
      );
    }
  }
}

/**
 * Host roster sync. Unknown states all collapse to PROTECTING: better to stop dispatching for now
 * than let a machine in an unknown state take tasks.
 */
export async function upsertHost(input: HostSyncInput) {
  const hostId = String(input.host_id ?? "").trim();
  if (!hostId) throw new ApiError(400, "BAD_REQUEST", "host_id is required");
  const raw = String(input.host_state ?? "NORMAL").toUpperCase();
  const hostState = STATES.has(raw) ? raw : "PROTECTING";
  const memTotal = Math.max(0, Math.trunc(Number(input.mem_total_bytes) || 0));
  const memAvailable = Math.min(memTotal, Math.max(0, Math.trunc(Number(input.mem_available_bytes) || 0)));
  const cpuTotal = Math.max(1, Math.trunc(Number(input.cpu_total) || 4));

  await tx(async (c) => {
    await c.query(
      `INSERT INTO hosts
         (host_id, name, os, arch, host_state, cpu_total, mem_total_bytes, mem_available_bytes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,app_now())
       ON CONFLICT (host_id) DO UPDATE SET
         name = EXCLUDED.name,
         os = EXCLUDED.os,
         arch = EXCLUDED.arch,
         host_state = EXCLUDED.host_state,
         cpu_total = EXCLUDED.cpu_total,
         mem_total_bytes = EXCLUDED.mem_total_bytes,
         mem_available_bytes = EXCLUDED.mem_available_bytes,
         updated_at = app_now()`,
      [
        hostId,
        String(input.name ?? hostId),
        String(input.os ?? "Linux"),
        String(input.arch ?? "-"),
        hostState,
        cpuTotal,
        memTotal,
        memAvailable,
      ],
    );

    // Existing hosts gain a pool row on first contact, with the reported capacity or the host totals.
    await c.query(
      `INSERT INTO host_resource_pools
         (host_id, cpu_total_millicores, mem_total_bytes, reported_at, updated_at)
       VALUES ($1,$2,$3,NULL,app_now())
       ON CONFLICT (host_id) DO NOTHING`,
      [hostId, cpuTotal * 1000, memTotal],
    );

    if (input.resource_pool) await upsertPoolRow(c, hostId, input.resource_pool);
  });
  return { host_id: hostId, host_state: hostState };
}
