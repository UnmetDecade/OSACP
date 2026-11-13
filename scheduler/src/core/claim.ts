import { tx, type Client } from "../db.js";
import { ApiError } from "../errors.js";
import { appendEvent } from "../events.js";
import { newId, newToken } from "../ids.js";
import { admissionAllowedByPressure, backoffSeconds, computeConcurrency } from "./resources.js";
import {
  instanceResourceState,
  policyForScheduler,
  recomputeHostGrants,
  type ResourceGrantRow,
} from "../repo/resources.js";

/**
 * Claim: eligibility filtering + admission + lease creation, all in one transaction (§3.4).
 * Never "return the task first, check resources later".
 */

export interface ClaimInput {
  instance_id: string;
  trace_id?: string;
}

export interface AssignmentGrant {
  generation: number;
  state: string;
  cpu_millicores: number;
  memory_bytes: number;
  memory_low_bytes: number;
  memory_high_bytes: number;
  cpu_weight: number;
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
  /** Task difficulty; builders may use it to choose an execution strategy */
  difficulty: number;
  /** Task requirements and workflow handoff info (e.g. upstream_artifacts) */
  requirements: Record<string, unknown>;
  /** Autonomy level the adapter maps onto the driver's permission flags; null means the driver default. */
  approval_mode: string | null;
  /** P4: send only Profile references, never implementations or secrets */
  agent: { profile_id: string | null; version: string | null };
  api_profiles: string[];
  started: false;
  /** Dynamic mode: the builder must apply this grant before starting the workload (§7.4). */
  scheduling_mode: "static" | "dynamic";
  resource_grant: AssignmentGrant | null;
}

async function loadConfig(c: Client) {
  const res = await c.query("SELECT * FROM scheduler_config WHERE id = TRUE");
  return res.rows[0];
}

/** Active lease count: only unreleased, unexpired leases */
async function countActive(
  c: Client,
  sql: string,
  params: unknown[],
): Promise<number> {
  const res = await c.query(sql, params);
  return res.rows[0].n as number;
}

interface Blocked {
  reason:
    | "INSUFFICIENT_MEMORY"
    | "INSUFFICIENT_CPU"
    | "CPU_PRESSURE_HIGH"
    | "HOST_PRESSURE"
    | "DISK_SPACE_LOW"
    | "CONCURRENCY_LIMIT"
    | "HOST_PROTECTING"
    | "GRANT_PENDING"
    | "GRANT_FAILED"
    | "CGROUP_UNAVAILABLE";
  detail: Record<string, unknown>;
  /**
   * `halt` = the whole instance/host cannot take any task right now (pressure, quota not applied,
   * global/role saturation). Do not penalize the task; stop scanning.
   * `permanent` = even an empty instance could not fit this task, so repeated blocks make it
   * unschedulable instead of letting it churn forever.
   */
  halt?: boolean;
  permanent?: boolean;
}

interface AdmissionContext {
  cfg: any;
  inst: any;
  host: any;
  mode: "static" | "dynamic";
  res: Awaited<ReturnType<typeof instanceResourceState>> | null;
  policy: ReturnType<typeof policyForScheduler>;
}

const dynamicScoreOf = (inst: any): number => {
  const dispatch = Number(inst.capability_dispatch_score ?? 0);
  if (dispatch > 0) return dispatch;
  const live = Number(inst.capability_live_score ?? 0);
  if (live > 0) return live;
  return Number(inst.capability_score ?? 0);
};

/**
 * How long a weaker builder yields a task to a stronger idle builder before taking it itself.
 *
 * Local execution is pull-based: every idle instance polls for work and the first poller wins the
 * race. That alone would let a 148-score builder take a task while a 286-score builder sits idle,
 * simply because the weaker host happened to poll first. Preference is expressed here as a bounded
 * deferral: while the task is young, a weaker instance refuses it when a strictly higher-capability
 * peer is ONLINE and completely idle, so the stronger peer can claim it on its next poll. The
 * window bounds the damage if the stronger peer is online but not actually polling (a hung agent
 * or a stopped runtime): after it elapses the task goes to whoever can run it.
 */
const CAPABILITY_PREFER_WINDOW_SECONDS = 30;

interface IdlePeer {
  row: any;
  score: number;
}

/** ONLINE, bound to an Agent Profile, on a dispatchable host, and currently running nothing. */
async function loadIdlePeers(c: Client, inst: any): Promise<IdlePeer[]> {
  const rows = (
    await c.query(
      `SELECT p.*
         FROM role_instances p
         JOIN hosts h ON h.host_id = p.host_id
        WHERE p.role_id = $1
          AND p.instance_id <> $2
          AND p.state = 'ONLINE'
          AND p.agent_profile_id IS NOT NULL
          AND h.host_state IN ('NORMAL','WARNING')
          AND NOT EXISTS (
            SELECT 1 FROM leases l
             WHERE l.instance_id = p.instance_id
               AND l.released_at IS NULL AND l.expires_at > app_now()
          )`,
      [inst.role_id, inst.instance_id],
    )
  ).rows;
  return rows.map((row: any) => ({ row, score: dynamicScoreOf(row) }));
}

/** Whether an idle peer would be allowed to take this task at all. */
function peerCanTakeTask(p: any, task: any): boolean {
  if (!(p.allowed_task_types ?? []).includes(task.task_type)) return false;
  if (!(p.payload_schemas ?? []).includes(task.payload_schema)) return false;
  const target = task.requirements?.target_instance_id;
  if (target && target !== p.instance_id) return false;
  const needed = (task.requirements?.capabilities ?? []) as string[];
  const healthy = (p.capabilities?.healthy ?? []) as string[];
  const unhealthy = (p.capabilities?.unhealthy ?? []) as string[];
  if (needed.some((x) => !healthy.includes(x) || unhealthy.includes(x))) return false;
  const score = dynamicScoreOf(p);
  // W=0 means the peer never reported a score (pre-upgrade); it cannot prove it fits the task.
  if (score > 0 && Number(task.difficulty ?? 0) > score) return false;
  return true;
}

export async function claim(input: ClaimInput): Promise<Assignment | null> {
  if (!input.instance_id) throw new ApiError(400, "BAD_REQUEST", "instance_id is required");

  return tx(async (c) => {
    const cfg = await loadConfig(c);
    const policy = policyForScheduler(cfg?.dynamic_policy);

    // Read the owner first (unlocked), then lock in host -> instance order. The allocator also
    // locks host before touching instances, so claim and grant recomputation cannot deadlock.
    const owner = (
      await c.query(`SELECT host_id FROM role_instances WHERE instance_id = $1`, [input.instance_id])
    ).rows[0];
    if (!owner) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${input.instance_id}`);

    // Lock the host row: concurrent claims on one host serialize, making the budget trustworthy
    const hostRes = await c.query(
      `SELECT * FROM hosts WHERE host_id = $1 FOR NO KEY UPDATE`,
      [owner.host_id],
    );
    const host = hostRes.rows[0];
    if (!host) throw new ApiError(409, "HOST_UNKNOWN", `host not registered: ${owner.host_id}`);

    // Lock the instance row: concurrent claims for one instance serialize, so one instance cannot take multiple tasks
    const instRes = await c.query(
      `SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`,
      [input.instance_id],
    );
    const inst = instRes.rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${input.instance_id}`);
    if (inst.host_id !== host.host_id) {
      throw new ApiError(409, "HOST_CHANGED", `host of instance ${inst.instance_id} has changed to ${inst.host_id}`);
    }
    if (inst.state !== "ONLINE") {
      throw new ApiError(409, "INSTANCE_NOT_ELIGIBLE", `instance state is ${inst.state}; only ONLINE instances can claim`);
    }
    if (!inst.agent_profile_id) {
      throw new ApiError(409, "INSTANCE_NOT_ELIGIBLE", "instance is not bound to an Agent Profile");
    }

    // Host state: only NORMAL / WARNING may receive dispatches; THROTTLED / PROTECTING / RECOVERING are all excluded
    if (host.host_state !== "NORMAL" && host.host_state !== "WARNING") {
      throw new ApiError(409, "HOST_NOT_ELIGIBLE", `host ${host.host_id} is in state ${host.host_state}; dispatching paused`);
    }

    const mode: "static" | "dynamic" = inst.scheduling_mode === "dynamic" ? "dynamic" : "static";

    // Static mode keeps the frozen per-instance limit (§9.1). Dynamic mode replaces it with the
    // per-task-type k(i, τ) check inside admit(), so a fixed limit here would make k unreachable.
    if (mode === "static") {
      const instanceActive = await countActive(
        c,
        `SELECT count(*)::int AS n FROM leases
          WHERE instance_id = $1 AND released_at IS NULL AND expires_at > app_now()`,
        [inst.instance_id],
      );
      if (instanceActive >= cfg.instance_limit) {
        return null; // Instance is full: create no lease and record no blocking reason (not the task's fault)
      }
    }

    let res = mode === "dynamic" ? await instanceResourceState(c, inst.instance_id) : null;
    // A freshly deployed dynamic builder has no grant row yet: derive one now so its first claim
    // does not wait for the periodic allocator. Later claims use the already computed grant.
    if (mode === "dynamic" && !res?.grant) {
      await recomputeHostGrants(c, host.host_id, policy);
      res = await instanceResourceState(c, inst.instance_id);
    }

    // Global / role-pool saturation is not any single task's fault; return without scanning.
    const globalActive = await countActive(
      c,
      `SELECT count(*)::int AS n FROM leases WHERE released_at IS NULL AND expires_at > app_now()`,
      [],
    );
    if (globalActive >= cfg.global_limit) return null;
    const roleActive = await countActive(
      c,
      `SELECT count(*)::int AS n
         FROM leases l JOIN role_instances i USING (instance_id)
        WHERE i.role_id = $1 AND l.released_at IS NULL AND l.expires_at > app_now()`,
      [inst.role_id],
    );
    if (roleActive >= cfg.role_pool_limit) return null;

    const capabilities = (inst.capabilities?.healthy ?? []) as string[];
    const unhealthy = (inst.capabilities?.unhealthy ?? []) as string[];
    const usable = capabilities.filter((x) => !unhealthy.includes(x));
    // W=0 means "capability score not reported" (pre-upgrade instances): do not filter by difficulty, preserving old behavior.
    // Local claims use capability_live in dynamic mode; cross-node routing is handled in relay.ts.
    const capabilityScore = mode === "dynamic" ? dynamicScoreOf(inst) : Number(inst.capability_score ?? 0);

    const maxScan = Math.max(1, Number(cfg.max_candidate_scan ?? 20));
    const candidateSql = `
      SELECT t.*,
             effective_priority(t.priority_class, t.enqueued_at, $1) AS effective_priority,
             EXTRACT(EPOCH FROM (app_now() - t.enqueued_at))::int AS waited_seconds
        FROM tasks t
        JOIN task_definitions td ON td.task_type = t.task_type
       WHERE t.status = 'QUEUED'
         -- Tasks already pushed down to child nodes stay QUEUED locally for results, but must not be claimed locally.
         AND NOT EXISTS (
           SELECT 1 FROM task_relays r
            WHERE r.parent_task_id = t.task_id AND r.state = 'ACTIVE'
         )
         AND t.unschedulable = FALSE
         AND (t.resource_retry_after IS NULL OR t.resource_retry_after <= app_now())
         AND td.target_role = $2
         AND t.task_type = ANY($3::text[])
         AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= app_now())
         AND COALESCE(t.requirements->'capabilities', '[]'::jsonb) <@ $4::jsonb
         AND t.payload_schema = ANY($5::text[])
         AND (
           t.requirements->>'target_instance_id' IS NULL
           OR t.requirements->>'target_instance_id' = $6
         )
         AND ($7 <= 0 OR t.difficulty <= $7)
       ORDER BY effective_priority ASC, t.enqueued_at ASC, t.task_id ASC
       FOR UPDATE OF t SKIP LOCKED
       LIMIT $8`;

    const cand = await c.query(candidateSql, [
      cfg.aging_after_seconds,
      inst.role_id,
      inst.allowed_task_types,
      JSON.stringify(usable),
      inst.payload_schemas,
      inst.instance_id,
      capabilityScore,
      maxScan,
    ]);

    const ctx: AdmissionContext = { cfg, inst, host, mode, res, policy };
    // Idle peers are only needed once a candidate passes admission; load them lazily so a claim
    // that finds nothing to run does not pay for the extra queries.
    let idlePeers: IdlePeer[] | null = null;
    const strongerIdlePeer = async (task: any): Promise<boolean> => {
      if (Number(task.waited_seconds ?? 0) >= CAPABILITY_PREFER_WINDOW_SECONDS) return false;
      idlePeers ??= await loadIdlePeers(c, inst);
      return idlePeers.some((p) => p.score > capabilityScore && peerCanTakeTask(p.row, task));
    };
    for (const task of cand.rows) {
      const blocked = await admit(c, ctx, task);
      if (blocked) {
        // Host/instance-wide blocks apply to every candidate: stop without touching the task.
        if (blocked.halt) return null;
        await recordBlock(c, task, blocked, cfg, input.trace_id);
        continue;
      }
      // Capability preference: leave the task for a better-equipped idle builder. No task state is
      // touched — it stays QUEUED and the peer claims it on its next poll, or this instance takes it
      // once the deferral window expires.
      if (await strongerIdlePeer(task)) continue;
      const assignment = await assign(c, cfg, inst, host, task, input.trace_id, mode, res?.grant ?? null);
      // The new reservation changes demand; refresh this host's ledger now so the next claim and
      // the daemon see a grant that covers it instead of waiting for the periodic allocator.
      // The assignment carries the refreshed grant, not the pre-reservation one.
      if (mode === "dynamic") {
        await recomputeHostGrants(c, host.host_id, policy);
        const fresh = await instanceResourceState(c, inst.instance_id);
        if (fresh?.grant) {
          assignment.resource_grant = {
            generation: fresh.grant.generation,
            state: fresh.grant.state,
            cpu_millicores: fresh.grant.cpu_millicores,
            memory_bytes: fresh.grant.memory_bytes,
            memory_low_bytes: fresh.grant.memory_low_bytes,
            memory_high_bytes: fresh.grant.memory_high_bytes,
            cpu_weight: fresh.grant.cpu_weight,
          };
        }
      }
      return assignment;
    }

    return null;
  });
}

/** Persist the task-level block with exponential backoff (§11.3). */
async function recordBlock(
  c: Client,
  task: any,
  blocked: Blocked,
  cfg: any,
  traceId?: string,
): Promise<void> {
  const attempts = Number(task.blocked_attempts ?? 0) + 1;
  const delay = backoffSeconds(
    attempts - 1,
    Number(cfg.backoff_base_seconds ?? 1),
    Number(cfg.backoff_max_seconds ?? 60),
  );
  const unschedulable =
    blocked.permanent === true && attempts >= Number(cfg.max_blocked_attempts ?? 8);
  const reasonChanged = task.resource_block_reason !== blocked.reason;
  await c.query(
    `UPDATE tasks
        SET resource_block_reason = $2,
            resource_evaluated_at = app_now(),
            blocked_attempts = $3,
            resource_retry_after = app_now() + make_interval(secs => $4),
            unschedulable = $5,
            version = version + 1,
            updated_at = app_now()
      WHERE task_id = $1`,
    [task.task_id, blocked.reason, attempts, delay, unschedulable],
  );
  if (reasonChanged || unschedulable) {
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: unschedulable ? "TASK_UNSCHEDULABLE" : "TASK_RESOURCE_BLOCKED",
      from_status: "QUEUED",
      to_status: "QUEUED",
      actor: "scheduler",
      payload: {
        reason: blocked.reason,
        detail: blocked.detail,
        blocked_attempts: attempts,
        retry_after_seconds: delay,
        unschedulable,
      },
      trace_id: traceId,
    });
  }
}

/** Admission check (§6.2, §9.1). Returns null when it passes. */
async function admit(
  c: Client,
  ctx: AdmissionContext,
  task: any,
): Promise<Blocked | null> {
  const { cfg, inst, host, mode, res, policy } = ctx;

  // Per-task-type limit across the fleet. A different type may still fit, so keep scanning.
  const typeActive = await countActive(
    c,
    `SELECT count(*)::int AS n
       FROM leases l JOIN tasks t USING (task_id)
      WHERE t.task_type = $1 AND l.released_at IS NULL AND l.expires_at > app_now()`,
    [task.task_type],
  );
  if (typeActive >= cfg.task_type_limit) {
    return {
      reason: "CONCURRENCY_LIMIT",
      detail: { scope: "task_type", limit: cfg.task_type_limit },
    };
  }

  const profile = (
    await c.query(`SELECT * FROM resource_profiles WHERE profile_id = $1`, [task.resource_profile_id])
  ).rows[0];
  if (!profile) {
    return {
      reason: "INSUFFICIENT_MEMORY",
      detail: { why: "resource profile not found", profile: task.resource_profile_id },
    };
  }

  const needMem = BigInt(profile.memory_bytes);
  const needCpu = Math.max(0, Math.trunc(Number(profile.cpu_millicores ?? 0)));

  if (mode === "dynamic") {
    const pool = res?.pool ?? null;
    // A dynamic builder must be able to enforce its grant through a cgroup pool. Before the first
    // report we allow a cap-shaped budget so the deployment can become reachable; after a report
    // that says "no cgroup v2", scheduling stops with an explicit reason instead of pretending.
    if (pool?.reported_at && !pool.cgroup_available) {
      return {
        reason: "CGROUP_UNAVAILABLE",
        detail: { host: host.host_id, pool_id: pool.pool_id, driver: pool.cgroup_driver },
        halt: true,
      };
    }
    if (!admissionAllowedByPressure(pool?.pressure_state ?? "NORMAL")) {
      return {
        reason: "HOST_PRESSURE",
        detail: {
          host: host.host_id,
          pressure_state: pool?.pressure_state,
          mem_used_bytes: pool?.mem_used_bytes,
          cpu_used_millicores: pool?.cpu_used_millicores,
        },
        halt: true,
      };
    }
    const grant = res?.grant ?? null;
    if (!grant) {
      return {
        reason: "GRANT_PENDING",
        detail: { host: host.host_id, instance: inst.instance_id },
        halt: true,
      };
    }
    if (grant.state === "FAILED") {
      return {
        reason: "GRANT_FAILED",
        detail: { host: host.host_id, instance: inst.instance_id, error: grant.last_error },
        halt: true,
      };
    }
    // §9.2 step 9: a dynamic builder may start only after its quota is applied to the cgroup.
    // The host applies grants every few seconds and reports the applied generation back, so this
    // is a short wait after a deployment; if the daemon never reports, execution is refused
    // rather than run without an enforced cap. `require_applied_before_start` can be turned off
    // for hosts whose runtime predates cgroup support.
    if (policy.require_applied_before_start) {
      const applied = Number(grant.applied_generation ?? 0);
      if (grant.state !== "APPLIED" || applied < grant.generation) {
        return {
          reason: "GRANT_PENDING",
          detail: {
            host: host.host_id,
            instance: inst.instance_id,
            generation: grant.generation,
            state: grant.state,
            applied_generation: grant.applied_generation,
          },
          halt: true,
        };
      }
    }

    // §8.4: once the grant has been squeezed below what is already committed, the instance is
    // OVERCOMMITTED and takes no new work until reservations fall or the allocator catches up.
    const reservedMem = Number(res?.reservedMemBytes ?? 0);
    const reservedCpu = Number(res?.reservedCpuMillicores ?? 0);
    if (Number(grant.memory_bytes) < reservedMem || Number(grant.cpu_millicores) < reservedCpu) {
      return {
        reason: "INSUFFICIENT_MEMORY",
        detail: {
          scope: "instance_overcommitted",
          host: host.host_id,
          instance: inst.instance_id,
          grant_bytes: grant.memory_bytes,
          grant_millicores: grant.cpu_millicores,
          reserved_bytes: reservedMem,
          reserved_millicores: reservedCpu,
          grant_generation: grant.generation,
        },
        halt: true,
      };
    }

    // Admission may commit up to the guaranteed share F_i even while an idle builder's grant is
    // only the idle floor; the grant covering the reservation is computed right after the claim.
    const budgetMem = Math.min(
      Number(inst.cap_mem_bytes || Number.MAX_SAFE_INTEGER),
      Math.max(Number(grant.memory_bytes), Number(res?.fairShareMemBytes ?? 0)),
    );
    const budgetCpu = Math.min(
      Number(inst.cap_cpu_millicores || Number.MAX_SAFE_INTEGER),
      Math.max(Number(grant.cpu_millicores), Number(res?.fairShareCpuMillicores ?? 0)),
    );
    const remainingMem = Math.max(0, budgetMem - reservedMem);
    const remainingCpu = Math.max(0, budgetCpu - reservedCpu);
    const needMemNum = Number(needMem);

    if (needMemNum > remainingMem) {
      return {
        reason: "INSUFFICIENT_MEMORY",
        detail: {
          scope: "instance_grant",
          host: host.host_id,
          instance: inst.instance_id,
          grant_bytes: grant.memory_bytes,
          grant_generation: grant.generation,
          grant_state: grant.state,
          reserved_bytes: res?.reservedMemBytes ?? 0,
          remaining_bytes: remainingMem,
          requested_bytes: needMemNum,
        },
        permanent: needMemNum > Number(inst.cap_mem_bytes || Number.MAX_SAFE_INTEGER),
      };
    }
    if (needCpu > remainingCpu) {
      return {
        reason: "INSUFFICIENT_CPU",
        detail: {
          scope: "instance_grant",
          host: host.host_id,
          instance: inst.instance_id,
          grant_millicores: grant.cpu_millicores,
          grant_generation: grant.generation,
          reserved_millicores: res?.reservedCpuMillicores ?? 0,
          remaining_millicores: remainingCpu,
          requested_millicores: needCpu,
        },
        permanent: needCpu > Number(inst.cap_cpu_millicores || Number.MAX_SAFE_INTEGER),
      };
    }

    // k(i, τ) §9.1: per-type concurrency is bounded by the type cap and by the remaining grant.
    const kMax = Math.max(1, Number(cfg.task_type_instance_limit ?? 4));
    const typeOnInstance = await countActive(
      c,
      `SELECT count(*)::int AS n
         FROM leases l JOIN tasks t USING (task_id)
        WHERE l.instance_id = $1 AND t.task_type = $2
          AND l.released_at IS NULL AND l.expires_at > app_now()`,
      [inst.instance_id, task.task_type],
    );
    if (typeOnInstance >= kMax) {
      return {
        reason: "CONCURRENCY_LIMIT",
        detail: { scope: "instance_task_type", limit: kMax, active: typeOnInstance },
      };
    }
    const k = computeConcurrency({
      remainingCpuMillicores: remainingCpu,
      remainingMemBytes: remainingMem,
      requestCpuMillicores: needCpu,
      requestMemBytes: needMemNum,
      kMax,
    });
    if (k < 1) {
      return {
        reason: needMemNum > remainingMem ? "INSUFFICIENT_MEMORY" : "INSUFFICIENT_CPU",
        detail: {
          scope: "instance_grant",
          k,
          grant_generation: grant.generation,
          remaining_millicores: remainingCpu,
          remaining_bytes: remainingMem,
        },
      };
    }
    return null;
  }

  // Static mode keeps the existing deploy-time memory budget check.
  const used = (
    await c.query(
      `SELECT COALESCE(SUM(memory_bytes),0)::bigint AS mem,
              COALESCE(SUM(cpu_millicores),0)::bigint AS cpu
         FROM resource_reservations
        WHERE host_id = $1 AND state IN ('HELD','ACTIVE')`,
      [host.host_id],
    )
  ).rows[0];

  const usedMem = BigInt(used.mem);
  if (usedMem + needMem > BigInt(host.mem_available_bytes)) {
    return {
      reason: "INSUFFICIENT_MEMORY",
      detail: {
        host: host.host_id,
        available_bytes: host.mem_available_bytes.toString(),
        reserved_bytes: usedMem.toString(),
        requested_bytes: needMem.toString(),
      },
      permanent: needMem > BigInt(host.mem_available_bytes),
    };
  }
  return null;
}

async function assign(
  c: Client,
  cfg: any,
  inst: any,
  host: any,
  task: any,
  traceId: string | undefined,
  mode: "static" | "dynamic",
  grant: ResourceGrantRow | null,
): Promise<Assignment> {
  // attempt_number is max(existing attempt) + 1, not attempt_count + 1.
  // A rejected admission rolls attempt_count back (no retry consumed), but the attempt row must be kept;
  // deriving it from attempt_count would reuse the same number on the next claim and hit the unique constraint.
  const attemptNumber = Number(
    (
      await c.query(
        `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n
           FROM task_attempts WHERE task_id = $1`,
        [task.task_id],
      )
    ).rows[0].n,
  );
  const attemptId = newId("att");
  const leaseToken = newToken();
  const grantId = newId("rgr");

  // fencing increments per attempt; the task row is already locked FOR UPDATE by the candidate query
  const fencing = Number(
    (
      await c.query(
        `SELECT COALESCE(MAX(fencing_token), 0) + 1 AS f FROM leases WHERE task_id = $1`,
        [task.task_id],
      )
    ).rows[0].f,
  );

  const profile = (
    await c.query(`SELECT * FROM resource_profiles WHERE profile_id = $1`, [task.resource_profile_id])
  ).rows[0];

  await c.query(
    `INSERT INTO task_attempts (attempt_id, task_id, attempt_number, instance_id, host_id,
                                agent_profile_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,'CREATED')`,
    [attemptId, task.task_id, attemptNumber, inst.instance_id, host.host_id, inst.agent_profile_id],
  );

  const lease = (
    await c.query(
      `INSERT INTO leases (lease_token, task_id, attempt_id, instance_id, fencing_token, issued_at, expires_at)
       VALUES ($1,$2,$3,$4,$5, app_now(), app_now() + make_interval(secs => $6))
       RETURNING lease_token, expires_at`,
      [leaseToken, task.task_id, attemptId, inst.instance_id, fencing, cfg.lease_seconds],
    )
  ).rows[0];

  await c.query(
    `INSERT INTO resource_reservations
       (grant_id, host_id, instance_id, task_id, attempt_id, profile_id, kind, state,
        cpu_millicores, memory_bytes, disk_bytes)
     VALUES ($1,$2,$3,$4,$5,$6,'TASK','HELD',$7,$8,$9)`,
    [
      grantId,
      host.host_id,
      inst.instance_id,
      task.task_id,
      attemptId,
      profile.profile_id,
      profile.cpu_millicores,
      profile.memory_bytes,
      profile.disk_bytes,
    ],
  );

  const updated = await c.query(
    `UPDATE tasks
        SET status = 'ASSIGNED',
            attempt_count = attempt_count + 1,
            current_attempt_id = $2,
            resource_block_reason = NULL,
            resource_evaluated_at = NULL,
            resource_retry_after = NULL,
            blocked_attempts = 0,
            unschedulable = FALSE,
            version = version + 1,
            updated_at = app_now()
      WHERE task_id = $1
      RETURNING *`,
    [task.task_id, attemptId],
  );

  // Aging must be recorded to explain "why this one was claimed first" (§3.5)
  if (task.effective_priority < task.priority_class) {
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: "TASK_AGED",
      from_status: "QUEUED",
      to_status: "QUEUED",
      actor: "scheduler",
      payload: {
        priority_class: task.priority_class,
        effective_priority: task.effective_priority,
        waited_seconds: task.waited_seconds,
      },
      trace_id: traceId,
    });
  }

  await appendEvent(c, {
    task_id: task.task_id,
    event_type: "TASK_ASSIGNED",
    from_status: "QUEUED",
    to_status: "ASSIGNED",
    actor: inst.instance_id,
    payload: {
      attempt_id: attemptId,
      attempt_number: attemptNumber,
      fencing_token: fencing,
      host_id: host.host_id,
      grant_id: grantId,
      capability_score: Number(inst.capability_score ?? 0),
      scheduling_mode: mode,
      grant_generation: grant?.generation ?? null,
      difficulty: Number(task.difficulty ?? 0),
    },
    trace_id: traceId,
  });

  const t = updated.rows[0];
  return {
    task_id: t.task_id,
    task_type: t.task_type,
    attempt_id: attemptId,
    attempt_number: attemptNumber,
    lease_token: lease.lease_token,
    fencing_token: fencing,
    lease_expires_at: lease.expires_at,
    grant_id: grantId,
    payload_ref: t.payload_ref,
    payload_schema: t.payload_schema,
    resource_profile_id: t.resource_profile_id,
    deadline_at: t.deadline_at,
    difficulty: Number(t.difficulty ?? 0),
    requirements: t.requirements ?? {},
    approval_mode: t.approval_mode ?? null,
    // P4: send only references, never implementations, API addresses or secrets; the instance validates against its locally loaded Profile
    agent: {
      profile_id: inst.agent_profile_id,
      version: inst.agent_profile_version ?? null,
    },
    api_profiles: inst.api_profile_ids ?? [],
    started: false,
    scheduling_mode: mode,
    resource_grant: grant
      ? {
          generation: grant.generation,
          state: grant.state,
          cpu_millicores: grant.cpu_millicores,
          memory_bytes: grant.memory_bytes,
          memory_low_bytes: grant.memory_low_bytes,
          memory_high_bytes: grant.memory_high_bytes,
          cpu_weight: grant.cpu_weight,
        }
      : null,
  };
}
