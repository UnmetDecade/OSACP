/** Scheduler HTTP client. Only handles transport and error normalization; contains no scheduling decisions. */
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

  /** Write was overridden by a stale attempt: abandon this task immediately, do not retry */
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
  /** Task requirements and workflow handoff (upstream_artifacts, etc.), issued by the scheduler */
  requirements: Record<string, unknown>;
  /** How much the agent may do without asking: ask | edits | auto | full */
  approval_mode?: string;
  /** P4: Agent/API Profile references; implementations and secrets are not in the envelope */
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
  /** Internal CA; used to verify the scheduler's server certificate */
  caFile?: string;
  /** Optional mTLS: client certificate and key */
  certFile?: string;
  keyFile?: string;
}

export class SchedulerClient {
  private readonly tls: { ca?: Buffer; cert?: Buffer; key?: Buffer };

  constructor(
    private readonly baseUrl: string,
    private readonly defaultTimeoutMs = 5000,
    /** Instance JWT (issued by PCS, read from the mounted file); the legacy shared token also goes here */
    private readonly token?: string | (() => string | undefined),
    tlsOptions: SchedulerTlsOptions = {},
  ) {
    this.tls = {
      ca: tlsOptions.caFile ? fs.readFileSync(tlsOptions.caFile) : undefined,
      cert: tlsOptions.certFile ? fs.readFileSync(tlsOptions.certFile) : undefined,
      key: tlsOptions.keyFile ? fs.readFileSync(tlsOptions.keyFile) : undefined,
    };
  }

  /** Read on every request: token file rotation requires no process restart */
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
            req.on("timeout", () => req.destroy(new Error(`Request timed out (${timeout}ms)`)));
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
    // Normalize network-layer failures to status 0, so the caller can distinguish "scheduler unreachable" from business errors
    if (lastErr instanceof SchedulerError) throw lastErr;
    throw new SchedulerError(0, "SCHEDULER_UNREACHABLE", String((lastErr as Error)?.message ?? lastErr));
  }

  /** Raw byte request (artifact upload/download): also over HTTPS / mTLS, without JSON parsing. */
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
        req.on("timeout", () => req.destroy(new Error(`Request timed out (${timeoutMs}ms)`)));
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
    /** Work capability score W and detail; an old scheduler that does not recognize these two fields ignores them. */
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

  /** Claim. Returns null (204) when there are no candidates. Network failures are not auto-retried; that is left to the caller's loop cadence. */
  claim(instanceId: string): Promise<Assignment | null> {
    return this.request<Assignment>("POST", "/v1/claim", { instance_id: instanceId }, { retries: 0 });
  }

  startAck(attemptId: string, input: Proof & { instance_id: string; accepted?: boolean }) {
    return this.request<{ status: string }>("POST", `/v1/attempts/${attemptId}/start-ack`, input);
  }

  renew(attemptId: string, input: Proof) {
    return this.request<{ lease_expires_at: string }>("POST", `/v1/attempts/${attemptId}/renew`, input);
  }

  progress(
    attemptId: string,
    input: Proof & { percent?: number; note?: string; outward?: string[] },
  ) {
    return this.request<{ ok: boolean }>("POST", `/v1/attempts/${attemptId}/progress`, input);
  }

  result(
    attemptId: string,
    input: Proof & {
      status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "NEEDS_INPUT";
      summary?: string;
      outputs?: unknown;
      outcome?: string;
      /** NEEDS_INPUT only: the question a person has to answer. */
      question?: string;
      /** Every outward action attempted during this attempt, so a failure is not retried blindly. */
      outward_actions?: string[];
      error?: { code: string; message?: string; detail?: unknown };
    },
  ) {
    return this.request<unknown>("POST", `/v1/attempts/${attemptId}/result`, input);
  }

  /**
   * Ask the scheduler to fan this task out to child tasks.
   *
   * This replaces a result report: the scheduler parks this attempt and releases its lease in the
   * same transaction that enqueues the children, so the host must not submit SUCCEEDED afterwards.
   */
  split(
    taskId: string,
    input: Proof & {
      children: Array<{
        task_type?: string;
        title?: string;
        instruction?: string;
        requirements?: Record<string, unknown>;
        artifact_ids?: string[];
      }>;
    },
  ) {
    return this.request<{ task: { task_id: string }; children: string[] }>(
      "POST",
      `/v1/tasks/${taskId}/split`,
      input,
    );
  }

  task(taskId: string) {
    return this.request<{ status: string; cancel_requested_at: string | null }>(
      "GET",
      `/v1/tasks/${taskId}`,
    );
  }

  /** Config sync. When the version is unchanged the scheduler returns 304, normalized to null here. */
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

  /** Deregister. With in-flight tasks and force=false, the scheduler returns 409. */
  deregister(instanceId: string, input: { reason?: string; force?: boolean } = {}) {
    return this.request<{ instance_id: string; state: string; active_attempts: number }>(
      "POST",
      `/v1/instances/${instanceId}/deregister`,
      input,
    );
  }

  // ---------------- Artifacts (§7.8)

  createArtifact(input: {
    task_id: string;
    attempt_id: string;
    sha256: string;
    size_bytes: number;
    media_type?: string;
    /** Original file name, so the operator-facing download can present it instead of an artifact id. */
    name?: string;
  }) {
    return this.request<{
      artifact_id: string;
      status: string;
      upload: { method: string; path: string; complete_path: string };
    }>("POST", "/v1/artifacts", input);
  }

  /** Raw byte upload, not JSON */
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
   * Download artifact raw bytes.
   *
   * The scheduler authorizes only two kinds of reads: this instance's own artifacts, or upstream artifacts the scheduler
   * explicitly handed over in the task's `requirements.upstream_artifacts`. The caller must still
   * re-verify against the sha256 in the handoff record; the transport layer cannot be trusted.
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
