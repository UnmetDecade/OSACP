import type { ContainerInfo, EngineAdapter } from "../src/docker-engine.js";
import { DockerError } from "../src/docker-engine.js";

interface FakeContainer extends ContainerInfo {
  config?: Record<string, any>;
}

/** Implements only the fixed container endpoints; enough behavior to verify the reconciler's convergence to the desired state. */
export class FakeEngine implements EngineAdapter {
  containers = new Map<string, FakeContainer>();
  images = new Set<string>();
  networks = new Set<string>();
  archives = new Map<string, Buffer>();
  calls: string[] = [];
  private seq = 0;

  async ping(): Promise<void> {
    this.calls.push("ping");
  }

  async version(): Promise<{ version: string; api_version: string }> {
    return { version: "fake-27.0", api_version: "1.47" };
  }

  async inspect(nameOrId: string): Promise<ContainerInfo | null> {
    const c = this.find(nameOrId);
    return c ? { ...c } : null;
  }

  private find(nameOrId: string): FakeContainer | undefined {
    if (this.containers.has(nameOrId)) return this.containers.get(nameOrId);
    return [...this.containers.values()].find((c) => c.id === nameOrId);
  }

  async listManaged(): Promise<ContainerInfo[]> {
    return [...this.containers.values()]
      .filter((c) => c.labels["platform.managed"] === "true")
      .map((c) => ({ ...c }));
  }

  async create(name: string, config: Record<string, unknown>): Promise<string> {
    this.calls.push(`create:${name}`);
    if (this.containers.has(name)) throw new DockerError(409, "DOCKER_CREATE_FAILED", "conflict");
    const image = String(config.Image);
    if (!this.images.has(image)) {
      throw new DockerError(404, "DOCKER_CREATE_FAILED", "No such image");
    }
    const id = `fake-${++this.seq}`;
    this.containers.set(name, {
      id,
      name,
      image,
      image_id: image.slice(image.indexOf("@") + 1),
      state: "created",
      health: "none",
      started_at: null,
      restart_count: 0,
      labels: (config.Labels ?? {}) as Record<string, string>,
      config,
    });
    return id;
  }

  async start(nameOrId: string): Promise<void> {
    this.calls.push(`start:${nameOrId}`);
    const c = this.find(nameOrId);
    if (!c) throw new DockerError(404, "DOCKER_START_FAILED", "not found");
    c.state = "running";
    c.started_at = new Date().toISOString();
  }

  async stop(nameOrId: string, _timeoutSeconds: number): Promise<void> {
    this.calls.push(`stop:${nameOrId}`);
    const c = this.find(nameOrId);
    if (!c) throw new DockerError(404, "DOCKER_STOP_FAILED", "not found");
    c.state = "exited";
  }

  async restart(nameOrId: string, _timeoutSeconds: number): Promise<void> {
    this.calls.push(`restart:${nameOrId}`);
    const c = this.find(nameOrId);
    if (!c) throw new DockerError(404, "DOCKER_RESTART_FAILED", "not found");
    c.state = "running";
    c.restart_count += 1;
  }

  async remove(nameOrId: string, _removeVolumes: boolean): Promise<void> {
    this.calls.push(`remove:${nameOrId}`);
    const c = this.find(nameOrId);
    if (c) this.containers.delete(c.name);
  }

  async removeVolume(name: string): Promise<void> {
    this.calls.push(`removeVolume:${name}`);
  }

  async pull(image: string): Promise<void> {
    this.calls.push(`pull:${image}`);
    this.images.add(image);
  }

  async inspectImage(image: string): Promise<{ id: string; repo_digests: string[] } | null> {
    if (!this.images.has(image)) return null;
    return { id: image.slice(image.indexOf("@") + 1), repo_digests: [image] };
  }

  async ensureNetwork(name: string): Promise<void> {
    this.calls.push(`network:${name}`);
    this.networks.add(name);
  }

  async putArchive(nameOrId: string, targetDir: string, tar: Buffer): Promise<void> {
    this.calls.push(`archive:${nameOrId}:${targetDir}`);
    const c = this.find(nameOrId);
    if (!c) throw new DockerError(404, "DOCKER_ARCHIVE_FAILED", "not found");
    this.archives.set(c.name, tar);
  }

  simulateExit(name: string): void {
    const c = this.find(name);
    if (c) c.state = "exited";
  }

  configOf(name: string): Record<string, any> | undefined {
    return this.find(name)?.config;
  }
}
