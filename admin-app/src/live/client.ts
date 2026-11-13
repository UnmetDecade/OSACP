import { t } from "../i18n";
import type { LiveConnection } from "./config";

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

async function request(
  connection: LiveConnection,
  base: string,
  path: string,
  { method = "GET", body, auth = false }: Req,
): Promise<any> {
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
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = data?.error ?? {};
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
  return data;
}

export function pcs(
  connection: LiveConnection,
  path: string,
  req: Omit<Req, "auth"> = {},
): Promise<any> {
  return request(connection, connection.pcsUrl, path, { ...req, auth: true });
}

export function scheduler(
  connection: LiveConnection,
  path: string,
  req: Omit<Req, "auth"> = {},
): Promise<any> {
  return request(connection, connection.schedulerUrl, path, { ...req, auth: false });
}

/**
 * Send a request to a specific scheduler deployment (root or node).
 *
 * Each scheduler has its own database, and node addresses exist only in the control plane; so this goes through the control plane's
 * /schedulers/:dep/proxy rather than having the browser connect to internal addresses directly. Without a deployment id,
 * it falls back to the default scheduler (compatible with legacy setups that have only a root scheduler).
 */
export function schedulerFor(
  connection: LiveConnection,
  deploymentId: string | null | undefined,
  path: string,
  req: Omit<Req, "auth"> = {},
): Promise<any> {
  if (!deploymentId) return scheduler(connection, path, req);
  return request(
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
