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
  /** Native instances have no container; the Reconciler generates a running record of the same shape. */
  deployments?: Array<Record<string, unknown>>;
  /** cgroup v2 pool snapshot; absent or unavailable leaves dynamic scheduling unenforced. */
  pool?: Record<string, unknown>;
}

/** Corresponds to host-runtime-spec §6.4. Only containers whose labels carry platform.* are reported. */
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
      ...(input.pool ? { pool: input.pool } : {}),
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
