import type { EngineAdapter } from "./docker-engine.js";
import type { HostSample } from "./metrics.js";
import type { HostState } from "./watchdog-state.js";

export interface ReportInput {
  hostId: string;
  runtimeVersion: string;
  containerRuntime: string;
  engine: EngineAdapter;
  sample: HostSample;
  hostState: HostState | "UNKNOWN";
  engineHealthy: boolean;
  /** 裸机实例没有容器，由 Reconciler 生成同样形状的 running 记录。 */
  deployments?: Array<Record<string, unknown>>;
}

/** 对应 host-runtime-spec §6.4。容器只上报标签里带 platform.* 的那些。 */
export async function buildReport(input: ReportInput): Promise<Record<string, unknown>> {
  let containers: Awaited<ReturnType<EngineAdapter["listManaged"]>> = [];
  if (input.engineHealthy) {
    containers = await input.engine.listManaged();
  }

  return {
    host_id: input.hostId,
    runtime: {
      version: input.runtimeVersion,
      container_runtime: input.containerRuntime,
      healthy: input.engineHealthy,
      capabilities: {},
    },
    host_state: input.hostState,
    resources: {
      cpu_usage: input.sample.cpu_usage,
      load1: input.sample.load1,
      load5: input.sample.load5,
      load15: input.sample.load15,
      cpu_count: input.sample.cpu_count,
      mem_available_bytes: input.sample.mem_available_bytes,
      mem_total_bytes: input.sample.mem_total_bytes,
      swap_used_bytes: input.sample.swap_used_bytes,
      disk: input.sample.disk,
      pids_used: input.sample.pids_used,
    },
    containers: [
      ...containers.map((c) => ({
        instance_id: c.labels["platform.instance_id"] ?? null,
        deployment_id: c.labels["platform.deployment_id"] ?? null,
        container_id: c.id,
        state: c.state,
        health: c.health,
        image: c.image,
        image_digest: c.image_id,
        started_at: c.started_at,
        restart_count: c.restart_count,
      })),
      ...(input.deployments ?? []),
    ],
  };
}
