import http from "node:http";

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  image_id: string;
  state: string;
  health: string;
  started_at: string | null;
  restart_count: number;
  labels: Record<string, string>;
}

export interface EngineAdapter {
  ping(): Promise<void>;
  version(): Promise<{ version: string; api_version: string }>;
  listManaged(): Promise<ContainerInfo[]>;
  inspect(nameOrId: string): Promise<ContainerInfo | null>;
  create(name: string, config: Record<string, unknown>): Promise<string>;
  start(nameOrId: string): Promise<void>;
  stop(nameOrId: string, timeoutSeconds: number): Promise<void>;
  restart(nameOrId: string, timeoutSeconds: number): Promise<void>;
  remove(nameOrId: string, removeVolumes: boolean): Promise<void>;
  removeVolume(name: string): Promise<void>;
  pull(image: string): Promise<void>;
  inspectImage(image: string): Promise<{ id: string; repo_digests: string[] } | null>;
  ensureNetwork(name: string): Promise<void>;
  /** 把配置文件写进容器文件系统（停止状态也可写），path=/ 表示容器根。 */
  putArchive(nameOrId: string, targetDir: string, tar: Buffer): Promise<void>;
}

export class DockerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DockerError";
  }
}

interface RawResponse {
  status: number;
  body: Buffer;
}

/** 只封装固定的容器生命周期端点；没有 exec / 任意 shell / 任意路径接口。 */
export class DockerEngine implements EngineAdapter {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 60_000,
  ) {}

  private request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<RawResponse> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return this.send(method, path, payload, payload ? "application/json" : undefined, timeoutMs);
  }

  private send(
    method: string,
    path: string,
    payload: Buffer | undefined,
    contentType: string | undefined,
    timeoutMs: number,
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            host: "docker",
            ...(payload
              ? { "content-type": contentType ?? "application/octet-stream", "content-length": String(payload.length) }
              : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error("docker request timeout"));
      });
      req.on("error", (e) => reject(new DockerError(0, "DOCKER_UNREACHABLE", e.message)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  private message(raw: RawResponse): string {
    try {
      const data = JSON.parse(raw.body.toString("utf8"));
      return String(data.message ?? data.error ?? raw.body.toString("utf8"));
    } catch {
      return raw.body.toString("utf8").slice(0, 500);
    }
  }

  async ping(): Promise<void> {
    const r = await this.request("GET", "/_ping", undefined, 3000);
    if (r.status !== 200) throw new DockerError(r.status, "DOCKER_PING_FAILED", this.message(r));
  }

  async version(): Promise<{ version: string; api_version: string }> {
    const r = await this.request("GET", "/version");
    if (r.status !== 200) throw new DockerError(r.status, "DOCKER_VERSION_FAILED", this.message(r));
    const data = JSON.parse(r.body.toString("utf8"));
    return { version: String(data.Version ?? "unknown"), api_version: String(data.ApiVersion ?? "unknown") };
  }

  async inspect(nameOrId: string): Promise<ContainerInfo | null> {
    const r = await this.request("GET", `/containers/${encodeURIComponent(nameOrId)}/json`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new DockerError(r.status, "DOCKER_INSPECT_FAILED", this.message(r));
    return mapInspect(JSON.parse(r.body.toString("utf8")));
  }

  async listManaged(): Promise<ContainerInfo[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: ["platform.managed=true"] }));
    const r = await this.request("GET", `/containers/json?all=1&filters=${filters}`);
    if (r.status !== 200) throw new DockerError(r.status, "DOCKER_LIST_FAILED", this.message(r));
    const rows = JSON.parse(r.body.toString("utf8")) as Array<Record<string, any>>;
    const out: ContainerInfo[] = [];
    for (const row of rows) {
      const id = String(row.Id);
      const detail = await this.inspect(id).catch(() => null);
      out.push(
        detail ?? {
          id,
          name: String(row.Names?.[0] ?? "").replace(/^\//, ""),
          image: String(row.Image ?? ""),
          image_id: String(row.ImageID ?? ""),
          state: String(row.State ?? "unknown"),
          health: "none",
          started_at: null,
          restart_count: 0,
          labels: (row.Labels ?? {}) as Record<string, string>,
        },
      );
    }
    return out;
  }

  async create(name: string, config: Record<string, unknown>): Promise<string> {
    const r = await this.request("POST", `/containers/create?name=${encodeURIComponent(name)}`, config);
    if (r.status !== 201) throw new DockerError(r.status, "DOCKER_CREATE_FAILED", this.message(r));
    return String(JSON.parse(r.body.toString("utf8")).Id);
  }

  async start(nameOrId: string): Promise<void> {
    const r = await this.request("POST", `/containers/${encodeURIComponent(nameOrId)}/start`);
    if (r.status !== 204 && r.status !== 304) {
      throw new DockerError(r.status, "DOCKER_START_FAILED", this.message(r));
    }
  }

  async stop(nameOrId: string, timeoutSeconds: number): Promise<void> {
    const r = await this.request(
      "POST",
      `/containers/${encodeURIComponent(nameOrId)}/stop?t=${Math.max(0, timeoutSeconds)}`,
    );
    if (r.status !== 204 && r.status !== 304) {
      throw new DockerError(r.status, "DOCKER_STOP_FAILED", this.message(r));
    }
  }

  async restart(nameOrId: string, timeoutSeconds: number): Promise<void> {
    const r = await this.request(
      "POST",
      `/containers/${encodeURIComponent(nameOrId)}/restart?t=${Math.max(0, timeoutSeconds)}`,
      undefined,
      Math.max(this.timeoutMs, (timeoutSeconds + 30) * 1000),
    );
    if (r.status !== 204) throw new DockerError(r.status, "DOCKER_RESTART_FAILED", this.message(r));
  }

  async remove(nameOrId: string, removeVolumes: boolean): Promise<void> {
    const r = await this.request(
      "DELETE",
      `/containers/${encodeURIComponent(nameOrId)}?force=1&v=${removeVolumes ? 1 : 0}`,
    );
    if (r.status !== 204 && r.status !== 404) {
      throw new DockerError(r.status, "DOCKER_REMOVE_FAILED", this.message(r));
    }
  }

  async removeVolume(name: string): Promise<void> {
    const r = await this.request("DELETE", `/volumes/${encodeURIComponent(name)}`);
    if (r.status !== 204 && r.status !== 404) {
      throw new DockerError(r.status, "DOCKER_VOLUME_REMOVE_FAILED", this.message(r));
    }
  }

  async pull(image: string): Promise<void> {
    const { repo, tag } = splitPinnedImage(image);
    const path = `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`;
    const r = await this.request("POST", path, undefined, 10 * 60_000);
    const text = r.body.toString("utf8");
    if (r.status !== 200) throw new DockerError(r.status, "DOCKER_PULL_FAILED", text.slice(0, 500));
    // Docker 在 200 的流里返回错误行
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) throw new DockerError(500, "DOCKER_PULL_FAILED", String(parsed.error));
      } catch (e) {
        if (e instanceof DockerError) throw e;
        // 非 JSON 行忽略（进度输出）
      }
    }
  }

  /** 网络策略映射到的 Docker 网络不存在时自动创建，免得上游漏建导致容器起不来。 */
  async ensureNetwork(name: string): Promise<void> {
    const r = await this.request("GET", `/networks/${encodeURIComponent(name)}`);
    if (r.status === 200) return;
    if (r.status !== 404) {
      throw new DockerError(r.status, "DOCKER_NETWORK_INSPECT_FAILED", this.message(r));
    }
    const created = await this.request("POST", "/networks/create", {
      Name: name,
      Driver: "bridge",
      CheckDuplicate: true,
    });
    if (created.status !== 201 && created.status !== 409) {
      throw new DockerError(created.status, "DOCKER_NETWORK_CREATE_FAILED", this.message(created));
    }
  }

  async putArchive(nameOrId: string, targetDir: string, tar: Buffer): Promise<void> {
    const r = await this.send(
      "PUT",
      `/containers/${encodeURIComponent(nameOrId)}/archive?path=${encodeURIComponent(targetDir)}`,
      tar,
      "application/x-tar",
      this.timeoutMs,
    );
    if (r.status !== 200) {
      throw new DockerError(r.status, "DOCKER_ARCHIVE_FAILED", this.message(r));
    }
  }

  async inspectImage(image: string): Promise<{ id: string; repo_digests: string[] } | null> {
    const r = await this.request("GET", `/images/${encodeURIComponent(image)}/json`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new DockerError(r.status, "DOCKER_IMAGE_INSPECT_FAILED", this.message(r));
    const data = JSON.parse(r.body.toString("utf8"));
    return { id: String(data.Id ?? ""), repo_digests: (data.RepoDigests ?? []) as string[] };
  }
}

export function splitPinnedImage(image: string): { repo: string; tag: string } {
  const m = /^(.+)@(sha256:[0-9a-f]{64})$/.exec(image);
  if (!m) throw new DockerError(400, "IMAGE_NOT_PINNED", `镜像必须固定 digest：${image}`);
  return { repo: m[1], tag: m[2] };
}

function mapInspect(data: Record<string, any>): ContainerInfo {
  const state = data.State ?? {};
  const health = state.Health?.Status;
  const started = state.StartedAt && !String(state.StartedAt).startsWith("0001-")
    ? String(state.StartedAt)
    : null;
  return {
    id: String(data.Id ?? ""),
    name: String(data.Name ?? "").replace(/^\//, ""),
    image: String(data.Config?.Image ?? ""),
    image_id: String(data.Image ?? ""),
    state: String(state.Status ?? "unknown"),
    health: health ? String(health) : "none",
    started_at: started,
    restart_count: Number(data.RestartCount ?? 0),
    labels: (data.Config?.Labels ?? {}) as Record<string, string>,
  };
}
