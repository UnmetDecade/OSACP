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
    // 代理/网关断开时响应体可能为空或是一段 HTML，兜底成可读的状态码。
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
 * 把请求发给指定调度机部署（根或结点）。
 *
 * 每台调度机各自一套库，而且结点地址只在控制面里；所以这里走控制面的
 * /schedulers/:dep/proxy 转发，而不是让浏览器直接连内网地址。没有部署 id
 * 时退回默认调度机（兼容只有根调度机的旧环境）。
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
    // 部署前校验把失败项放在 detail.checks 里；直接把失败原因带出来。
    const checks = (e.detail as { checks?: Array<{ ok?: boolean; detail?: string }> } | null)
      ?.checks;
    if (Array.isArray(checks)) {
      const failed = checks.filter((c) => c && c.ok === false).map((c) => c.detail).filter(Boolean);
      if (failed.length) return `${e.code}：${failed.join("；")}`;
    }
    // HTTP_ERROR 只是没拿到结构化错误，直接展示状态码信息即可。
    if (!e.code || e.code === "HTTP_ERROR") return e.message;
    return `${e.code}：${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
