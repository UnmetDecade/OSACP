/**
 * Capability score W (0–1000).
 *
 * Six items are normalized by weight and summed:
 *   cores 30% · core frequency 15% · memory 20% · storage 10% · model capability 15% · API capability 10%
 *
 * Normalization caps represent "a fully loaded current-generation single machine": 8 cores / 4.0GHz / 32GB / 256GB / 10 / 10.
 * Anything above a cap scores full marks, so one monster machine cannot push the score to a meaningless scale.
 */
export interface CapabilityDetail {
  cores?: number;
  freq_ghz?: number;
  mem_gb?: number;
  disk_gb?: number;
  /** 0–10, derived from model tier/context/reasoning capability */
  model?: number;
  /** 0–10, derived from API quota/concurrency/availability */
  api?: number;
}

export const CAPABILITY_WEIGHTS = {
  cores: 0.3,
  freq_ghz: 0.15,
  mem_gb: 0.2,
  disk_gb: 0.1,
  model: 0.15,
  api: 0.1,
} as const;

export const CAPABILITY_CEILINGS = {
  cores: 8,
  freq_ghz: 4,
  mem_gb: 32,
  disk_gb: 256,
  model: 10,
  api: 10,
} as const;

function ratio(value: unknown, ceiling: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n / ceiling, 1);
}

export function computeCapabilityScore(detail: CapabilityDetail | null | undefined): number {
  if (!detail) return 0;
  const raw =
    CAPABILITY_WEIGHTS.cores * ratio(detail.cores, CAPABILITY_CEILINGS.cores) +
    CAPABILITY_WEIGHTS.freq_ghz * ratio(detail.freq_ghz, CAPABILITY_CEILINGS.freq_ghz) +
    CAPABILITY_WEIGHTS.mem_gb * ratio(detail.mem_gb, CAPABILITY_CEILINGS.mem_gb) +
    CAPABILITY_WEIGHTS.disk_gb * ratio(detail.disk_gb, CAPABILITY_CEILINGS.disk_gb) +
    CAPABILITY_WEIGHTS.model * ratio(detail.model, CAPABILITY_CEILINGS.model) +
    CAPABILITY_WEIGHTS.api * ratio(detail.api, CAPABILITY_CEILINGS.api);
  return Math.max(0, Math.min(1000, Math.round(raw * 1000)));
}

/**
 * Dynamic-mode capability split (v0.3 §6.2).
 *
 * `static_score` covers the four load-independent components (frequency/disk/model/API),
 * `res_score` covers CPU and memory and is the only part that scales with H_res.
 * The two parts each have a 500-point maximum, so `static + res` is bounded by 1000.
 */
export interface CapabilitySplit {
  static_score: number;
  res_score: number;
  /** W0 = static + res at the instance cap: the cross-mode eligibility ceiling. */
  ceiling: number;
}

export function splitCapability(
  detail: CapabilityDetail | null | undefined,
  cap?: { cpu_cores?: number; mem_gb?: number },
): CapabilitySplit {
  const d = normalizeCapabilityDetail(detail ?? {});
  const staticRaw =
    CAPABILITY_WEIGHTS.freq_ghz * ratio(d.freq_ghz, CAPABILITY_CEILINGS.freq_ghz) +
    CAPABILITY_WEIGHTS.disk_gb * ratio(d.disk_gb, CAPABILITY_CEILINGS.disk_gb) +
    CAPABILITY_WEIGHTS.model * ratio(d.model, CAPABILITY_CEILINGS.model) +
    CAPABILITY_WEIGHTS.api * ratio(d.api, CAPABILITY_CEILINGS.api);
  const cores = cap?.cpu_cores ?? d.cores ?? 0;
  const memGb = cap?.mem_gb ?? d.mem_gb ?? 0;
  const resRaw =
    CAPABILITY_WEIGHTS.cores * ratio(cores, CAPABILITY_CEILINGS.cores) +
    CAPABILITY_WEIGHTS.mem_gb * ratio(memGb, CAPABILITY_CEILINGS.mem_gb);
  const staticScore = Math.max(0, Math.min(500, Math.round(staticRaw * 1000)));
  const resScore = Math.max(0, Math.min(500, Math.round(resRaw * 1000)));
  return { static_score: staticScore, res_score: resScore, ceiling: staticScore + resScore };
}

export type WDegradeScope = "resource" | "whole";

/**
 * W_live from a split and the pool-level H_res. `resource` scales only the CPU/memory part;
 * `whole` scales the whole score and applies W_floor. H_res is already clamped by the caller.
 */
export function dynamicLiveScore(
  split: CapabilitySplit,
  hRes: number,
  opts: { scope?: WDegradeScope; wFloor?: number } = {},
): number {
  const h = Number.isFinite(hRes) ? Math.max(0, Math.min(1, hRes)) : 1;
  if ((opts.scope ?? "resource") === "whole") {
    const floor = Math.max(0, Math.min(1000, Number(opts.wFloor ?? 0)));
    return Math.max(floor, Math.round(split.ceiling * h));
  }
  return Math.max(0, Math.min(1000, Math.round(split.static_score + h * split.res_score)));
}

/** Optional capacity-planning value: score at the instance's equal-share minimum. */
export function dynamicGuaranteedScore(
  split: CapabilitySplit,
  minShare: { cpu_cores: number; mem_gb: number },
): number {
  const res =
    CAPABILITY_WEIGHTS.cores * ratio(minShare.cpu_cores, CAPABILITY_CEILINGS.cores) +
    CAPABILITY_WEIGHTS.mem_gb * ratio(minShare.mem_gb, CAPABILITY_CEILINGS.mem_gb);
  return Math.max(0, Math.min(1000, Math.round(split.static_score + res * 1000)));
}

export function normalizeCapabilityDetail(detail: unknown): CapabilityDetail {
  if (!detail || typeof detail !== "object") return {};
  const d = detail as Record<string, unknown>;
  const out: CapabilityDetail = {};
  for (const key of Object.keys(CAPABILITY_WEIGHTS) as (keyof CapabilityDetail)[]) {
    const n = Number(d[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

/** Task difficulty: 0 means unrestricted; anything else is clamped to 0–1000. */
export function normalizeDifficulty(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1000, Math.round(n));
}
