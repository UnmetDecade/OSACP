import type { CapabilityDetail } from "./types";

/**
 * 工作能力值 W（0–1000），与调度机 / PCS 同一套公式：
 *   核心 30% · 主频 15% · 内存 20% · 磁盘 10% · 模型 15% · API 10%
 * 上限代表“单机当前一代满配”，超过按满分计。
 */
const WEIGHTS = {
  cores: 0.3,
  freq_ghz: 0.15,
  mem_gb: 0.2,
  disk_gb: 0.1,
  model: 0.15,
  api: 0.1,
} as const;

const CEILINGS = {
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
    WEIGHTS.cores * ratio(detail.cores, CEILINGS.cores) +
    WEIGHTS.freq_ghz * ratio(detail.freq_ghz, CEILINGS.freq_ghz) +
    WEIGHTS.mem_gb * ratio(detail.mem_gb, CEILINGS.mem_gb) +
    WEIGHTS.disk_gb * ratio(detail.disk_gb, CEILINGS.disk_gb) +
    WEIGHTS.model * ratio(detail.model, CEILINGS.model) +
    WEIGHTS.api * ratio(detail.api, CEILINGS.api);
  return Math.max(0, Math.min(1000, Math.round(raw * 1000)));
}

/** 资源档位已经给了核数/内存/磁盘；主频与模型/API 能力由用户补，未填按 0 计。 */
export function capabilityFromResources(input: {
  cpus: number;
  mem_mb: number;
  disk_gb: number;
  freq_ghz?: number;
  model?: number;
  api?: number;
}): CapabilityDetail {
  return {
    cores: input.cpus,
    mem_gb: input.mem_mb / 1024,
    disk_gb: input.disk_gb,
    ...(Number.isFinite(input.freq_ghz) && Number(input.freq_ghz) > 0
      ? { freq_ghz: Number(input.freq_ghz) }
      : {}),
    ...(Number.isFinite(input.model) && Number(input.model) > 0
      ? { model: Number(input.model) }
      : {}),
    ...(Number.isFinite(input.api) && Number(input.api) > 0 ? { api: Number(input.api) } : {}),
  };
}
