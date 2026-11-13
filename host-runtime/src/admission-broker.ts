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
 * Local second-stage admission. Check + reserve run serially on the same promise chain,
 * so two tasks can never see the same available memory at once.
 *
 * This prevents oversubscription; it is not a second scheduler: it does not pick tasks or change task state, only answers "does it fit right now".
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
   * replaceInstance: when redeploying the same instance, the old container's reservation is taken over by the new container,
   * so it must not block the new deployment, or a rolling redeploy of the same instance would never pass admission.
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
        throw new AdmissionError(400, "INVALID_GRANT", "grant_id must be issued by the control plane (rgr_ prefix)");
      }
      if (req.kind !== "TASK") {
        throw new AdmissionError(400, "INVALID_GRANT_KIND", "Only TASK grants are accepted");
      }
      if (!req.instance_id || !req.task_id || !req.attempt_id) {
        throw new AdmissionError(400, "INVALID_GRANT", "Missing instance_id / task_id / attempt_id");
      }
      const memory = Number(req.resources?.memory_bytes);
      if (!Number.isFinite(memory) || memory <= 0) {
        throw new AdmissionError(400, "INVALID_RESOURCES", "memory_bytes must be a positive number");
      }
      if (memory > this.cfg.max_task_grant_bytes) {
        throw new AdmissionError(
          400,
          "RESOURCE_REQUEST_TOO_LARGE",
          `Single-task request exceeds the limit of ${this.cfg.max_task_grant_bytes} bytes`,
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
          throw new AdmissionError(409, "GRANT_CONFLICT", "The same grant_id cannot be used for a different attempt");
        }
        return existing.result;
      }

      // Tasks run within the instance's own budget: this instance's DEPLOYMENT grant is the ceiling,
      // so it must not be deducted again as another separate reservation, or a native builder's first task would never fit.
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

  /** DEPLOYMENT grant before starting a container: a long-lived reservation that disappears from the list once the container stops/is removed. */
  checkDeployment(grantId: string, instanceId: string, memoryBytes: number): Promise<AdmissionResult> {
    return this.serialize(() => {
      if (!grantId.startsWith("rgr_")) {
        throw new AdmissionError(400, "INVALID_GRANT", "grant_id must be issued by the control plane");
      }
      const now = this.now();
      this.reap(now);
      const existing = this.deploymentGrants.get(grantId);
      // Redeploy of the same instance: the old container's reservation does not count, since this deployment replaces it.
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

  /** The reconciler rebuilds deployment reservations from actually running containers, avoiding double-counting or leaks. */
  setDeploymentGrants(grants: Array<{ grant_id: string; instance_id: string; memory_bytes: number }>): void {
    this.deploymentGrants.clear();
    for (const g of grants) this.deploymentGrants.set(g.grant_id, {
      instance_id: g.instance_id,
      memory_bytes: g.memory_bytes,
    });
  }

  /** List ACTIVE task grants: after a crash, role instances reconcile and release them by instance_id. */
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
        reject(new AdmissionError(413, "BODY_TOO_LARGE", "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new AdmissionError(400, "INVALID_JSON", "Request body is not JSON"));
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

/** Listens only on a unix socket (0600), never on any network address. */
export function startAdmissionServer(
  broker: AdmissionBroker,
  socketPath: string,
): Promise<http.Server> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    const st = fs.lstatSync(socketPath);
    if (st.isSocket()) fs.unlinkSync(socketPath);
  } catch {
    // Does not exist
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://runtime");
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(res, 200, { ok: true, ...broker.summary() });
      }
      if (req.method === "GET" && url.pathname === "/grants") {
        // items is used to reconcile by instance_id after a crash; the aggregate values keep their original fields unchanged
        return send(res, 200, { ...broker.summary(), items: broker.grants() });
      }
      if (req.method === "POST" && url.pathname === "/admission/check") {
        const body = await readBody(req);
        return send(res, 200, await broker.check(body as unknown as TaskGrantRequest));
      }
      if (req.method === "POST" && url.pathname === "/admission/release") {
        const body = await readBody(req);
        if (!body.grant_id) throw new AdmissionError(400, "INVALID_GRANT", "Missing grant_id");
        return send(res, 200, await broker.release(String(body.grant_id)));
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: "No such endpoint" } });
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
