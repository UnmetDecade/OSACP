/**
 * Dynamic scheduling math (v0.3 §6, §8, §9, §11).
 *
 * Everything here is pure and deterministic: capacities and allocations use integers
 * (millicores / bytes) so repeated recomputation does not drift and tests can pin exact values.
 */

export const MIB = 1024 ** 2;

export type WDegradeScope = "resource" | "whole";

export interface DynamicPolicy {
  max_instances_per_host: number;
  cpu_single_overcommit: number;
  overcommit_warn: number;
  h_min: number;
  w_floor: number;
  w_degrade_scope: WDegradeScope;
  pressure_enter: { busy: number; pressure: number; critical: number };
  pressure_exit: { busy: number; pressure: number; critical: number };
  recovery_hold_seconds: number;
  grant_update_interval_seconds: number;
  reclaim_cooldown_seconds: number;
  reclaim_check_window_seconds: number;
  reclaim_max_steps: number;
  require_applied_before_start: boolean;
  idle_floor_cpu_millicores: number;
  idle_floor_mem_bytes: number;
  ewma_alpha: number;
  dispatch_window_seconds: number;
}

export const DEFAULT_DYNAMIC_POLICY: DynamicPolicy = {
  max_instances_per_host: 64,
  cpu_single_overcommit: 4,
  overcommit_warn: 2.0,
  h_min: 0.05,
  w_floor: 25,
  w_degrade_scope: "resource",
  pressure_enter: { busy: 0.7, pressure: 0.85, critical: 0.95 },
  pressure_exit: { busy: 0.6, pressure: 0.75, critical: 0.9 },
  recovery_hold_seconds: 60,
  grant_update_interval_seconds: 5,
  reclaim_cooldown_seconds: 3,
  reclaim_check_window_seconds: 5,
  reclaim_max_steps: 3,
  require_applied_before_start: true,
  idle_floor_cpu_millicores: 50,
  idle_floor_mem_bytes: 128 * MIB,
  ewma_alpha: 0.3,
  dispatch_window_seconds: 15,
};

const num = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const ratio = (value: unknown, fallback: number): number => {
  const n = num(value, fallback);
  return Math.max(0, Math.min(1, n));
};

/** Unknown/missing policy fields fall back to the documented defaults; values are clamped to safe ranges. */
export function normalizeDynamicPolicy(input: unknown): DynamicPolicy {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, any>)
    : {};
  const enter = raw.pressure_enter ?? {};
  const exit = raw.pressure_exit ?? {};
  return {
    max_instances_per_host: Math.max(1, Math.trunc(num(raw.max_instances_per_host, DEFAULT_DYNAMIC_POLICY.max_instances_per_host))),
    cpu_single_overcommit: Math.max(1, num(raw.cpu_single_overcommit, DEFAULT_DYNAMIC_POLICY.cpu_single_overcommit)),
    overcommit_warn: Math.max(0, num(raw.overcommit_warn, DEFAULT_DYNAMIC_POLICY.overcommit_warn)),
    h_min: ratio(raw.h_min, DEFAULT_DYNAMIC_POLICY.h_min),
    w_floor: Math.max(0, Math.min(1000, Math.trunc(num(raw.w_floor, DEFAULT_DYNAMIC_POLICY.w_floor)))),
    w_degrade_scope: raw.w_degrade_scope === "whole" ? "whole" : "resource",
    pressure_enter: {
      busy: ratio(enter.busy, DEFAULT_DYNAMIC_POLICY.pressure_enter.busy),
      pressure: ratio(enter.pressure, DEFAULT_DYNAMIC_POLICY.pressure_enter.pressure),
      critical: ratio(enter.critical, DEFAULT_DYNAMIC_POLICY.pressure_enter.critical),
    },
    pressure_exit: {
      busy: ratio(exit.busy, DEFAULT_DYNAMIC_POLICY.pressure_exit.busy),
      pressure: ratio(exit.pressure, DEFAULT_DYNAMIC_POLICY.pressure_exit.pressure),
      critical: ratio(exit.critical, DEFAULT_DYNAMIC_POLICY.pressure_exit.critical),
    },
    recovery_hold_seconds: Math.max(0, num(raw.recovery_hold_seconds, DEFAULT_DYNAMIC_POLICY.recovery_hold_seconds)),
    grant_update_interval_seconds: Math.max(1, num(raw.grant_update_interval_seconds, DEFAULT_DYNAMIC_POLICY.grant_update_interval_seconds)),
    reclaim_cooldown_seconds: Math.max(0, num(raw.reclaim_cooldown_seconds, DEFAULT_DYNAMIC_POLICY.reclaim_cooldown_seconds)),
    reclaim_check_window_seconds: Math.max(1, num(raw.reclaim_check_window_seconds, DEFAULT_DYNAMIC_POLICY.reclaim_check_window_seconds)),
    reclaim_max_steps: Math.max(1, Math.trunc(num(raw.reclaim_max_steps, DEFAULT_DYNAMIC_POLICY.reclaim_max_steps))),
    require_applied_before_start: raw.require_applied_before_start === undefined
      ? DEFAULT_DYNAMIC_POLICY.require_applied_before_start
      : Boolean(raw.require_applied_before_start),
    idle_floor_cpu_millicores: Math.max(0, Math.trunc(num(raw.idle_floor_cpu_millicores, DEFAULT_DYNAMIC_POLICY.idle_floor_cpu_millicores))),
    idle_floor_mem_bytes: Math.max(0, Math.trunc(num(raw.idle_floor_mem_bytes, DEFAULT_DYNAMIC_POLICY.idle_floor_mem_bytes))),
    ewma_alpha: ratio(raw.ewma_alpha, DEFAULT_DYNAMIC_POLICY.ewma_alpha),
    dispatch_window_seconds: Math.max(1, num(raw.dispatch_window_seconds, DEFAULT_DYNAMIC_POLICY.dispatch_window_seconds)),
  };
}

/** H_res uses actual usage only; committed-but-unused grants never lower W (§6.3). */
export function computeHRes(input: {
  usedMemBytes: number;
  memCapacityBytes: number;
  usedCpuMillicores: number;
  cpuCapacityMillicores: number;
  hMin: number;
}): number {
  const uMem = input.memCapacityBytes > 0
    ? Math.max(0, Math.min(1, input.usedMemBytes / input.memCapacityBytes))
    : 0;
  const uCpu = input.cpuCapacityMillicores > 0
    ? Math.max(0, Math.min(1, input.usedCpuMillicores / input.cpuCapacityMillicores))
    : 0;
  const min = Math.max(0, Math.min(1, input.hMin));
  return Math.max(min, Math.min(1, 1 - Math.max(uMem, uCpu)));
}

/** 25th percentile of the recent W_live samples (nearest-rank, deterministic). */
export function percentile25(samples: number[]): number {
  const values = samples.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!values.length) return 0;
  const rank = Math.max(1, Math.ceil(values.length * 0.25));
  return Math.round(values[Math.min(values.length - 1, rank - 1)]);
}

export interface DemandInput {
  instanceId: string;
  capCpuMillicores: number;
  capMemBytes: number;
  reservedCpuMillicores: number;
  reservedMemBytes: number;
  usedCpuMillicores: number;
  usedMemBytes: number;
  idleFloorCpuMillicores: number;
  idleFloorMemBytes: number;
}

export interface Demand {
  instanceId: string;
  capCpuMillicores: number;
  capMemBytes: number;
  reservedCpuMillicores: number;
  reservedMemBytes: number;
  demandCpuMillicores: number;
  demandMemBytes: number;
  weightCpu: number;
  weightMem: number;
}

/**
 * demand = max(reserved, used, idle floor) and the weight is the cap share among deployed instances.
 * Cap is clamped to at least zero; a zero cap still receives the minimum weight (1) for determinism.
 */
export function computeDemand(inputs: DemandInput[]): Demand[] {
  const totalCapCpu = inputs.reduce((sum, i) => sum + Math.max(0, i.capCpuMillicores), 0);
  const totalCapMem = inputs.reduce((sum, i) => sum + Math.max(0, i.capMemBytes), 0);
  return inputs.map((i) => {
    const capCpu = Math.max(0, Math.trunc(i.capCpuMillicores));
    const capMem = Math.max(0, Math.trunc(i.capMemBytes));
    const floorCpu = Math.min(capCpu, Math.max(0, Math.trunc(i.idleFloorCpuMillicores)));
    const floorMem = Math.min(capMem, Math.max(0, Math.trunc(i.idleFloorMemBytes)));
    return {
      instanceId: i.instanceId,
      capCpuMillicores: capCpu,
      capMemBytes: capMem,
      reservedCpuMillicores: Math.max(0, Math.trunc(i.reservedCpuMillicores)),
      reservedMemBytes: Math.max(0, Math.trunc(i.reservedMemBytes)),
      demandCpuMillicores: Math.min(
        capCpu,
        Math.max(0, Math.trunc(Math.max(i.reservedCpuMillicores, i.usedCpuMillicores, floorCpu))),
      ),
      demandMemBytes: Math.min(
        capMem,
        Math.max(0, Math.trunc(Math.max(i.reservedMemBytes, i.usedMemBytes, floorMem))),
      ),
      // Normalize to per-mille integers so the water filler stays integer-only.
      weightCpu: totalCapCpu > 0
        ? Math.max(1, Math.round((capCpu / totalCapCpu) * 1_000_000))
        : 1_000_000,
      weightMem: totalCapMem > 0
        ? Math.max(1, Math.round((capMem / totalCapMem) * 1_000_000))
        : 1_000_000,
    };
  });
}

export interface WaterFillItem {
  instanceId: string;
  cap: number;
  demand: number;
  weight: number;
  floor: number;
}

/**
 * Weighted max-min water filling (§8.5), integer and deterministic.
 *
 * 1. Start every instance at min(demand, cap, floor).
 * 2. Distribute the remaining capacity by weight among instances that still have room.
 * 3. If integer floors leave a remainder, hand out single units by instance id.
 *
 * Returns a map instance_id -> grant. Σgrant never exceeds capacity, and grant never exceeds min(demand, cap).
 */
export function waterFill(capacity: number, items: WaterFillItem[]): Map<string, number> {
  const cap = Math.max(0, Math.trunc(capacity));
  const sorted = [...items].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  const grants = new Map<string, number>();
  for (const item of sorted) {
    const upper = Math.max(0, Math.min(Math.trunc(item.demand), Math.trunc(item.cap)));
    const floor = Math.max(0, Math.min(upper, Math.trunc(item.floor)));
    grants.set(item.instanceId, floor);
  }

  let remaining = cap - [...grants.values()].reduce((a, b) => a + b, 0);
  if (remaining <= 0) return grants;

  const active = () =>
    sorted.filter((item) => {
      const upper = Math.max(0, Math.min(Math.trunc(item.demand), Math.trunc(item.cap)));
      return (grants.get(item.instanceId) ?? 0) < upper;
    });

  let guard = 0;
  while (remaining > 0 && guard++ < sorted.length + 4) {
    const set = active();
    if (!set.length) break;
    const totalWeight = set.reduce((sum, i) => sum + Math.max(1, Math.trunc(i.weight)), 0);
    let added = 0;
    for (const item of set) {
      const value = grants.get(item.instanceId) ?? 0;
      const upper = Math.max(0, Math.min(Math.trunc(item.demand), Math.trunc(item.cap)));
      const room = upper - value;
      // Byte capacities make remaining × weight exceed 2^53; BigInt keeps the split exact and
      // bounds the single-unit remainder pass to a handful of values.
      const share = Number(
        (BigInt(remaining) * BigInt(Math.max(1, Math.trunc(item.weight)))) / BigInt(totalWeight),
      );
      const add = Math.min(room, share, remaining - added);
      if (add > 0) {
        grants.set(item.instanceId, value + add);
        added += add;
      }
    }
    remaining -= added;
    if (added === 0) break;
  }

  // Integer remainder: one millicore/byte at a time in stable instance order, up to each upper bound.
  let changed = true;
  while (remaining > 0 && changed) {
    changed = false;
    for (const item of sorted) {
      if (remaining <= 0) break;
      const value = grants.get(item.instanceId) ?? 0;
      const upper = Math.max(0, Math.min(Math.trunc(item.demand), Math.trunc(item.cap)));
      if (value < upper) {
        grants.set(item.instanceId, value + 1);
        remaining -= 1;
        changed = true;
      }
    }
  }
  return grants;
}

export interface GrantAllocation {
  instanceId: string;
  capCpuMillicores: number;
  capMemBytes: number;
  demandCpuMillicores: number;
  demandMemBytes: number;
  grantCpuMillicores: number;
  grantMemBytes: number;
  memoryLowBytes: number;
  memoryHighBytes: number;
  cpuWeight: number;
  overcommitted: boolean;
}

/**
 * Compute CPU and memory grants independently (§8.3), then map them to cgroup values:
 *   grant -> memory.low / cpu.weight; cap -> memory.max / cpu.max; memory.high is a pressure threshold.
 */
export function allocateGrants(input: {
  cpuCapacityMillicores: number;
  memCapacityBytes: number;
  demands: Demand[];
  pressureState?: string;
  policy: Pick<DynamicPolicy, "idle_floor_cpu_millicores" | "idle_floor_mem_bytes">;
}): GrantAllocation[] {
  const memCapacity = Math.max(0, Math.trunc(input.memCapacityBytes));
  const cpuCapacity = Math.max(0, Math.trunc(input.cpuCapacityMillicores));
  const memGrants = waterFill(
    memCapacity,
    input.demands.map((d) => ({
      instanceId: d.instanceId,
      cap: d.capMemBytes,
      demand: d.demandMemBytes,
      weight: d.weightMem,
      floor: Math.min(d.capMemBytes, input.policy.idle_floor_mem_bytes),
    })),
  );
  const cpuGrants = waterFill(
    cpuCapacity,
    input.demands.map((d) => ({
      instanceId: d.instanceId,
      cap: d.capCpuMillicores,
      demand: d.demandCpuMillicores,
      weight: d.weightCpu,
      floor: Math.min(d.capCpuMillicores, input.policy.idle_floor_cpu_millicores),
    })),
  );

  const pressure = String(input.pressureState ?? "NORMAL");
  const highRatio = pressure === "CRITICAL" ? 1.0 : pressure === "PRESSURE" ? 1.1 : 1.25;
  const minHigh = 16 * MIB;

  return input.demands.map((d) => {
    const grantMem = Math.max(0, memGrants.get(d.instanceId) ?? 0);
    const grantCpu = Math.max(0, cpuGrants.get(d.instanceId) ?? 0);
    const capMem = Math.max(0, d.capMemBytes);
    // Normal: memory.high is a cap-level throttle, so idle instances may borrow up to their cap.
    // Under pressure it drops to just above the grant, which is what makes reclaim effective.
    const pressureHigh = Math.max(minHigh, Math.min(capMem, Math.round(grantMem * highRatio)));
    const memoryHigh = pressure === "NORMAL" || pressure === "BUSY"
      ? capMem
      : Math.min(capMem, pressureHigh);
    const finalCpu = Math.min(grantCpu, Math.max(0, d.capCpuMillicores));
    const finalMem = Math.min(grantMem, capMem);
    return {
      instanceId: d.instanceId,
      capCpuMillicores: Math.max(0, d.capCpuMillicores),
      capMemBytes: capMem,
      demandCpuMillicores: d.demandCpuMillicores,
      demandMemBytes: d.demandMemBytes,
      grantCpuMillicores: finalCpu,
      grantMemBytes: finalMem,
      memoryLowBytes: finalMem,
      memoryHighBytes: memoryHigh,
      cpuWeight: Math.max(
        1,
        cpuCapacity > 0
          ? Math.round((10_000 * finalCpu) / cpuCapacity)
          : 1,
      ),
      // A grant below already-committed reservations is an allowed temporary state; admission stops.
      overcommitted:
        finalCpu < d.reservedCpuMillicores || finalMem < d.reservedMemBytes,
    };
  });
}

/** k(i, τ): how many tasks of this type the instance may still take (§9.1). */
export function computeConcurrency(input: {
  remainingCpuMillicores: number;
  remainingMemBytes: number;
  requestCpuMillicores: number;
  requestMemBytes: number;
  kMax: number;
}): number {
  if (input.requestCpuMillicores <= 0 || input.requestMemBytes <= 0) return 0;
  const cpu = Math.floor(Math.max(0, input.remainingCpuMillicores) / input.requestCpuMillicores);
  const mem = Math.floor(Math.max(0, input.remainingMemBytes) / input.requestMemBytes);
  return Math.max(0, Math.min(Math.max(0, Math.trunc(input.kMax)), cpu, mem));
}

/** 1s, 2s, 4s … capped at backoff max (§11.3). */
export function backoffSeconds(blockedAttempts: number, baseSeconds: number, maxSeconds: number): number {
  const base = Math.max(1, Math.trunc(baseSeconds));
  const max = Math.max(base, Math.trunc(maxSeconds));
  const n = Math.max(0, Math.min(6, Math.trunc(blockedAttempts)));
  return Math.min(max, base * 2 ** n);
}

/**
 * Pressure state transitions with separate enter/exit thresholds (§10.2). The input utilization is
 * max(memory, cpu) in [0,1]; hysteresis prevents flapping around a single boundary.
 */
export function nextPressureState(
  current: string,
  utilization: number,
  policy: Pick<DynamicPolicy, "pressure_enter" | "pressure_exit">,
): "NORMAL" | "BUSY" | "PRESSURE" | "CRITICAL" | "RECOVERING" {
  const u = Math.max(0, Math.min(1, Number.isFinite(utilization) ? utilization : 0));
  const now = String(current || "NORMAL");
  const enter = policy.pressure_enter;
  const exit = policy.pressure_exit;
  if (now === "CRITICAL") return u <= exit.critical ? "RECOVERING" : "CRITICAL";
  if (now === "PRESSURE") {
    if (u >= enter.critical) return "CRITICAL";
    return u <= exit.pressure ? "RECOVERING" : "PRESSURE";
  }
  if (now === "RECOVERING") {
    if (u >= enter.critical) return "CRITICAL";
    if (u >= enter.pressure) return "PRESSURE";
    return u <= exit.busy ? "NORMAL" : "RECOVERING";
  }
  if (now === "BUSY") {
    if (u >= enter.pressure) return "PRESSURE";
    return u <= exit.busy ? "NORMAL" : "BUSY";
  }
  if (u >= enter.critical) return "CRITICAL";
  if (u >= enter.pressure) return "PRESSURE";
  if (u >= enter.busy) return "BUSY";
  return "NORMAL";
}

/** Whether a pressure state may accept new claims (§10.2). */
export function admissionAllowedByPressure(state: string): boolean {
  return state === "NORMAL" || state === "BUSY" || state === "RECOVERING";
}
