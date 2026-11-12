import fs from "node:fs";
import path from "node:path";
import type { InstanceSpec } from "./command-verify.js";

export type LocalDesiredState = "RUNNING" | "STOPPED" | "REMOVED";

export interface LocalDeployment {
  deployment_id: string;
  instance_id: string;
  host_id: string;
  grant_id: string;
  generation: number;
  spec: InstanceSpec;
  desired_state: LocalDesiredState;
  updated_at: string;
}

export interface ProcessedCommand {
  ok: boolean;
  result: Record<string, unknown>;
  at: string;
}

export interface RuntimeStateData {
  applied_generations: Record<string, number>;
  processed_commands: Record<string, ProcessedCommand>;
  deployments: Record<string, LocalDeployment>;
}

const EMPTY: RuntimeStateData = {
  applied_generations: {},
  processed_commands: {},
  deployments: {},
};

function atomicWrite(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 本机实际态的持久化：Runtime 重启后从这里恢复 desired state，容器继续运行。 */
export class RuntimeState {
  private data: RuntimeStateData;
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "runtime-state.json");
    this.data = this.load();
  }

  private load(): RuntimeStateData {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<RuntimeStateData>;
      return {
        applied_generations: raw.applied_generations ?? {},
        processed_commands: raw.processed_commands ?? {},
        deployments: raw.deployments ?? {},
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.file, backup);
          console.error(`[state] 状态文件损坏，已移到 ${backup}，以空状态启动`);
        } catch {
          console.error("[state] 状态文件损坏且无法备份", e);
        }
      }
      return structuredClone(EMPTY);
    }
  }

  save(): void {
    atomicWrite(this.file, this.data);
  }

  appliedGeneration(instanceId: string): number | undefined {
    return this.data.applied_generations[instanceId];
  }

  markApplied(instanceId: string, generation: number): void {
    this.data.applied_generations[instanceId] = generation;
  }

  processed(commandId: string): ProcessedCommand | undefined {
    return this.data.processed_commands[commandId];
  }

  recordProcessed(commandId: string, ok: boolean, result: Record<string, unknown>): void {
    this.data.processed_commands[commandId] = {
      ok,
      result,
      at: new Date().toISOString(),
    };
    const entries = Object.entries(this.data.processed_commands);
    if (entries.length > 500) {
      entries
        .sort((a, b) => a[1].at.localeCompare(b[1].at))
        .slice(0, entries.length - 500)
        .forEach(([id]) => delete this.data.processed_commands[id]);
    }
  }

  deployment(deploymentId: string): LocalDeployment | undefined {
    return this.data.deployments[deploymentId];
  }

  listDeployments(): LocalDeployment[] {
    return Object.values(this.data.deployments);
  }

  upsertDeployment(input: {
    deployment_id: string;
    host_id: string;
    grant_id: string;
    generation: number;
    spec: InstanceSpec;
    desired_state?: LocalDesiredState;
  }): LocalDeployment {
    const prev = this.data.deployments[input.deployment_id];
    const dep: LocalDeployment = {
      deployment_id: input.deployment_id,
      instance_id: input.spec.instance_id,
      host_id: input.host_id,
      grant_id: input.grant_id,
      generation: input.generation,
      spec: input.spec,
      desired_state: input.desired_state ?? prev?.desired_state ?? "RUNNING",
      updated_at: new Date().toISOString(),
    };
    this.data.deployments[input.deployment_id] = dep;
    return dep;
  }

  setDesired(deploymentId: string, desired: LocalDesiredState, generation?: number): void {
    const dep = this.data.deployments[deploymentId];
    if (!dep) return;
    dep.desired_state = desired;
    if (generation) dep.generation = generation;
    dep.updated_at = new Date().toISOString();
  }

  removeDeployment(deploymentId: string): void {
    delete this.data.deployments[deploymentId];
  }
}
