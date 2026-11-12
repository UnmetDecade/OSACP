import http from "node:http";
import type { ApiProfile } from "./types.js";
import { assertEgressAllowed, EgressDenied, type EgressPolicyOptions } from "./egress.js";
import { SecretDenied, type SecretClient } from "./secret-client.js";

export class ApiAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ApiAdapterError";
  }
}

export interface ApiAuditRecord {
  ts: string;
  instance_id: string;
  api_profile_id: string;
  method: string;
  host: string;
  path: string;
  status: number;
  duration_ms: number;
  quota_remaining?: number;
  fallback_from?: string;
  error_code?: string;
}

export type ApiAudit = (record: ApiAuditRecord) => void;

export interface ApiAdapterOptions {
  instanceId: string;
  profiles: Map<string, ApiProfile>;
  secretClient: SecretClient;
  egress: EgressPolicyOptions;
  port?: number;
  host?: string;
  /** For injection (tests) */
  fetchImpl?: typeof fetch;
  audit?: ApiAudit;
}

interface QuotaState {
  window: number[];
  day: string;
  dayCount: number;
}

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class ApiAdapter {
  private server?: http.Server;
  private readonly quota = new Map<string, QuotaState>();
  private readonly fetchImpl: typeof fetch;
  private actualPort = 0;

  constructor(private readonly opts: ApiAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get url(): string {
    return `http://127.0.0.1:${this.actualPort}`;
  }

  get port(): number {
    return this.actualPort;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handleHttp(req, res).catch((e) => {
        const err =
          e instanceof ApiAdapterError
            ? e
            : new ApiAdapterError("API_ADAPTER_INTERNAL", e instanceof Error ? e.message : String(e));
        if (!res.headersSent) {
          res.writeHead(err.status, { "content-type": "application/json", "cache-control": "no-store" });
        }
        res.end(JSON.stringify({ error: { code: err.code, message: err.message } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port ?? 8090, this.opts.host ?? "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    this.actualPort = typeof addr === "object" && addr ? addr.port : 0;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = /^\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) {
      throw new ApiAdapterError("API_HANDLE_INVALID", "路径必须是 /<api_profile>/<path>", 404);
    }
    const profileId = decodeURIComponent(m[1]);
    const rest = m[2] ?? "/";
    const body = await readBody(req, 1024 * 1024);
    const out = await this.call(profileId, req.method ?? "GET", rest, {
      body,
      idempotencyKey: header(req, "idempotency-key"),
      accept: header(req, "accept"),
      contentType: header(req, "content-type"),
      query: url.search,
    });
    res.writeHead(out.status, {
      "content-type": out.contentType,
      "cache-control": "no-store",
      ...(out.retryAfter ? { "retry-after": out.retryAfter } : {}),
    });
    res.end(out.body);
  }

  /**
   * Unified egress entry point. The Agent can only reach external APIs through here; auth headers are injected here,
   * and any authorization / cookie / host supplied by the Agent are discarded.
   */
  async call(
    profileId: string,
    method: string,
    path: string,
    init: {
      body?: Buffer | string;
      headers?: Record<string, string>;
      idempotencyKey?: string;
      accept?: string;
      contentType?: string;
      query?: string;
    } = {},
  ): Promise<{ status: number; contentType: string; body: Buffer; retryAfter?: string }> {
    const primary = this.opts.profiles.get(profileId);
    if (!primary) {
      throw new ApiAdapterError("API_PROFILE_NOT_ALLOWED", `未绑定的 API Profile：${profileId}`, 403);
    }
    const chain = [primary, ...(primary.fallback ?? []).map((id) => this.opts.profiles.get(id)).filter((x): x is ApiProfile => Boolean(x))];
    let last: ApiAdapterError | null = null;

    for (let i = 0; i < chain.length; i++) {
      const profile = chain[i];
      try {
        const out = await this.once(profile, method, path, init, i > 0 ? primary.api_profile_id : undefined);
        return out;
      } catch (e) {
        const err = e instanceof ApiAdapterError ? e : new ApiAdapterError("API_ADAPTER_INTERNAL", String(e));
        last = err;
        if (!err.retryable || i === chain.length - 1) break;
        this.audit({
          api_profile_id: profile.api_profile_id,
          method,
          host: safeHost(profile.base_url),
          path,
          status: err.status,
          duration_ms: 0,
          error_code: `FALLBACK:${err.code}`,
          fallback_from: primary.api_profile_id,
        });
      }
    }
    throw last ?? new ApiAdapterError("API_ADAPTER_INTERNAL", "没有可用的 API Profile");
  }

  private async once(
    profile: ApiProfile,
    method: string,
    path: string,
    init: { body?: Buffer | string; headers?: Record<string, string>; idempotencyKey?: string; accept?: string; contentType?: string; query?: string },
    fallbackFrom?: string,
  ): Promise<{ status: number; contentType: string; body: Buffer; retryAfter?: string }> {
    const started = Date.now();
    const target = joinUrl(profile.base_url, path) + (init.query ?? "");
    const url = new URL(target);
    try {
      await assertEgressAllowed(url, profile.egress, this.opts.egress);
    } catch (e) {
      if (e instanceof EgressDenied) {
        throw new ApiAdapterError(e.code, e.message, 403, false);
      }
      throw e;
    }

    const quotaRemaining = this.takeQuota(profile);
    let credential: { credential: string; expiresAt: number };
    try {
      credential = await this.opts.secretClient.resolve(profile.secret_ref);
    } catch (e) {
      if (e instanceof SecretDenied) {
        throw new ApiAdapterError(e.code, e.message, 502, false);
      }
      throw e;
    }
    const headers = sanitizeHeaders(init.headers ?? {});
    applyAuth(headers, profile, credential.credential);
    if (init.accept) headers.accept = init.accept;
    if (init.contentType) headers["content-type"] = init.contentType;
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;

    const idempotent = method === "GET" || method === "HEAD" || Boolean(init.idempotencyKey);
    let attempt = 0;
    // Retry only idempotent requests; do not blindly replay when the result is uncertain
    while (true) {
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : (init.body as any),
          redirect: "manual",
          signal: AbortSignal.timeout(profile.timeout_seconds * 1000),
        });
      } catch (e) {
        if (idempotent && attempt === 0) {
          attempt++;
          continue;
        }
        this.audit({
          api_profile_id: profile.api_profile_id,
          method,
          host: url.hostname,
          path: url.pathname,
          status: 0,
          duration_ms: Date.now() - started,
          quota_remaining: quotaRemaining,
          error_code: "API_NETWORK_ERROR",
          fallback_from: fallbackFrom,
        });
        throw new ApiAdapterError("API_NETWORK_ERROR", `外部 API 不可达：${url.hostname}`, 502, true);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (location && method !== "GET" && method !== "HEAD") {
          throw new ApiAdapterError("API_REDIRECT_DENIED", "非幂等请求不允许重定向", 502);
        }
        if (location) {
          // The redirect target must also pass the allowlist; return the 302 directly so the Agent re-issues explicitly, avoiding silent following
          const next = new URL(location, url);
          await assertEgressAllowed(next, profile.egress, this.opts.egress);
          this.audit({
            api_profile_id: profile.api_profile_id,
            method,
            host: url.hostname,
            path: url.pathname,
            status: res.status,
            duration_ms: Date.now() - started,
            quota_remaining: quotaRemaining,
            error_code: "API_REDIRECT_REVALIDATED",
            fallback_from: fallbackFrom,
          });
          return {
            status: res.status,
            contentType: "application/json",
            body: Buffer.from(
              JSON.stringify({ redirect_to: next.toString(), note: "redirect target validated; re-issue explicitly" }),
            ),
          };
        }
      }

      if (!res.ok && res.status >= 500 && idempotent && attempt === 0) {
        attempt++;
        continue;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      this.audit({
        api_profile_id: profile.api_profile_id,
        method,
        host: url.hostname,
        path: url.pathname,
        status: res.status,
        duration_ms: Date.now() - started,
        quota_remaining: quotaRemaining,
        error_code: res.ok ? undefined : `API_HTTP_${res.status}`,
        fallback_from: fallbackFrom,
      });
      if (!res.ok && res.status >= 500) {
        throw new ApiAdapterError(`API_HTTP_${res.status}`, `外部 API 返回 ${res.status}`, 502, true);
      }
      return {
        status: res.status,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
        body: buf,
      };
    }
  }

  private takeQuota(profile: ApiProfile): number | undefined {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    let state = this.quota.get(profile.api_profile_id);
    if (!state || state.day !== day) {
      state = { window: [], day, dayCount: 0 };
      this.quota.set(profile.api_profile_id, state);
    }
    state.window = state.window.filter((t) => now - t < 60_000);
    if (profile.quota.rpm && state.window.length >= profile.quota.rpm) {
      throw new ApiAdapterError("API_QUOTA_EXCEEDED", "请求超过 rpm 配额", 429, false);
    }
    if (profile.quota.daily_calls && state.dayCount >= profile.quota.daily_calls) {
      throw new ApiAdapterError("API_QUOTA_EXCEEDED", "请求超过日配额", 429, false);
    }
    state.window.push(now);
    state.dayCount++;
    if (profile.quota.rpm) return Math.max(0, profile.quota.rpm - state.window.length);
    if (profile.quota.daily_calls) return Math.max(0, profile.quota.daily_calls - state.dayCount);
    return undefined;
  }

  private audit(r: Omit<ApiAuditRecord, "ts" | "instance_id">): void {
    try {
      this.opts.audit?.({
        ts: new Date().toISOString(),
        instance_id: this.opts.instanceId,
        ...r,
      });
    } catch {
      // An audit failure does not roll back a completed call; the local log still records it
    }
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function sanitizeHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    const key = k.toLowerCase();
    if (HOP_HEADERS.has(key) || ["authorization", "cookie", "host", "x-api-key"].includes(key)) continue;
    out[key] = v;
  }
  return out;
}

function applyAuth(headers: Record<string, string>, profile: ApiProfile, credential: string): void {
  if (profile.auth_type === "bearer") headers.authorization = `Bearer ${credential}`;
  else if (profile.auth_type === "api_key") headers["x-api-key"] = credential;
  else {
    throw new ApiAdapterError(
      "API_AUTH_TYPE_UNSUPPORTED",
      `参考实现未实现 ${profile.auth_type}，失败关闭`,
      502,
    );
  }
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new ApiAdapterError("API_BODY_TOO_LARGE", "请求体超过 1MiB", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "(invalid)";
  }
}

export { EgressDenied };
