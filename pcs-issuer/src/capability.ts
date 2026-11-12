/**
 * 工作能力值 W（0–1000），与调度机 scheduler/src/capability.ts 同一套公式。
 *
 * PCS 在创建构建机时计算并冻结到部署记录里；部署计划把 W 注入容器环境变量，
 * 构建机启动注册时原样上报给调度机。两边公式必须保持一致，否则会出现
 * “界面显示的 W”和“调度机实际用于过滤的 W”不一致。
 */
export interface CapabilityDetail {
  cores?: number;
  freq_ghz?: number;
  mem_gb?: number;
  disk_gb?: number;
  model?: number;
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

export function normalizeCapabilityDetail(detail: unknown): CapabilityDetail {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return {};
  const d = detail as Record<string, unknown>;
  const out: CapabilityDetail = {};
  for (const key of Object.keys(CAPABILITY_WEIGHTS) as (keyof CapabilityDetail)[]) {
    const n = Number(d[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
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

export function resolveCapability(input: {
  capability_score?: unknown;
  capability_detail?: unknown;
}): { score: number; detail: CapabilityDetail } {
  const detail =
    input.capability_detail === undefined || input.capability_detail === null
      ? {}
      : normalizeCapabilityDetail(input.capability_detail);
  const hasDetail = Object.keys(detail).length > 0;
  if (input.capability_score !== undefined && input.capability_score !== null) {
    const n = Number(input.capability_score);
    return {
      score: Number.isFinite(n) ? Math.max(0, Math.min(1000, Math.round(n))) : 0,
      detail,
    };
  }
  return { score: hasDetail ? computeCapabilityScore(detail) : 0, detail };
}
