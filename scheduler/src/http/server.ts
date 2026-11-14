import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { config } from "../config.js";
import { q, q1 } from "../db.js";
import { ApiError } from "../errors.js";
import { assertSelf, requireInstanceAuth, type AuthContext } from "../auth.js";
import { requireScope } from "../jwt.js";
import { claim } from "../core/claim.js";
import { maybeRelayTask, requestRelayCancel } from "../core/relay.js";
import {
  progress,
  renew,
  startAck,
  submitResult,
  type LeaseProof,
  type ResultInput,
} from "../core/attempts.js";
import {
  completeArtifact,
  createArtifact,
  downloadFilename,
  getArtifact,
  listTaskArtifacts,
  putArtifactContent,
  readArtifactContent,
} from "../core/artifacts.js";
import {
  createWorkflowRun,
  decideApproval,
  getWorkflowRun,
  listApprovalRequests,
  listWorkflowRuns,
} from "../core/workflow.js";
import { answerTask, cancelTask, createTask, getTask, listEvents, listTasks, retryTask } from "../repo/tasks.js";
import { splitTask } from "../core/fanout.js";
import { listFailureSignatures } from "../repo/failures.js";
import { latestEventId, listOutbox } from "../repo/outbox.js";
import { upsertHost } from "../repo/hosts.js";
import { capabilitySnapshot, listNodes, upsertNodeReport } from "../repo/federation.js";
import { getFederationParentUrl, setFederationParentUrl } from "../federation-state.js";
import { selfNodeId } from "../node.js";
import {
  deregister,
  drain,
  forget,
  heartbeat,
  listInstances,
  register,
  resume,
  setCapabilities,
  syncConfig,
} from "../repo/instances.js";
import {
  getGrants,
  getInstanceGrantState,
  markGrantApplied,
  markGrantFailed,
} from "../repo/resources.js";

/** Request bodies are untrusted JSON; handlers cast to their input type at this boundary. */
function bodyAs<T>(body: Record<string, unknown>): T {
  return body as unknown as T;
}

type Ctx = {
  params: Record<string, string>;
  body: Record<string, unknown>;
  query: URLSearchParams;
  auth: AuthContext | null;
  headers: http.IncomingHttpHeaders;
};
type AuthMode = "none" | "instance";
type Route = {
  method: string;
  re: RegExp;
  keys: string[];
  handler: (c: Ctx) => Promise<unknown>;
  auth: AuthMode;
  scopes: string[];
};

/** 304 is not an error; pass a sentinel value from the handler back to the HTTP layer */
const NOT_MODIFIED = Symbol("NOT_MODIFIED");

const routes: Route[] = [];
function route(
  method: string,
  pattern: string,
  handler: (c: Ctx) => Promise<unknown>,
  opts: { auth?: AuthMode | boolean; scopes?: string[] } = {},
) {
  const keys: string[] = [];
  const re = new RegExp(
    "^" +
      pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "/?$",
  );
  const auth: AuthMode = opts.auth === true ? "instance" : opts.auth === false ? "none" : (opts.auth ?? "none");
  routes.push({ method, re, keys, handler, auth, scopes: opts.scopes ?? [] });
}

// ---------------- Instances (called by Host Runtime)
route(
  "POST",
  "/v1/instances/register",
  (c) => {
    assertSelf(c.auth, String(c.body.instance_id ?? ""));
    return register(bodyAs(c.body));
  },
  { auth: true, scopes: ["instance:register"] },
);
route(
  "POST",
  "/v1/instances/heartbeat",
  (c) => {
    assertSelf(c.auth, String(c.body.instance_id ?? ""));
    return heartbeat(bodyAs(c.body));
  },
  { auth: true, scopes: ["instance:claim"] },
);
route("GET", "/v1/instances", async () => ({ items: await listInstances() }));

// ---------------- Host roster (periodically synced from the control plane)
// Instance registration requires the host to be in the roster; PCS pushes the roster when a host reports in, and the scheduler never pulls from PCS itself.
route("POST", "/v1/hosts", (c) => upsertHost(bodyAs(c.body)));

// ---------------- Instance lifecycle (§7.3 / §7.10–7.12)
route(
  "PUT",
  "/v1/instances/:id/capabilities",
  (c) => {
    assertSelf(c.auth, c.params.id);
    return setCapabilities(c.params.id, bodyAs(c.body));
  },
  { auth: true, scopes: ["instance:register"] },
);
route(
  "POST",
  "/v1/instances/:id/drain",
  (c) => {
    assertSelf(c.auth, c.params.id);
    return drain(c.params.id, bodyAs(c.body));
  },
  { auth: true, scopes: ["instance:register"] },
);
route(
  "POST",
  "/v1/instances/:id/resume",
  (c) => {
    assertSelf(c.auth, c.params.id);
    return resume(c.params.id);
  },
  { auth: true, scopes: ["instance:register"] },
);
route(
  "POST",
  "/v1/instances/:id/deregister",
  (c) => {
    assertSelf(c.auth, c.params.id);
    return deregister(c.params.id, bodyAs(c.body));
  },
  { auth: true, scopes: ["instance:register"] },
);
// Admin cleanup for a registration left behind after its deployment was deleted. Only dead rows are removable;
// a live instance must be removed through its deployment so the host stops the process first.
route("DELETE", "/v1/instances/:id", (c) => forget(c.params.id));
route(
  "GET",
  "/v1/instances/:id/config",
  async (c) => {
    assertSelf(c.auth, c.params.id);
    const raw = c.query.get("version");
    const version = raw === null ? null : Number(raw);
    if (version !== null && !Number.isFinite(version)) {
      throw new ApiError(400, "BAD_REQUEST", "version must be a number");
    }
    const cfg = await syncConfig(c.params.id, version);
    return cfg ?? NOT_MODIFIED;
  },
  { auth: true, scopes: ["config:read"] },
);

// ---------------- Dynamic resource grants (§7.4 / §10)
// The builder daemon polls its own grant and acks the cgroup generation it actually applied.
route(
  "GET",
  "/v1/instances/:id/grant",
  async (c) => {
    assertSelf(c.auth, c.params.id);
    const state = await getInstanceGrantState(c.params.id);
    if (!state) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${c.params.id}`);
    return state;
  },
  { auth: true, scopes: ["instance:claim"] },
);
route(
  "POST",
  "/v1/instances/:id/grant/applied",
  async (c) => {
    assertSelf(c.auth, c.params.id);
    const state = await getInstanceGrantState(c.params.id);
    if (!state) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${c.params.id}`);
    const generation = Number(c.body?.generation);
    if (!Number.isFinite(generation) || generation <= 0) {
      throw new ApiError(400, "BAD_REQUEST", "generation must be a positive integer");
    }
    const error = typeof c.body?.error === "string" ? c.body.error.trim() : "";
    if (error) {
      await markGrantFailed({
        host_id: state.host_id,
        instance_id: c.params.id,
        generation,
        error,
      });
      return { ok: false, state: "FAILED" };
    }
    const applied = bodyAs<{
      cpu_millicores?: number;
      memory_bytes?: number;
      memory_low_bytes?: number;
      memory_high_bytes?: number;
      cpu_weight?: number;
    }>(c.body);
    return markGrantApplied({
      host_id: state.host_id,
      instance_id: c.params.id,
      generation,
      cpu_millicores: applied.cpu_millicores,
      memory_bytes: applied.memory_bytes,
      memory_low_bytes: applied.memory_low_bytes,
      memory_high_bytes: applied.memory_high_bytes,
      cpu_weight: applied.cpu_weight,
    });
  },
  { auth: true, scopes: ["instance:claim"] },
);
// Host-runtime (host identity, same trust boundary as the host roster push) reads every grant on its host.
route("GET", "/v1/hosts/:id/resource-grants", async (c) => ({
  host_id: c.params.id,
  items: await getGrants(c.params.id),
}));

// ---------------- Claim and execution (Worker protocol)
route(
  "POST",
  "/v1/claim",
  async (c) => {
    assertSelf(c.auth, String(c.body.instance_id ?? ""));
    const a = await claim(bodyAs(c.body));
    if (!a) return { noop: true };
    return a;
  },
  { auth: true, scopes: ["instance:claim"] },
);
const proof = (c: Ctx): LeaseProof =>
  bodyAs<LeaseProof>({ ...c.body, auth_instance_id: c.auth?.instance_id ?? undefined });
route("POST", "/v1/attempts/:id/start-ack", (c) => startAck(c.params.id, proof(c)), {
  auth: true,
  scopes: ["task:report"],
});
route("POST", "/v1/attempts/:id/renew", (c) => renew(c.params.id, proof(c)), {
  auth: true,
  scopes: ["task:report"],
});
route("POST", "/v1/attempts/:id/progress", (c) => progress(c.params.id, proof(c)), {
  auth: true,
  scopes: ["task:report"],
});
route("POST", "/v1/attempts/:id/result", (c) =>
  submitResult(
    c.params.id,
    bodyAs<ResultInput>({ ...c.body, auth_instance_id: c.auth?.instance_id ?? undefined }),
  ), {
  auth: true,
  scopes: ["task:report"],
});

// The lease holder declares children; the scheduler parks the parent and releases the lease.
// Operators answer a parked question through the unauthenticated admin path, like retry/cancel.
route(
  "POST",
  "/v1/tasks/:id/split",
  (c) =>
    splitTask(
      c.params.id,
      proof(c),
      bodyAs<{ children?: Parameters<typeof splitTask>[2] }>(c.body).children ?? [],
    ),
  {
  auth: true,
  scopes: ["task:report"],
});
route("POST", "/v1/tasks/:id/answer", (c) =>
  answerTask(
    c.params.id,
    String(bodyAs<{ answer?: string }>(c.body).answer ?? ""),
    String(c.body.actor ?? "operator"),
  ),
);

// ---------------- Tasks
// After creation, try pushing down: hand tasks this machine cannot handle to a suitable node scheduler in the subtree.
// Relayed-in tasks go through this step too: the parent picked this machine from the subtree instance roster, but the actual holder
// of the instance may be a deeper scheduler, so the task must continue down the tree.
// Push-down failure is only logged; the task stays in the local queue and the submission itself does not fail.
route("POST", "/v1/tasks", async (c) => {
  const input = bodyAs<Parameters<typeof createTask>[0]>(c.body);
  const task = await createTask(input);
  const relayed = await maybeRelayTask(task, input);
  return relayed ? { ...task, relay: relayed } : task;
});
route("GET", "/v1/tasks", async (c) => ({
  items: await listTasks({
    status: c.query.get("status") ?? undefined,
    task_type: c.query.get("task_type") ?? undefined,
    role: c.query.get("role") ?? undefined,
    limit: c.query.get("limit") ? Number(c.query.get("limit")) : undefined,
  }),
}));
// Fleet-wide failure triage: one row per normalized failure, not one per occurrence.
route("GET", "/v1/failure-signatures", async (c) => ({
  items: await listFailureSignatures(c.query.get("limit") ? Number(c.query.get("limit")) : undefined),
}));
route("GET", "/v1/tasks/:id", (c) => getTask(c.params.id));
route("GET", "/v1/tasks/:id/events", async (c) => ({ items: await listEvents(c.params.id) }));

// ---------------- Events (§8.1)
route("GET", "/v1/events", async (c) => {
  const after = Number(c.query.get("after") ?? 0);
  const limit = c.query.get("limit") ? Number(c.query.get("limit")) : undefined;
  if (!Number.isFinite(after) || after < 0) {
    throw new ApiError(400, "BAD_REQUEST", "after must be a non-negative integer");
  }
  const items = await listOutbox(after, limit);
  return { items, next_after: items.length ? Number(items[items.length - 1].event_id) : after };
});
route("POST", "/v1/tasks/:id/cancel", async (c) => {
  const out = await cancelTask(c.params.id, String(c.body.actor ?? "operator"));
  // When a task was pushed down to a child, cancellation must be pushed down too, or the child keeps running.
  await requestRelayCancel(c.params.id);
  return out;
});
route("POST", "/v1/tasks/:id/retry", (c) =>
  retryTask(c.params.id, String(c.body.actor ?? "operator")),
);

// ---------------- Artifacts (§7.8)
route(
  "POST",
  "/v1/artifacts",
  (c) =>
    createArtifact(bodyAs(c.body), c.auth?.instance_id ?? String(c.body.instance_id ?? "")),
  { auth: true, scopes: ["artifact:write"] },
);
route(
  "POST",
  "/v1/artifacts/:id/complete",
  (c) => completeArtifact(c.params.id, c.auth?.instance_id ?? undefined),
  { auth: true, scopes: ["artifact:write"] },
);
route(
  "GET",
  "/v1/artifacts/:id",
  async (c) => {
    const row = await getArtifact(c.params.id);
    assertSelf(c.auth, row.instance_id as string);
    return row;
  },
  { auth: true, scopes: ["artifact:read"] },
);
// Operator-facing file listing. Like the other operator routes it carries no instance credential:
// PCS reaches the scheduler inside the trusted network and gates the caller itself.
route("GET", "/v1/tasks/:id/artifacts", (c) => listTaskArtifacts(c.params.id));

// ---------------- Workflows (§7)
route("POST", "/v1/workflows", (c) => createWorkflowRun(bodyAs(c.body)));
route("GET", "/v1/workflows", async (c) => ({
  items: await listWorkflowRuns(c.query.get("limit") ? Number(c.query.get("limit")) : undefined),
}));
route("GET", "/v1/approvals", async (c) => ({
  items: await listApprovalRequests({
    status: c.query.get("status") ?? undefined,
    limit: c.query.get("limit") ? Number(c.query.get("limit")) : undefined,
  }),
}));
route("GET", "/v1/task-definitions", async () => ({
  items: await q(
    `SELECT task_type, task_version, target_role, capabilities, max_attempts
       FROM task_definitions ORDER BY target_role, task_type`,
  ),
}));
route("GET", "/v1/workflows/:id", (c) => getWorkflowRun(c.params.id));
// Approval decision: the credential is a PCS-issued approval JWT (body.approval_token), verified inside decideApproval.
// No PCS public key → 503; never downgrade to a shared token.
route("POST", "/v1/tasks/:id/approve", (c) =>
  decideApproval(
    bodyAs<Parameters<typeof decideApproval>[0]>({ ...c.body, task_id: c.params.id }),
  ),
);

// ---------------- Capability and federation tree (architecture rules 2/3)
// Local ΣW = local non-offline builders + the entire subtrees reported by all direct children.
route("GET", "/v1/capability", async () => capabilitySnapshot(selfNodeId()));
route("GET", "/v1/nodes", async () => ({
  self: await capabilitySnapshot(selfNodeId()),
  items: await listNodes(),
}));
// Child schedulers report periodically. parent_node_id is always filled by the receiver with itself, so a child cannot forge its attachment point.
route("POST", "/v1/nodes/report", (c) => {
  if (!config.federationToken) {
    throw new ApiError(503, "FEDERATION_DISABLED", "SCHEDULER_FEDERATION_TOKEN is not configured");
  }
  const raw = c.headers["x-federation-token"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (token !== config.federationToken) {
    throw new ApiError(401, "FEDERATION_TOKEN_INVALID", "node report token is invalid");
  }
  return upsertNodeReport(
    bodyAs<Parameters<typeof upsertNodeReport>[0]>({ ...c.body, parent_node_id: selfNodeId(), role: "node" }),
  );
});
// Host join / leave: PCS only changes the parent URL; the scheduler is not restarted.
// The root scheduler has no parent by default; once set here, it starts reporting the whole subtree's ΣW upward on the federation period.
route("GET", "/v1/federation/parent", async () => ({
  parent_url: getFederationParentUrl() || null,
}));
route("POST", "/v1/federation/parent", async (c) => {
  if (!config.federationToken) {
    throw new ApiError(503, "FEDERATION_DISABLED", "SCHEDULER_FEDERATION_TOKEN is not configured");
  }
  const raw = c.headers["x-federation-token"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (token !== config.federationToken) {
    throw new ApiError(401, "FEDERATION_TOKEN_INVALID", "federation token is invalid");
  }
  return { parent_url: setFederationParentUrl(c.body?.parent_url) || null };
});

// ---------------- Operations
route("GET", "/healthz", async () => ({ ok: true }));
route("GET", "/readyz", async () => {
  const db = await q1<{ ok: number }>("SELECT 1 AS ok");
  const migrated = await q1<{ n: number }>(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'tasks'",
  );
  const ready = !!db && migrated?.n === 1;
  if (!ready) throw new ApiError(503, "NOT_READY", "database or schema is not ready");
  return { ready: true };
});
route("GET", "/v1/queue/stats", async () => {
  const byStatus = await q(
    `SELECT status, count(*)::int AS n,
            COALESCE(max(EXTRACT(EPOCH FROM (app_now() - enqueued_at)))::int, 0) AS oldest_wait_s
       FROM tasks GROUP BY status`,
  );
  const instances = await q(
    `SELECT state, count(*)::int AS n FROM role_instances GROUP BY state`,
  );
  const leases = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM leases WHERE released_at IS NULL AND expires_at > app_now()`,
  );
  return { tasks: byStatus, instances, active_leases: leases?.n ?? 0 };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * SSE event stream (§8).
 *
 * It is only a notification channel: loss is allowed and reconnects may resume; the outbox / events API is the source of truth.
 * `Last-Event-ID` or `?after=` sets the starting point; a new connection without one starts from the current latest.
 * Polls within a single control-plane process; with multi-process deployment each process pushes once, and consumers dedupe by event_id.
 */
async function streamEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const header = req.headers["last-event-id"];
  const raw = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("after");
  let cursor = raw !== undefined && raw !== null && raw !== "" ? Number(raw) : await latestEventId();
  if (!Number.isFinite(cursor) || cursor < 0) cursor = await latestEventId();

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`: connected, from ${cursor}\n\n`);

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  let lastPing = Date.now();
  while (!closed) {
    try {
      const items = await listOutbox(cursor, 200);
      for (const e of items) {
        if (closed) break;
        const id = Number(e.event_id);
        res.write(`id: ${id}\nevent: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`);
        cursor = id;
      }
    } catch (err) {
      if (!closed) console.error("[sse]", err);
    }

    if (!closed && Date.now() - lastPing > 15000) {
      res.write(`: ping\n\n`);
      lastPing = Date.now();
    }
    if (!closed) await sleep(500);
  }
  res.end();
}

/** Artifact content is raw bytes, not JSON */
function readRawBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, "PAYLOAD_TOO_LARGE", `request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new ApiError(413, "PAYLOAD_TOO_LARGE", "request body exceeds 2MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new ApiError(400, "BAD_JSON", "request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, payload: unknown, noContent = false) {
  if (noContent) {
    res.writeHead(status);
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

const ADMIN_ORIGINS = (
  process.env.ADMIN_ORIGINS ??
  "http://127.0.0.1:5173,http://localhost:5173,tauri://localhost,http://tauri.localhost"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function createServer(): http.Server | https.Server {
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const started = performance.now();
    const origin = req.headers.origin;
    if (origin && ADMIN_ORIGINS.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
      res.setHeader("access-control-allow-headers", "authorization,content-type,last-event-id");
      res.setHeader("access-control-max-age", "600");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(origin && ADMIN_ORIGINS.includes(origin) ? 204 : 403);
      res.end();
      return;
    }
    try {
      // SSE long connections must write res directly; they cannot use the generic "handler returns JSON" path
      if (req.method === "GET" && url.pathname === "/v1/events/stream") {
        await streamEvents(req, res, url);
        return;
      }

      // Artifact content is raw bytes; bypass JSON parsing
      const contentMatch = /^\/v1\/artifacts\/([^/]+)\/content$/.exec(url.pathname);
      if (contentMatch && req.method === "PUT") {
        const auth = requireInstanceAuth(req);
        if (auth?.kind === "jwt" && auth.claims) requireScope(auth.claims, "artifact:write");
        const data = await readRawBody(req, 64 * 1024 * 1024);
        const out = await putArtifactContent(
          decodeURIComponent(contentMatch[1]),
          data,
          auth?.instance_id ?? undefined,
        );
        send(res, 200, out);
        return;
      }
      if (contentMatch && req.method === "GET") {
        const auth = requireInstanceAuth(req);
        if (auth?.kind === "jwt" && auth.claims) requireScope(auth.claims, "artifact:read");
        const out = await readArtifactContent(
          decodeURIComponent(contentMatch[1]),
          auth?.instance_id ?? undefined,
        );
        res.writeHead(200, {
          "content-type": out.media_type,
          "content-length": String(out.data.length),
          "x-artifact-sha256": out.sha256 ?? "",
          "cache-control": "no-store",
        });
        res.end(out.data);
        return;
      }

      // Operator download: the file channel for task outputs. Same trust boundary as the other
      // operator routes (no instance credential); the caller is authenticated by PCS.
      const downloadMatch = /^\/v1\/artifacts\/([^/]+)\/download$/.exec(url.pathname);
      if (downloadMatch && req.method === "GET") {
        const out = await readArtifactContent(decodeURIComponent(downloadMatch[1]), undefined);
        const filename = downloadFilename(out);
        const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
        res.writeHead(200, {
          "content-type": out.media_type,
          "content-length": String(out.data.length),
          "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "x-artifact-sha256": out.sha256 ?? "",
          "x-artifact-name": encodeURIComponent(filename),
          "cache-control": "no-store",
        });
        res.end(out.data);
        return;
      }

      const matched = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!matched) throw new ApiError(404, "ROUTE_NOT_FOUND", `${req.method} ${url.pathname}`);

      const m = url.pathname.match(matched.re)!;
      const params: Record<string, string> = {};
      matched.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

      const auth = matched.auth === "instance" ? requireInstanceAuth(req) : null;
      if (auth?.kind === "jwt" && auth.claims) {
        for (const scope of matched.scopes) requireScope(auth.claims, scope);
      }

      const body = req.method === "GET" ? {} : await readBody(req);
      const out = await matched.handler({
        params,
        body,
        query: url.searchParams,
        auth,
        headers: req.headers,
      });

      if (out === NOT_MODIFIED) {
        res.writeHead(304);
        res.end();
      } else if (out && typeof out === "object" && (out as { noop?: unknown }).noop) {
        // No claim candidates → 204, letting the Worker back off at its own pace
        send(res, 204, null, true);
      } else {
        send(res, 200, out);
      }
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError(500, "INTERNAL", e instanceof Error ? e.message : String(e));
      if (err.status >= 500) console.error("[5xx]", err.code, err.message);
      send(res, err.status, {
        error: { code: err.code, message: err.message, detail: err.detail ?? null },
      });
    } finally {
      const ms = (performance.now() - started).toFixed(1);
      if (url.pathname !== "/healthz") {
        console.log(`${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
      }
    }
  };

  if (!config.tlsCertFile) return http.createServer(handler);

  const options: https.ServerOptions = {
    cert: fs.readFileSync(config.tlsCertFile),
    key: fs.readFileSync(config.tlsKeyFile),
  };
  if (config.tlsCaFile) options.ca = fs.readFileSync(config.tlsCaFile);
  if (config.mtls) {
    // Role instances / Workers must present a client certificate issued by the internal CA; JWT is still verified separately.
    options.requestCert = true;
    options.rejectUnauthorized = true;
  }
  return https.createServer(options, handler);
}
