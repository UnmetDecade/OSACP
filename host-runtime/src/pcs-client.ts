import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { CommandPayload } from "./command-verify.js";

export class PcsClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PcsClientError";
  }

  get isUnreachable(): boolean {
    return this.status === 0;
  }

  get isRevoked(): boolean {
    return this.code === "HOST_REVOKED";
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export interface EnrollResponse {
  host_id: string;
  host_token: string;
  expires_at: string;
  command_public_key: string;
}

export interface EnrollRequest {
  enrollment_token: string;
  hostname: string;
  os: string;
  arch: string;
  fingerprint: string;
  container_runtime: string;
  runtime_version: string;
  resources?: Record<string, unknown>;
  devices?: unknown[];
  tools?: unknown[];
}

export interface PcsTlsOptions {
  /** Internal CA; used to verify the PCS server certificate */
  caFile?: string;
  /** P6 mTLS: this host's certificate and key (0600, excluded from backups) */
  certFile?: string;
  keyFile?: string;
}

export class PcsClient {
  private readonly tls: { ca?: Buffer; cert?: Buffer; key?: Buffer };

  constructor(
    private readonly baseUrl: string,
    private readonly defaultTimeoutMs = 10_000,
    private token?: string,
    tlsOptions: PcsTlsOptions = {},
  ) {
    this.tls = {
      ca: tlsOptions.caFile ? fs.readFileSync(tlsOptions.caFile) : undefined,
      cert: tlsOptions.certFile ? fs.readFileSync(tlsOptions.certFile) : undefined,
      key: tlsOptions.keyFile ? fs.readFileSync(tlsOptions.keyFile) : undefined,
    };
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<T | null> {
    const url = new URL(`${this.baseUrl}${path}`);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string | number> = { accept: "application/json" };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = payload.length;
    }
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const isHttps = url.protocol === "https:";
    const options: https.RequestOptions = { method, headers, timeout: timeoutMs };
    if (isHttps) {
      if (this.tls.ca) options.ca = this.tls.ca;
      if (this.tls.cert) options.cert = this.tls.cert;
      if (this.tls.key) options.key = this.tls.key;
    }

    return await new Promise<T | null>((resolve, reject) => {
      const req = (isHttps ? https : http).request(url, options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status === 204 || status === 304) return resolve(null);
          const text = Buffer.concat(chunks).toString("utf8");
          let data: Record<string, any> = {};
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              return reject(
                new PcsClientError(status, "INVALID_RESPONSE", "PCS 返回了非 JSON 响应"),
              );
            }
          }
          if (status < 200 || status >= 300) {
            const err = data?.error ?? {};
            return reject(
              new PcsClientError(
                status,
                String(err.code ?? "HTTP_ERROR"),
                String(err.message ?? `HTTP ${status}`),
                err.detail,
              ),
            );
          }
          resolve(data as T);
        });
      });
      req.on("timeout", () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
      req.on("error", (e) =>
        reject(new PcsClientError(0, "PCS_UNREACHABLE", String((e as Error)?.message ?? e))),
      );
      if (payload) req.write(payload);
      req.end();
    });
  }

  async enroll(input: EnrollRequest): Promise<EnrollResponse> {
    return (await this.request<EnrollResponse>("POST", "/api/v1/platform/hosts/enroll", input))!;
  }

  async heartbeat(body: Record<string, unknown>): Promise<void> {
    await this.request("POST", "/api/v1/platform/runtime/heartbeat", body);
  }

  async nextCommand(waitSeconds: number): Promise<CommandPayload | null> {
    const out = await this.request<{ command: CommandPayload }>(
      "GET",
      `/api/v1/platform/runtime/commands?wait=${waitSeconds}`,
      undefined,
      (waitSeconds + 10) * 1000,
    );
    return out?.command ?? null;
  }

  async ack(commandId: string, ok: boolean, result: Record<string, unknown>): Promise<void> {
    await this.request(
      "POST",
      `/api/v1/platform/runtime/commands/${encodeURIComponent(commandId)}/ack`,
      { ok, result },
    );
  }

  async report(body: Record<string, unknown>): Promise<void> {
    await this.request("POST", "/api/v1/platform/runtime/report", body);
  }

  async renewToken(): Promise<{ host_token: string; expires_at: string }> {
    return (await this.request<{ host_token: string; expires_at: string }>(
      "POST",
      "/api/v1/platform/runtime/token/renew",
    ))!;
  }
}
