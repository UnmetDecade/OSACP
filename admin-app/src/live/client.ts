import { t } from "../i18n";
import type { LiveConnection } from "./config";
import type { JsonObject } from "./rows";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

type Req = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  auth?: boolean;
};

/**
 * Send one request and parse the JSON body.
 *
 * The response shape is supplied by the caller (`pcs<HostsResponse>(...)`): this layer only guarantees that the body
 * was parsed and that HTTP errors became ApiError, so every call site still validates the fields it reads.
 */
async function request<T>(
  connection: LiveConnection,
  base: string,
  path: string,
  { method = "GET", body, auth = false }: Req,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth && connection.adminToken) headers.authorization = `Bearer ${connection.adminToken}`;

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      t("无法连接 {base}：{error}", { base, error: e instanceof Error ? e.message : String(e) }),
    );
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  const bodyRecord = data && typeof data === "object" ? (data as JsonObject) : {};
  if (!res.ok) {
    const err = (bodyRecord.error ?? {}) as { message?: unknown; code?: unknown; detail?: unknown };
    // When the proxy/gateway drops, the response body may be empty or HTML; fall back to a readable status code.
    const bodyText =
      typeof data === "string" && !data.trim().startsWith("<")
        ? data.trim().slice(0, 300)
        : "";
    const message =
      (typeof err.message === "string" && err.message) ||
      bodyText ||
      `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    throw new ApiError(res.status, String(err.code ?? "HTTP_ERROR"), message, err.detail);
  }
  return data as T;
}

export function pcs<T = JsonObject>(
  connection: LiveConnection,
  path: string,
  req: Omit<Req, "auth"> = {},
): Promise<T> {
  return request<T>(connection, connection.pcsUrl, path, { ...req, auth: true });
}

export function scheduler<T = JsonObject>(
  connection: LiveConnection,
  path: string,
  req: Omit<Req, "auth"> = {},
): Promise<T> {
  return request<T>(connection, connection.schedulerUrl, path, { ...req, auth: false });
}

/**
 * Send a request to a specific scheduler deployment (root or node).
 *
 * Each scheduler has its own database, and node addresses exist only in the control plane; so this goes through the control plane's
 * /schedulers/:dep/proxy rather than having the browser connect to internal addresses directly. Without a deployment id,
 * it falls back to the default scheduler (compatible with legacy setups that have only a root scheduler).
 */
export function schedulerFor<T = JsonObject>(
  connection: LiveConnection,
  deploymentId: string | null | undefined,
  path: string,
  req: Omit<Req, "auth"> = {},
): Promise<T> {
  if (!deploymentId) return scheduler<T>(connection, path, req);
  return request<T>(
    connection,
    connection.pcsUrl,
    `/api/v1/platform/schedulers/${encodeURIComponent(deploymentId)}/proxy${path}`,
    { ...req, auth: true },
  );
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    // Pre-deployment validation puts failures in detail.checks; surface the failure reason directly.
    const checks = (e.detail as { checks?: Array<{ ok?: boolean; detail?: string }> } | null)
      ?.checks;
    if (Array.isArray(checks)) {
      const failed = checks.filter((c) => c && c.ok === false).map((c) => c.detail).filter(Boolean);
      if (failed.length) return `${e.code}: ${failed.join("; ")}`;
    }
    // HTTP_ERROR simply means no structured error was received; just show the status code information.
    if (!e.code || e.code === "HTTP_ERROR") return e.message;
    return `${e.code}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
