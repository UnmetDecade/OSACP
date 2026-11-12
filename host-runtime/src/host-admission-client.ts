import http from "node:http";

export interface HostAdmissionRequest {
  grant_id: string;
  kind: "TASK";
  instance_id: string;
  task_id: string;
  attempt_id: string;
  resources: { memory_bytes: number; workspace_bytes?: number };
}

export interface HostAdmissionResult {
  allowed: boolean;
  reason?: string;
  grant_id: string;
  observed: {
    mem_available_bytes: number;
    allocatable_bytes: number;
    deployment_grants_bytes: number;
    task_grants_bytes: number;
    requested_bytes: number;
  };
}

export interface HostGrantInfo {
  grant_id: string;
  instance_id: string;
  task_id: string;
  attempt_id: string;
  memory_bytes: number;
  expires_at: number;
}

/** 只走本机 unix socket；没有网络监听，也不接受任意资源数值。 */
function call<T>(socketPath: string, method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath,
        method,
        path,
        headers: {
          host: "runtime",
          ...(payload
            ? { "content-type": "application/json", "content-length": String(payload.length) }
            : {}),
        },
        timeout: 3000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: Record<string, any> = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            return reject(new Error(`host admission 返回非 JSON：${text.slice(0, 200)}`));
          }
          if (!res.statusCode || res.statusCode >= 400) {
            const err = data.error ?? {};
            return reject(new Error(`${res.statusCode} ${err.code ?? ""} ${err.message ?? text}`));
          }
          resolve(data as T);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("host admission timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function checkHostAdmission(
  socketPath: string,
  input: HostAdmissionRequest,
): Promise<HostAdmissionResult> {
  return call<HostAdmissionResult>(socketPath, "POST", "/admission/check", input);
}

/** 列出本机全部 ACTIVE task grant；崩溃重启后按 instance_id 过滤并释放。 */
export function listHostGrants(
  socketPath: string,
): Promise<{ items: HostGrantInfo[] } & Record<string, unknown>> {
  return call(socketPath, "GET", "/grants");
}

export function releaseHostAdmission(
  socketPath: string,
  grantId: string,
): Promise<{ grant_id: string; released: boolean }> {
  return call(socketPath, "POST", "/admission/release", { grant_id: grantId });
}
