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
  /** Seconds since the last successful contact with PCS */
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
 * Per-host state machine: NORMAL → WARNING → THROTTLED → PROTECTING → RECOVERING → NORMAL.
 * Escalation must persist for the threshold duration; de-escalation must first hold steady for recover_seconds, then pass recovering_seconds of observation.
 * Losing PCS for more than pcs_lost_seconds goes straight to PROTECTING (the host can still protect itself when the control plane is stuck).
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

  // Escalation: treat RECOVERING as 0, but any warning must go through the escalation check again
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

  // PROTECTING caused by PCS loss is not a local resource problem: once contact is restored and metrics are normal,
  // return straight to NORMAL without waiting for the 5-minute recovery window.
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

  // Enter RECOVERING before dropping to NORMAL, and observe for a while
  if (current === "RECOVERING") {
    if (target >= 1) {
      // Already handled by the escalation branch above (target > 0 == level 0)
      // Only target === 0 is handled here
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
