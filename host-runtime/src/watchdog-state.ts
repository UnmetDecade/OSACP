import type { WatchdogConfig, WatchdogThresholds } from "./runtime-config.js";

export type HostState = "NORMAL" | "WARNING" | "THROTTLED" | "PROTECTING" | "RECOVERING";

export interface WatchdogSample {
  mem_total_bytes: number;
  mem_available_bytes: number;
  load1: number;
  cpu_count: number;
  disk_total_bytes: number;
  disk_free_bytes: number;
  pcs_reachable: boolean;
  /** 距上一次成功联系 PCS 的秒数 */
  pcs_silence_seconds: number;
}

export interface WatchdogStateFile {
  state: HostState;
  since: string;
  reason: string;
  updated_at: string;
  pending?: { level: 1 | 2 | 3; since: string } | null;
  below_since?: string | null;
  sample: WatchdogSample;
}

const LEVEL: Record<HostState, 0 | 1 | 2 | 3> = {
  NORMAL: 0,
  RECOVERING: 0,
  WARNING: 1,
  THROTTLED: 2,
  PROTECTING: 3,
};

const NAME: Record<1 | 2 | 3, HostState> = {
  1: "WARNING",
  2: "THROTTLED",
  3: "PROTECTING",
};

export function thresholdReason(sample: WatchdogSample, t: WatchdogThresholds): string[] {
  const out: string[] = [];
  const memRatio = sample.mem_total_bytes > 0 ? sample.mem_available_bytes / sample.mem_total_bytes : 1;
  const loadPerCpu = sample.cpu_count > 0 ? sample.load1 / sample.cpu_count : 0;
  const diskRatio = sample.disk_total_bytes > 0 ? sample.disk_free_bytes / sample.disk_total_bytes : 1;
  if (t.mem_available_ratio_below !== undefined && memRatio < t.mem_available_ratio_below) {
    out.push(`MEM_AVAILABLE_RATIO ${memRatio.toFixed(3)} < ${t.mem_available_ratio_below}`);
  }
  if (t.load1_per_cpu_above !== undefined && loadPerCpu > t.load1_per_cpu_above) {
    out.push(`LOAD1_PER_CPU ${loadPerCpu.toFixed(2)} > ${t.load1_per_cpu_above}`);
  }
  if (t.disk_free_ratio_below !== undefined && diskRatio < t.disk_free_ratio_below) {
    out.push(`DISK_FREE_RATIO ${diskRatio.toFixed(3)} < ${t.disk_free_ratio_below}`);
  }
  return out;
}

function sampleLevel(sample: WatchdogSample, cfg: WatchdogConfig): { level: 0 | 1 | 2 | 3; reasons: string[] } {
  const p = thresholdReason(sample, cfg.protecting);
  if (p.length) return { level: 3, reasons: p };
  const t = thresholdReason(sample, cfg.throttled);
  if (t.length) return { level: 2, reasons: t };
  const w = thresholdReason(sample, cfg.warning);
  if (w.length) return { level: 1, reasons: w };
  return { level: 0, reasons: [] };
}

/**
 * 每台 host 独立的状态机：NORMAL → WARNING → THROTTLED → PROTECTING → RECOVERING → NORMAL。
 * 升级要持续到阈值时间；降级必须先稳定 recover_seconds，再经过 recovering_seconds 观察。
 * PCS 失联超过 pcs_lost_seconds 直接 PROTECTING（控制面卡死时本机仍能自保）。
 */
export function nextWatchdogState(
  prev: WatchdogStateFile | null,
  sample: WatchdogSample,
  nowMs: number,
  cfg: WatchdogConfig,
): WatchdogStateFile {
  const nowIso = new Date(nowMs).toISOString();
  const current = prev?.state ?? "NORMAL";
  const since = prev?.since ?? nowIso;
  const computed = sampleLevel(sample, cfg);
  let target = computed.level;
  let reasons = computed.reasons;

  const pcsLost =
    !sample.pcs_reachable ||
    sample.pcs_silence_seconds > cfg.pcs_lost_seconds;
  if (pcsLost) {
    target = 3;
    reasons = [...reasons, `PCS_LOST ${sample.pcs_silence_seconds.toFixed(0)}s`];
  }

  const level = LEVEL[current];

  // 升级：RECOVERING 视作 0，但任何告警都要重新走升级判定
  if (target > level && target !== 0) {
    const pending =
      prev?.pending && prev.pending.level === target
        ? prev.pending
        : { level: target, since: nowIso };
    const sustain = cfg.sustain_seconds[NAME[target].toLowerCase() as "warning" | "throttled" | "protecting"];
    if (nowMs - Date.parse(pending.since) >= sustain * 1000) {
      return {
        state: NAME[target],
        since: nowIso,
        reason: reasons.join("; ") || "THRESHOLD",
        updated_at: nowIso,
        pending: null,
        below_since: null,
        sample,
      };
    }
    return {
      state: current,
      since,
      reason: prev?.reason ?? "OK",
      updated_at: nowIso,
      pending,
      below_since: prev?.below_since ?? null,
      sample,
    };
  }

  // PCS 失联导致的 PROTECTING 不是本机资源问题：一旦重新联系上且指标正常，
  // 直接回到 NORMAL，不必再等 5 分钟的恢复窗口。
  const wasPcsLost = (prev?.reason ?? "").includes("PCS_LOST");
  if (current === "PROTECTING" && wasPcsLost && target === 0) {
    return {
      state: "NORMAL",
      since: nowIso,
      reason: "PCS_BACK",
      updated_at: nowIso,
      pending: null,
      below_since: null,
      sample,
    };
  }

  // 降到 NORMAL 之前先进入 RECOVERING，观察一段时间
  if (current === "RECOVERING") {
    if (target >= 1) {
      // 已被上面的升级分支处理（target > 0 == level 0）
      // 这里只处理 target === 0
    }
    if (target === 0) {
      if (nowMs - Date.parse(since) >= cfg.recovering_seconds * 1000) {
        return {
          state: "NORMAL",
          since: nowIso,
          reason: "OK",
          updated_at: nowIso,
          pending: null,
          below_since: null,
          sample,
        };
      }
      return {
        state: "RECOVERING",
        since,
        reason: "RECOVERING",
        updated_at: nowIso,
        pending: null,
        below_since: null,
        sample,
      };
    }
  }

  if (target === 0 && LEVEL[current] > 0) {
    const belowSince = prev?.below_since ?? nowIso;
    if (nowMs - Date.parse(belowSince) >= cfg.recover_seconds * 1000) {
      return {
        state: "RECOVERING",
        since: nowIso,
        reason: "METRICS_RECOVERED",
        updated_at: nowIso,
        pending: null,
        below_since: null,
        sample,
      };
    }
    return {
      state: current,
      since,
      reason: prev?.reason ?? "OK",
      updated_at: nowIso,
      pending: null,
      below_since: belowSince,
      sample,
    };
  }

  return {
    state: current,
    since,
    reason: LEVEL[current] === 0 ? "OK" : prev?.reason ?? "THRESHOLD",
    updated_at: nowIso,
    pending: null,
    below_since: target === 0 ? nowIso : null,
    sample,
  };
}

export function watchdogFresh(state: WatchdogStateFile | null, nowMs: number, sampleSeconds: number): boolean {
  if (!state) return false;
  return nowMs - Date.parse(state.updated_at) <= Math.max(15_000, sampleSeconds * 3000);
}

export type ContainerAction = "DEPLOY" | "START" | "RESTART";

export function containerAdmission(
  state: WatchdogStateFile | null,
  nowMs: number,
  sampleSeconds: number,
  action: ContainerAction,
): { allowed: boolean; reason?: string } {
  if (!watchdogFresh(state, nowMs, sampleSeconds) || !state) {
    return { allowed: false, reason: "WATCHDOG_UNAVAILABLE" };
  }
  if (state.state === "PROTECTING") {
    return { allowed: false, reason: "HOST_PROTECTING" };
  }
  if (state.state === "THROTTLED" && action === "DEPLOY") {
    return { allowed: false, reason: "HOST_THROTTLED" };
  }
  return { allowed: true };
}
