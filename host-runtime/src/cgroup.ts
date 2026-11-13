import fs from "node:fs";
import path from "node:path";

/**
 * cgroup v2 resource-pool manager for dynamic scheduling (design v0.3 §7).
 *
 * Layout:
 *   <base>/osacp.slice/
 *     platform.slice/        host-runtime / scheduler / monitor; memory.min protects it
 *     pool.slice/            every builder; the capacity C used by the scheduler ledger
 *       builder-<id>.scope/  one per builder: memory.max=cap, memory.low=grant,
 *                            memory.high=pressure threshold, cpu.max=cap, cpu.weight∝grant
 *
 * The manager never guesses: every value written is read back, and the report carries the applied
 * generation so the scheduler can move a grant from PENDING to APPLIED.
 */

export interface ResourcePoolConfig {
  enabled: boolean;
  base_path: string;
  /** Relative path under base_path, e.g. "osacp.slice/pool.slice". */
  pool_id: string;
  platform_memory_min_bytes: number;
  /** 0 = use the host's total memory. */
  pool_memory_max_bytes: number;
  cpu_period_us: number;
}

export interface AppliedGrant {
  instance_id: string;
  scope: string;
  generation: number;
  cpu_millicores: number;
  memory_bytes: number;
  memory_low_bytes: number;
  memory_high_bytes: number;
  cpu_weight: number;
  applied: boolean;
  error?: string;
}

export interface InstanceUsage {
  instance_id: string;
  cpu_millicores: number;
  mem_bytes: number;
  working_set_bytes: number;
  memory_max_bytes: number;
  memory_low_bytes: number;
  memory_high_bytes: number;
  cpu_max_quota: number;
  cpu_weight: number;
  oom_events: number;
  applied_generation: number | null;
  applied_cpu_millicores: number | null;
  applied_memory_bytes: number | null;
  applied_memory_low_bytes: number | null;
  applied_memory_high_bytes: number | null;
  applied_cpu_weight: number | null;
}

export interface PoolSnapshot {
  pool_id: string;
  cgroup_available: boolean;
  cgroup_driver: string;
  cpu_total_millicores: number;
  mem_total_bytes: number;
  cpu_used_millicores: number;
  mem_used_bytes: number;
  mem_working_set_bytes: number;
  psi: Record<string, unknown>;
  cgroup: Record<string, unknown>;
  reported_at: string;
  instances: InstanceUsage[];
}

interface CpuSample {
  usageUsec: number;
  at: number;
}

const MIB = 1024 ** 2;

function read(pathname: string): string | null {
  try {
    return fs.readFileSync(pathname, "utf8").trim();
  } catch {
    return null;
  }
}

function readNumber(pathname: string): number | null {
  const raw = read(pathname);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function write(pathname: string, value: string): void {
  fs.writeFileSync(pathname, `${value}\n`);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** cgroup names allow [A-Za-z0-9_.-]; base64url of the UTF-8 id is reversible and collision-free. */
export function scopeName(instanceId: string): string {
  const encoded = Buffer.from(instanceId, "utf8").toString("base64url");
  return `builder-${encoded}.scope`;
}

export function instanceIdFromScope(name: string): string | null {
  const m = /^builder-([A-Za-z0-9_-]+)\.scope$/.exec(name);
  if (!m) return null;
  try {
    return Buffer.from(m[1], "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function pressureOf(file: string): Record<string, number> | null {
  const raw = read(file);
  if (!raw) return null;
  const out: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const m = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)/.exec(
      line.trim(),
    );
    if (!m) continue;
    out[`${m[1]}_avg10`] = Number(m[2]);
    out[`${m[1]}_avg60`] = Number(m[3]);
    out[`${m[1]}_avg300`] = Number(m[4]);
    out[`${m[1]}_total_usec`] = Number(m[5]);
  }
  return Object.keys(out).length ? out : null;
}

function memoryStat(dir: string): { workingSet: number; current: number } {
  const current = readNumber(path.join(dir, "memory.current")) ?? 0;
  const stat = read(path.join(dir, "memory.stat")) ?? "";
  let inactiveFile = 0;
  for (const line of stat.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === "inactive_file") inactiveFile = Number(value) || 0;
  }
  return { current, workingSet: Math.max(0, current - inactiveFile) };
}

function cpuStat(dir: string): { usageUsec: number } {
  const raw = read(path.join(dir, "cpu.stat")) ?? "";
  for (const line of raw.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === "usage_usec") return { usageUsec: Number(value) || 0 };
  }
  return { usageUsec: 0 };
}

export class CgroupManager {
  /** cgroup v2 exists and the base path is writable. */
  readonly available: boolean;
  /** The slice tree exists and pool limits were applied; grants may be written. */
  private initialized = false;
  private readonly cfg: ResourcePoolConfig;
  private readonly log: (message: string) => void;
  private readonly poolDir: string;
  private readonly platformDir: string;
  private cpuSamples = new Map<string, CpuSample>();
  private poolCpuSample: CpuSample | null = null;
  private totalMemBytes = 0;
  private totalCpuMillicores = 0;

  constructor(cfg: ResourcePoolConfig, log: (message: string) => void) {
    this.cfg = cfg;
    this.log = log;
    const base = path.resolve(cfg.base_path);
    const [slice, pool] = cfg.pool_id.split("/");
    this.poolDir = path.join(base, slice, pool);
    this.platformDir = path.join(base, slice, "platform.slice");
    this.available = this.detect();
  }

  get ready(): boolean {
    return this.available && this.initialized;
  }

  private detect(): boolean {
    if (!this.cfg.enabled) return false;
    try {
      if (!fs.existsSync(path.join(this.cfg.base_path, "cgroup.controllers"))) return false;
      fs.accessSync(this.cfg.base_path, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Create the slice tree and apply pool-level limits once the host totals are known. */
  init(totalMemBytes: number, totalCpuMillicores: number): boolean {
    this.totalMemBytes = Math.max(1, Math.trunc(totalMemBytes));
    this.totalCpuMillicores = Math.max(1, Math.trunc(totalCpuMillicores));
    if (!this.available) {
      this.log("cgroup v2 unavailable: dynamic scheduling degrades to capacity accounting without enforced quotas");
      return false;
    }
    try {
      const base = path.resolve(this.cfg.base_path);
      const [slice] = this.cfg.pool_id.split("/");
      const sliceDir = path.join(base, slice);
      ensureDir(sliceDir);
      ensureDir(this.poolDir);
      ensureDir(this.platformDir);
      // Enable the controllers we use on the parent slice; the root already has them delegated.
      for (const [dir, controllers] of [
        [base, "+memory +cpu +pids"],
        [sliceDir, "+memory +cpu +pids"],
      ] as const) {
        try {
          write(path.join(dir, "cgroup.subtree_control"), controllers);
        } catch {
          // Some controllers may be absent; the pool still works with the ones that attached.
        }
      }
      const memMax =
        this.cfg.pool_memory_max_bytes > 0
          ? Math.min(this.cfg.pool_memory_max_bytes, this.totalMemBytes)
          : this.totalMemBytes;
      write(path.join(this.poolDir, "memory.max"), String(memMax));
      write(path.join(this.poolDir, "memory.oom.group"), "0");
      write(path.join(this.poolDir, "pids.max"), "8192");
      const quota = Math.max(1, Math.round((this.totalCpuMillicores * this.cfg.cpu_period_us) / 1000));
      write(path.join(this.poolDir, "cpu.max"), `${quota} ${this.cfg.cpu_period_us}`);
      // Protect platform processes from builder memory pressure.
      const platformMin = Math.max(
        0,
        Math.min(this.cfg.platform_memory_min_bytes, Math.floor(this.totalMemBytes * 0.5)),
      );
      if (platformMin > 0) write(path.join(this.platformDir, "memory.min"), String(platformMin));
      this.initialized = true;
      this.log(`cgroup v2 ready: ${this.poolDir} (capacity ${this.totalCpuMillicores}mCPU / ${Math.round(memMax / MIB)}MiB)`);
      return true;
    } catch (e) {
      this.log(`cgroup init failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  scopeDir(instanceId: string): string {
    return path.join(this.poolDir, scopeName(instanceId));
  }

  /** Create the builder scope; returns its path or null when the pool is not writable. */
  ensureScope(instanceId: string): string | null {
    if (!this.ready) return null;
    const dir = this.scopeDir(instanceId);
    try {
      ensureDir(dir);
      write(path.join(dir, "memory.oom.group"), "1");
      return dir;
    } catch (e) {
      this.log(`Failed to create cgroup ${scopeName(instanceId)}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * cap -> `cpu.max` / `memory.max` (hard ceiling), grant -> `memory.low` / `cpu.weight`.
   * When the scheduler omits the cap (older grant rows), the grant doubles as the ceiling so the
   * instance is never allowed to exceed what the scheduler planned for it.
   */
  applyGrant(grant: {
    instance_id: string;
    generation: number;
    cpu_millicores: number;
    memory_bytes: number;
    memory_low_bytes: number;
    memory_high_bytes: number;
    cpu_weight: number;
    cap_cpu_millicores?: number;
    cap_memory_bytes?: number;
  }): AppliedGrant {
    const dir = this.ensureScope(grant.instance_id);
    if (!dir) {
      return {
        instance_id: grant.instance_id,
        scope: scopeName(grant.instance_id),
        generation: grant.generation,
        cpu_millicores: 0,
        memory_bytes: 0,
        memory_low_bytes: 0,
        memory_high_bytes: 0,
        cpu_weight: 1,
        applied: false,
        error: "cgroup pool unavailable",
      };
    }
    try {
      const capMem = Math.max(16 * MIB, Math.trunc(grant.cap_memory_bytes || grant.memory_bytes));
      // grant <= cap; low must never exceed max or the kernel rejects the write.
      const low = Math.max(0, Math.min(Math.trunc(grant.memory_low_bytes), capMem));
      const high = Math.max(low, Math.min(Math.trunc(grant.memory_high_bytes || capMem), capMem));
      write(path.join(dir, "memory.max"), String(capMem));
      write(path.join(dir, "memory.low"), String(low));
      write(path.join(dir, "memory.high"), String(high));
      const capCpu = Math.max(0, Math.trunc(grant.cap_cpu_millicores || grant.cpu_millicores));
      if (capCpu > 0) {
        const quota = Math.max(1, Math.round((capCpu * this.cfg.cpu_period_us) / 1000));
        write(path.join(dir, "cpu.max"), `${quota} ${this.cfg.cpu_period_us}`);
      } else {
        write(path.join(dir, "cpu.max"), "max");
      }
      const weight = Math.max(1, Math.min(10000, Math.trunc(grant.cpu_weight) || 1));
      write(path.join(dir, "cpu.weight"), String(weight));
      return {
        instance_id: grant.instance_id,
        scope: scopeName(grant.instance_id),
        generation: grant.generation,
        cpu_millicores: capCpu,
        memory_bytes: capMem,
        memory_low_bytes: low,
        memory_high_bytes: high,
        cpu_weight: weight,
        applied: true,
      };
    } catch (e) {
      return {
        instance_id: grant.instance_id,
        scope: scopeName(grant.instance_id),
        generation: grant.generation,
        cpu_millicores: 0,
        memory_bytes: 0,
        memory_low_bytes: 0,
        memory_high_bytes: 0,
        cpu_weight: 1,
        applied: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Remove a builder scope after its container is gone. Best effort: the pool reaps it on the next boot too. */
  removeScope(instanceId: string): void {
    if (!this.ready) return;
    try {
      fs.rmdirSync(this.scopeDir(instanceId));
    } catch {
      // Non-empty or already gone; nothing to do.
    }
    this.cpuSamples.delete(instanceId);
  }

  private cpuMillicores(instanceId: string, usageUsec: number): number {
    const now = Date.now();
    const prev = this.cpuSamples.get(instanceId);
    this.cpuSamples.set(instanceId, { usageUsec, at: now });
    if (!prev) return 0;
    const elapsedMs = Math.max(1, now - prev.at);
    const usedUsec = usageUsec - prev.usageUsec;
    return Math.max(0, Math.round((usedUsec / 1000 / elapsedMs) * 1000));
  }

  private poolCpuMillicores(usageUsec: number): number {
    const now = Date.now();
    const prev = this.poolCpuSample;
    this.poolCpuSample = { usageUsec, at: now };
    if (!prev) return 0;
    const elapsedMs = Math.max(1, now - prev.at);
    return Math.max(0, Math.round(((usageUsec - prev.usageUsec) / 1000 / elapsedMs) * 1000));
  }

  private readApplied(dir: string): {
    generation: number | null;
    cpu: number | null;
    mem: number | null;
    low: number | null;
    high: number | null;
    weight: number | null;
  } {
    const file = read(path.join(dir, "osacp.applied.json"));
    if (!file) return { generation: null, cpu: null, mem: null, low: null, high: null, weight: null };
    try {
      const raw = JSON.parse(file) as Record<string, unknown>;
      const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      return {
        generation: num(raw.generation),
        cpu: num(raw.cpu_millicores),
        mem: num(raw.memory_bytes),
        low: num(raw.memory_low_bytes),
        high: num(raw.memory_high_bytes),
        weight: num(raw.cpu_weight),
      };
    } catch {
      return { generation: null, cpu: null, mem: null, low: null, high: null, weight: null };
    }
  }

  /**
   * Persist what was applied next to the scope, so a daemon restart reports the same generation
   * instead of leaving the scheduler's APPLIED gate closed forever.
   */
  recordApplied(applied: AppliedGrant): void {
    try {
      const dir = this.scopeDir(applied.instance_id);
      fs.writeFileSync(
        path.join(dir, "osacp.applied.json"),
        JSON.stringify({
          generation: applied.generation,
          cpu_millicores: applied.cpu_millicores,
          memory_bytes: applied.memory_bytes,
          memory_low_bytes: applied.memory_low_bytes,
          memory_high_bytes: applied.memory_high_bytes,
          cpu_weight: applied.cpu_weight,
          applied_at: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
    } catch {
      // Readback still reports the kernel values; the generation is advisory.
    }
  }

  snapshot(): PoolSnapshot {
    const reportedAt = new Date().toISOString();
    if (!this.ready) {
      return {
        pool_id: this.cfg.pool_id,
        cgroup_available: false,
        cgroup_driver: "none",
        cpu_total_millicores: this.totalCpuMillicores,
        mem_total_bytes: this.totalMemBytes,
        cpu_used_millicores: 0,
        mem_used_bytes: 0,
        mem_working_set_bytes: 0,
        psi: {},
        cgroup: {},
        reported_at: reportedAt,
        instances: [],
      };
    }
    const poolStat = memoryStat(this.poolDir);
    const poolCpu = cpuStat(this.poolDir);
    const instances: InstanceUsage[] = [];
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.poolDir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const instanceId = instanceIdFromScope(name);
      if (!instanceId) continue;
      const dir = path.join(this.poolDir, name);
      const stat = memoryStat(dir);
      const cpu = cpuStat(dir);
      const applied = this.readApplied(dir);
      const cpuMax = read(path.join(dir, "cpu.max")) ?? "";
      const quota = cpuMax.startsWith("max") ? 0 : Number(cpuMax.split(/\s+/)[0]) || 0;
      const events = read(path.join(dir, "memory.events")) ?? "";
      let oom = 0;
      for (const line of events.split("\n")) {
        const [key, value] = line.trim().split(/\s+/);
        if (key === "oom_kill") oom = Number(value) || 0;
      }
      instances.push({
        instance_id: instanceId,
        cpu_millicores: this.cpuMillicores(instanceId, cpu.usageUsec),
        mem_bytes: stat.current,
        working_set_bytes: stat.workingSet,
        memory_max_bytes: readNumber(path.join(dir, "memory.max")) ?? 0,
        memory_low_bytes: readNumber(path.join(dir, "memory.low")) ?? 0,
        memory_high_bytes: readNumber(path.join(dir, "memory.high")) ?? 0,
        cpu_max_quota: quota,
        cpu_weight: readNumber(path.join(dir, "cpu.weight")) ?? 0,
        oom_events: oom,
        applied_generation: applied.generation,
        applied_cpu_millicores: applied.cpu,
        applied_memory_bytes: applied.mem,
        applied_memory_low_bytes: applied.low,
        applied_memory_high_bytes: applied.high,
        applied_cpu_weight: applied.weight,
      });
    }
    return {
      pool_id: this.cfg.pool_id,
      cgroup_available: true,
      cgroup_driver: "cgroup2",
      cpu_total_millicores: this.totalCpuMillicores,
      mem_total_bytes: this.totalMemBytes,
      cpu_used_millicores: this.poolCpuMillicores(poolCpu.usageUsec),
      mem_used_bytes: poolStat.current,
      mem_working_set_bytes: poolStat.workingSet,
      psi: {
        cpu: pressureOf(path.join(this.poolDir, "cpu.pressure")) ?? {},
        memory: pressureOf(path.join(this.poolDir, "memory.pressure")) ?? {},
      },
      cgroup: {
        memory_max: read(path.join(this.poolDir, "memory.max")),
        cpu_max: read(path.join(this.poolDir, "cpu.max")),
        pids_max: read(path.join(this.poolDir, "pids.max")),
        pids_current: readNumber(path.join(this.poolDir, "pids.current")),
        platform_memory_min: read(path.join(this.platformDir, "memory.min")),
      },
      reported_at: reportedAt,
      instances,
    };
  }
}
