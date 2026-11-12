/** 调度机 HTTP 客户端。只做传输与错误归一化，不含任何调度判断。 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { InstanceConfig } from "./config.js";

export class SchedulerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SchedulerError";
  }

  /** 写入被旧 attempt 顶掉：必须立刻放弃这个任务，不要重试 */
  get isFencingLost(): boolean {
    return this.code === "FENCING_STALE" || this.code === "LEASE_EXPIRED" || this.code === "LEASE_MISMATCH";
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export interface Assignment {
  task_id: string;
  task_type: string;
  attempt_id: string;
  attempt_number: number;
  lease_token: string;
  fencing_token: number;
  lease_expires_at: string;
  grant_id: string;
  payload_ref: string | null;
  payload_schema: string;
  resource_profile_id: string;
  deadline_at: string | null;
  /** 任务要求与工作流交接（upstream_artifacts 等），由调度机下发 */
  requirements: Record<string, unknown>;
  /** P4：Agent/API Profile 引用；实现与密钥不在信封里 */
  agent: { profile_id: string | null; version: string | null };
  api_profiles: string[];
}

export interface Proof {
  lease_token: string;
  fencing_token: number;
}

interface RequestOpts {
  retries?: number;
  timeoutMs?: number;
}

export interface SchedulerTlsOptions {
  /** 内部 CA；用于校验调度机服务端证书 */
  caFile?: string;
  /** 可选 mTLS：客户端证书与私钥 */
  certFile?: string;
  keyFile?: string;
}

export class SchedulerClient {
  private readonly tls: { ca?: Buffer; cert?: Buffer; key?: Buffer };

  constructor(
    private readonly baseUrl: string,
    private readonly defaultTimeoutMs = 5000,
    /** 实例 JWT（PCS 签发，从挂载文件读取）；旧的共享令牌也走这里 */
    private readonly token?: string | (() => string | undefined),
    tlsOptions: SchedulerTlsOptions = {},
  ) {
    this.tls = {
      ca: tlsOptions.caFile ? fs.readFileSync(tlsOptions.caFile) : undefined,
      cert: tlsOptions.certFile ? fs.readFileSync(tlsOptions.certFile) : undefined,
      key: tlsOptions.keyFile ? fs.readFileSync(tlsOptions.keyFile) : undefined,
    };
  }

  /** 每次请求都取一次：令牌文件轮换后无需重启进程 */
  private currentToken(): string | undefined {
    return typeof this.token === "function" ? this.token() : this.token;
  }

  private headers(body?: unknown): Record<string, string> {
    const h: Record<string, string> = { "X-Protocol-Version": "1.0" };
    if (body !== undefined) h["content-type"] = "application/json";
    const token = this.currentToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOpts = {},
  ): Promise<T | null> {
    const retries = opts.retries ?? 2;
    const timeout = opts.timeoutMs ?? this.defaultTimeoutMs;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const url = new URL(`${this.baseUrl}${path}`);
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const headers = this.headers(body) as Record<string, string | number>;
        if (payload) headers["content-length"] = payload.length;
        const isHttps = url.protocol === "https:";
        const options: https.RequestOptions = { method, headers, timeout };
        if (isHttps) {
          if (this.tls.ca) options.ca = this.tls.ca;
          if (this.tls.cert) options.cert = this.tls.cert;
          if (this.tls.key) options.key = this.tls.key;
        }

        const { status, text } = await new Promise<{ status: number; text: string }>(
          (resolve, reject) => {
            const req = (isHttps ? https : http).request(url, options, (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
              );
            });
            req.on("timeout", () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
            req.on("error", reject);
            if (payload) req.write(payload);
            req.end();
          },
        );

        if (status === 204 || status === 304) return null;

        const data = text ? JSON.parse(text) : {};

        if (status < 200 || status >= 300) {
          const err = data?.error ?? {};
          throw new SchedulerError(
            status,
            err.code ?? "UNKNOWN",
            err.message ?? `HTTP ${status}`,
            err.detail,
          );
        }
        return data as T;
      } catch (e) {
        if (e instanceof SchedulerError && !e.isRetryable) throw e;
        lastErr = e;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        }
      }
    }
    // 网络层失败统一成 status 0，调用方据此区分“调度机不可达”和业务错误
    if (lastErr instanceof SchedulerError) throw lastErr;
    throw new SchedulerError(0, "SCHEDULER_UNREACHABLE", String((lastErr as Error)?.message ?? lastErr));
  }

  /** 原始字节请求（制品上传/下载）：同样走 HTTPS / mTLS，不经过 JSON 解析。 */
  private async rawRequest(
    method: string,
    path: string,
    body: Buffer | undefined,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: Buffer }> {
    const url = new URL(`${this.baseUrl}${path}`);
    const isHttps = url.protocol === "https:";
    const headers: Record<string, string | number> = { "X-Protocol-Version": "1.0" };
    const token = this.currentToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) {
      headers["content-type"] = "application/octet-stream";
      headers["content-length"] = body.length;
    }
    const options: https.RequestOptions = { method, headers, timeout: timeoutMs };
    if (isHttps) {
      if (this.tls.ca) options.ca = this.tls.ca;
      if (this.tls.cert) options.cert = this.tls.cert;
      if (this.tls.key) options.key = this.tls.key;
    }
    try {
      return await new Promise((resolve, reject) => {
        const req = (isHttps ? https : http).request(url, options, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              data: Buffer.concat(chunks),
            }),
          );
        });
        req.on("timeout", () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      throw new SchedulerError(0, msg.includes("timed out") || msg.includes("超时") ? "TIMEOUT" : "SCHEDULER_UNREACHABLE", msg);
    }
  }

  register(input: {
    instance_id: string;
    role_id: string;
    host_id: string;
    agent_profile_id: string;
    agent_profile_version?: string;
    api_profile_ids?: string[];
    allowed_task_types: string[];
    capabilities: { healthy: string[]; unhealthy?: string[] };
    config_version: number;
    /** 工作能力值 W 与明细；旧调度机不认识这两个字段时会忽略。 */
    capability_score?: number;
    capability_detail?: InstanceConfig["capability_detail"];
  }) {
    return this.request<{ instance_id: string; state: string }>("POST", "/v1/instances/register", input);
  }

  heartbeat(input: {
    instance_id: string;
    state?: "ONLINE" | "STARTING" | "DRAINING";
    load?: Record<string, unknown>;
    capabilities?: { healthy: string[]; unhealthy?: string[] };
  }) {
    return this.request<{ instance_id: string; state: string }>("POST", "/v1/instances/heartbeat", input);
  }

  /** 领取。没有候选返回 null（204）。网络失败不自动重试，交给调用方的循环节奏。 */
  claim(instanceId: string): Promise<Assignment | null> {
    return this.request<Assignment>("POST", "/v1/claim", { instance_id: instanceId }, { retries: 0 });
  }

  startAck(attemptId: string, input: Proof & { instance_id: string; accepted?: boolean }) {
    return this.request<{ status: string }>("POST", `/v1/attempts/${attemptId}/start-ack`, input);
  }

  renew(attemptId: string, input: Proof) {
    return this.request<{ lease_expires_at: string }>("POST", `/v1/attempts/${attemptId}/renew`, input);
  }

  progress(attemptId: string, input: Proof & { percent?: number; note?: string }) {
    return this.request<{ ok: boolean }>("POST", `/v1/attempts/${attemptId}/progress`, input);
  }

  result(
    attemptId: string,
    input: Proof & {
      status: "SUCCEEDED" | "FAILED" | "CANCELLED";
      summary?: string;
      outputs?: unknown;
      error?: { code: string; message?: string; detail?: unknown };
    },
  ) {
    return this.request<unknown>("POST", `/v1/attempts/${attemptId}/result`, input);
  }

  task(taskId: string) {
    return this.request<{ status: string; cancel_requested_at: string | null }>(
      "GET",
      `/v1/tasks/${taskId}`,
    );
  }

  /** 配置同步。版本未变时调度机回 304，这里归一化成 null。 */
  config(instanceId: string, version?: number) {
    const qs = version === undefined ? "" : `?version=${encodeURIComponent(version)}`;
    return this.request<{
      config_version: number;
      allowed_task_types: string[];
      agent?: { profile_id: string | null; version: string | null; args?: Record<string, unknown> };
      api_profiles?: string[];
      capabilities?: { healthy: string[]; unhealthy?: string[] };
      drain?: { requested: boolean; deadline_at: string | null };
      policy?: Record<string, unknown>;
    }>("GET", `/v1/instances/${instanceId}/config${qs}`);
  }

  /** 注销。有在途任务且 force=false 时调度机回 409。 */
  deregister(instanceId: string, input: { reason?: string; force?: boolean } = {}) {
    return this.request<{ instance_id: string; state: string; active_attempts: number }>(
      "POST",
      `/v1/instances/${instanceId}/deregister`,
      input,
    );
  }

  // ---------------- 制品（§7.8）

  createArtifact(input: {
    task_id: string;
    attempt_id: string;
    sha256: string;
    size_bytes: number;
    media_type?: string;
  }) {
    return this.request<{
      artifact_id: string;
      status: string;
      upload: { method: string; path: string; complete_path: string };
    }>("POST", "/v1/artifacts", input);
  }

  /** 原始字节上传，不走 JSON */
  async uploadArtifactContent(artifactId: string, content: Buffer): Promise<void> {
    const res = await this.rawRequest(
      "PUT",
      `/v1/artifacts/${encodeURIComponent(artifactId)}/content`,
      content,
    );
    if (res.status < 200 || res.status >= 300) {
      const data = res.data.length ? JSON.parse(res.data.toString("utf8")) : {};
      const err = (data as any)?.error ?? {};
      throw new SchedulerError(res.status, err.code ?? "UNKNOWN", err.message ?? `HTTP ${res.status}`);
    }
  }

  completeArtifact(artifactId: string) {
    return this.request<{ artifact_id: string; status: string; actual_sha256: string }>(
      "POST",
      `/v1/artifacts/${artifactId}/complete`,
    );
  }

  /**
   * 下载制品原始字节。
   *
   * 调度机只授权两类读取：本实例自己的制品，或调度机在任务
   * `requirements.upstream_artifacts` 里显式交接的上游制品。调用方仍要
   * 自己按交接单里的 sha256 复核，不能信任传输层。
   */
  async downloadArtifactContent(
    artifactId: string,
  ): Promise<{ data: Buffer; sha256: string; media_type: string }> {
    const res = await this.rawRequest(
      "GET",
      `/v1/artifacts/${encodeURIComponent(artifactId)}/content`,
      undefined,
    );
    if (res.status < 200 || res.status >= 300) {
      const data = res.data.length ? JSON.parse(res.data.toString("utf8")) : {};
      const err = (data as any)?.error ?? {};
      throw new SchedulerError(
        res.status,
        err.code ?? "UNKNOWN",
        err.message ?? `HTTP ${res.status}`,
        err.detail,
      );
    }
    return {
      data: res.data,
      sha256: String(res.headers["x-artifact-sha256"] ?? ""),
      media_type: String(res.headers["content-type"] ?? "application/octet-stream")
        .split(";")[0]!
        .trim(),
    };
  }
}
