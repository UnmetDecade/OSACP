import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AdmissionConfig } from "./runtime-config.js";

export interface TaskGrantRequest {
  grant_id: string;
  kind: "TASK";
  instance_id: string;
  task_id: string;
  attempt_id: string;
  resources: { memory_bytes: number; workspace_bytes?: number };
}

export interface Observed {
  mem_available_bytes: number;
  allocatable_bytes: number;
  deployment_grants_bytes: number;
  task_grants_bytes: number;
  requested_bytes: number;
}

export interface TaskGrantInfo {
  grant_id: string;
  instance_id: string;
  task_id: string;
  attempt_id: string;
  memory_bytes: number;
  expires_at: number;
}

export interface AdmissionResult {
  allowed: boolean;
  reason?: string;
  grant_id: string;
  observed: Observed;
}

interface Grant {
  grant_id: string;
  kind: "TASK";
  instance_id: string;
  task_id: string;
  attempt_id: string;
  memory_bytes: number;
  state: "ACTIVE" | "RELEASED";
  expires_at: number;
  result: AdmissionResult;
}

export class AdmissionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdmissionError";
  }
}

/**
 * 本机二次准入。校验 + 占用在同一个 promise 链里串行执行，
 * 两个任务不可能同时看到同一份可用内存。
 *
 * 这是防超卖，不是第二调度器：不选任务、不改任务状态，只回答「现在放不放得下」。
 */
export class AdmissionBroker {
  private readonly taskGrants = new Map<string, Grant>();
  private readonly deploymentGrants = new Map<string, { instance_id: string; memory_bytes: number }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly totalMemBytes: () => number,
    private readonly memAvailableBytes: () => number,
    private readonly cfg: AdmissionConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private serialize<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private reap(now: number): void {
    for (const [id, g] of this.taskGrants) {
      if (g.state === "ACTIVE" && now >= g.expires_at) {
        g.state = "RELEASED";
        this.taskGrants.delete(id);
      }
    }
  }

  /**
   * replaceInstance：重新部署同一个实例时，旧的容器占用会被新容器接管，
   * 不能拿它来挡住新部署，否则同实例滚动部署永远过不了准入。
   */
  private sums(replaceInstance?: string): { deployment: number; task: number } {
    let deployment = 0;
    for (const g of this.deploymentGrants.values()) {
      if (replaceInstance && g.instance_id === replaceInstance) continue;
      deployment += g.memory_bytes;
    }
    let task = 0;
    for (const g of this.taskGrants.values()) {
      if (g.state === "ACTIVE") task += g.memory_bytes;
    }
    return { deployment, task };
  }

  private observed(requested: number, replaceInstance?: string): Observed {
    const { deployment, task } = this.sums(replaceInstance);
    const allocatable =
      this.totalMemBytes() -
      this.cfg.host_reserve_bytes -
      this.cfg.system_reserve_bytes -
      this.cfg.safety_margin_bytes;
    return {
      mem_available_bytes: this.memAvailableBytes(),
      allocatable_bytes: Math.max(0, allocatable),
      deployment_grants_bytes: deployment,
      task_grants_bytes: task,
      requested_bytes: requested,
    };
  }

  private availableBytes(observed: Observed): number {
    const formula =
      observed.allocatable_bytes - observed.deployment_grants_bytes - observed.task_grants_bytes;
    const realtime = observed.mem_available_bytes - this.cfg.safety_margin_bytes;
    return Math.min(formula, realtime);
  }

  check(req: TaskGrantRequest): Promise<AdmissionResult> {
    return this.serialize(() => {
      if (!req?.grant_id?.startsWith("rgr_")) {
        throw new AdmissionError(400, "INVALID_GRANT", "grant_id 必须由控制面签发（rgr_ 前缀）");
      }
      if (req.kind !== "TASK") {
        throw new AdmissionError(400, "INVALID_GRANT_KIND", "只接受 TASK 类型的 grant");
      }
      if (!req.instance_id || !req.task_id || !req.attempt_id) {
        throw new AdmissionError(400, "INVALID_GRANT", "缺少 instance_id / task_id / attempt_id");
      }
      const memory = Number(req.resources?.memory_bytes);
      if (!Number.isFinite(memory) || memory <= 0) {
        throw new AdmissionError(400, "INVALID_RESOURCES", "memory_bytes 必须是正数");
      }
      if (memory > this.cfg.max_task_grant_bytes) {
        throw new AdmissionError(
          400,
          "RESOURCE_REQUEST_TOO_LARGE",
          `单任务申请超过上限 ${this.cfg.max_task_grant_bytes} 字节`,
        );
      }

      const now = this.now();
      this.reap(now);
      const existing = this.taskGrants.get(req.grant_id);
      if (existing && existing.state === "ACTIVE") {
        if (
          existing.instance_id !== req.instance_id ||
          existing.task_id !== req.task_id ||
          existing.attempt_id !== req.attempt_id
        ) {
          throw new AdmissionError(409, "GRANT_CONFLICT", "同一 grant_id 不能用于不同 attempt");
        }
        return existing.result;
      }

      // 任务跑在实例自己的预算里：这个实例的 DEPLOYMENT grant 是上限，
      // 不能再当成另一份额外占用重复扣，否则裸机构建机的第一个任务永远放不下。
      const observed = this.observed(memory, req.instance_id);
      const available = this.availableBytes(observed);
      const allowed = available >= memory;
      const result: AdmissionResult = {
        allowed,
        reason: allowed ? undefined : "INSUFFICIENT_MEMORY",
        grant_id: req.grant_id,
        observed,
      };
      if (allowed) {
        this.taskGrants.set(req.grant_id, {
          ...req,
          memory_bytes: memory,
          state: "ACTIVE",
          expires_at: now + this.cfg.grant_ttl_seconds * 1000,
          result,
        });
      }
      return result;
    });
  }

  release(grantId: string): Promise<{ grant_id: string; released: boolean }> {
    return this.serialize(() => {
      const g = this.taskGrants.get(grantId);
      if (!g) return { grant_id: grantId, released: false };
      this.taskGrants.delete(grantId);
      return { grant_id: grantId, released: true };
    });
  }

  /** 启动容器前的 DEPLOYMENT grant：长驻占用，容器停止/移除后从列表里消失。 */
  checkDeployment(grantId: string, instanceId: string, memoryBytes: number): Promise<AdmissionResult> {
    return this.serialize(() => {
      if (!grantId.startsWith("rgr_")) {
        throw new AdmissionError(400, "INVALID_GRANT", "grant_id 必须由控制面签发");
      }
      const now = this.now();
      this.reap(now);
      const existing = this.deploymentGrants.get(grantId);
      // 同实例重新部署：旧容器的占用不算数，它会被这次部署替换掉。
      const observed = this.observed(memoryBytes, instanceId);
      if (existing) {
        return { allowed: true, grant_id: grantId, observed };
      }
      const available = this.availableBytes(observed);
      const allowed = available >= memoryBytes;
      if (allowed) this.deploymentGrants.set(grantId, { instance_id: instanceId, memory_bytes: memoryBytes });
      return {
        allowed,
        reason: allowed ? undefined : "INSUFFICIENT_MEMORY",
        grant_id: grantId,
        observed,
      };
    });
  }

  /** reconciler 用实际运行中的容器重建部署占用，避免重复记账或泄漏。 */
  setDeploymentGrants(grants: Array<{ grant_id: string; instance_id: string; memory_bytes: number }>): void {
    this.deploymentGrants.clear();
    for (const g of grants) this.deploymentGrants.set(g.grant_id, {
      instance_id: g.instance_id,
      memory_bytes: g.memory_bytes,
    });
  }

  /** 列出 ACTIVE task grant：崩溃后由角色实例按 instance_id 对账释放。 */
  grants(): TaskGrantInfo[] {
    this.reap(this.now());
    return [...this.taskGrants.values()]
      .filter((g) => g.state === "ACTIVE")
      .map((g) => ({
        grant_id: g.grant_id,
        instance_id: g.instance_id,
        task_id: g.task_id,
        attempt_id: g.attempt_id,
        memory_bytes: g.memory_bytes,
        expires_at: g.expires_at,
      }));
  }

  summary(): { deployment_grants: number; task_grants: number; deployment_bytes: number; task_bytes: number } {
    const { deployment, task } = this.sums();
    return {
      deployment_grants: this.deploymentGrants.size,
      task_grants: this.taskGrants.size,
      deployment_bytes: deployment,
      task_bytes: task,
    };
  }
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new AdmissionError(413, "BODY_TOO_LARGE", "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new AdmissionError(400, "INVALID_JSON", "请求体不是 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** 只在 unix socket 上监听（0600），不监听任何网络地址。 */
export function startAdmissionServer(
  broker: AdmissionBroker,
  socketPath: string,
): Promise<http.Server> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    const st = fs.lstatSync(socketPath);
    if (st.isSocket()) fs.unlinkSync(socketPath);
  } catch {
    // 不存在
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://runtime");
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(res, 200, { ok: true, ...broker.summary() });
      }
      if (req.method === "GET" && url.pathname === "/grants") {
        // items 用于崩溃后按 instance_id 对账；聚合值保持原字段不变
        return send(res, 200, { ...broker.summary(), items: broker.grants() });
      }
      if (req.method === "POST" && url.pathname === "/admission/check") {
        const body = await readBody(req);
        return send(res, 200, await broker.check(body as unknown as TaskGrantRequest));
      }
      if (req.method === "POST" && url.pathname === "/admission/release") {
        const body = await readBody(req);
        if (!body.grant_id) throw new AdmissionError(400, "INVALID_GRANT", "缺少 grant_id");
        return send(res, 200, await broker.release(String(body.grant_id)));
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: "没有这个接口" } });
    } catch (e) {
      if (e instanceof AdmissionError) {
        send(res, e.status, { error: { code: e.code, message: e.message } });
      } else {
        console.error("[admission]", e);
        send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      resolve(server);
    });
  });
}
