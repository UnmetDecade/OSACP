/**
 * 工作能力值 W（0–1000）。
 *
 * 六项按权重归一化后求和：
 *   核心数 30% · 核心频率 15% · 内存 20% · 存储 10% · 模型能力 15% · API 能力 10%
 *
 * 归一化上限代表“单机当前一代的满配”：8 核 / 4.0GHz / 32GB / 256GB / 10 / 10。
 * 超过上限按满分计，避免一台怪兽机器把分值拉到无意义的量级。
 */
export interface CapabilityDetail {
  cores?: number;
  freq_ghz?: number;
  mem_gb?: number;
  disk_gb?: number;
  /** 0–10，由模型档位/上下文/推理能力折算 */
  model?: number;
  /** 0–10，由 API 配额/并发/可用性折算 */
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

/** 任务难度：0 表示不限制；其余按 0–1000 截断。 */
export function normalizeDifficulty(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1000, Math.round(n));
}
