import { tx, type Client } from "../db.js";
import { ApiError } from "../errors.js";
import { appendEvent } from "../events.js";
import { newId, newToken } from "../ids.js";

/**
 * Claim: eligibility filtering + admission + lease creation, all in one transaction (§3.4).
 * Never "return the task first, check resources later".
 */

export interface ClaimInput {
  instance_id: string;
  trace_id?: string;
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
  /** P4: send only Profile references, never implementations or secrets */
  agent: { profile_id: string | null; version: string | null };
  api_profiles: string[];
  started: false;
}

const MAX_CANDIDATE_SCAN = 20;

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

export async function claim(input: ClaimInput): Promise<Assignment | null> {
  if (!input.instance_id) throw new ApiError(400, "BAD_REQUEST", "instance_id 必填");

  return tx(async (c) => {
    const cfg = await loadConfig(c);

    // Lock the instance row: concurrent claims for one instance serialize, so one instance cannot take multiple tasks
    const instRes = await c.query(
      `SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`,
      [input.instance_id],
    );
    const inst = instRes.rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `实例未注册: ${input.instance_id}`);
    if (inst.state !== "ONLINE") {
      throw new ApiError(409, "INSTANCE_NOT_ELIGIBLE", `实例状态 ${inst.state}，只有 ONLINE 可领取`);
    }
    if (!inst.agent_profile_id) {
      throw new ApiError(409, "INSTANCE_NOT_ELIGIBLE", "实例未绑定 Agent Profile");
    }

    // Lock the host row: concurrent claims on one host serialize, making the budget trustworthy
    const hostRes = await c.query(
      `SELECT * FROM hosts WHERE host_id = $1 FOR NO KEY UPDATE`,
      [inst.host_id],
    );
    const host = hostRes.rows[0];
    if (!host) throw new ApiError(409, "HOST_UNKNOWN", `主机未注册: ${inst.host_id}`);

    // Host state: only NORMAL / WARNING may receive dispatches; THROTTLED / PROTECTING / RECOVERING are all excluded
    if (host.host_state !== "NORMAL" && host.host_state !== "WARNING") {
      throw new ApiError(409, "HOST_NOT_ELIGIBLE", `主机 ${host.host_id} 状态 ${host.host_state}，暂停派发`);
    }

    // Instance-level concurrency limit
    const instanceActive = await countActive(
      c,
      `SELECT count(*)::int AS n FROM leases
        WHERE instance_id = $1 AND released_at IS NULL AND expires_at > app_now()`,
      [inst.instance_id],
    );
    if (instanceActive >= cfg.instance_limit) {
      return null; // Instance is full: create no lease and record no blocking reason (not the task's fault)
    }

    const capabilities = (inst.capabilities?.healthy ?? []) as string[];
    const unhealthy = (inst.capabilities?.unhealthy ?? []) as string[];
    const usable = capabilities.filter((x) => !unhealthy.includes(x));
    // W=0 means "capability score not reported" (pre-upgrade instances): do not filter by difficulty, preserving old behavior.
    const capabilityScore = Number(inst.capability_score ?? 0);

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
       LIMIT 1`;

    for (let scanned = 0; scanned < MAX_CANDIDATE_SCAN; scanned++) {
      const cand = await c.query(candidateSql, [
        cfg.aging_after_seconds,
        inst.role_id,
        inst.allowed_task_types,
        JSON.stringify(usable),
        inst.payload_schemas,
        inst.instance_id,
        capabilityScore,
      ]);
      const task = cand.rows[0];
      if (!task) return null;

      const blocked = await admit(c, cfg, inst, host, task);
      if (blocked) {
        const reasonChanged = task.resource_block_reason !== blocked.reason;
        await c.query(
          `UPDATE tasks SET resource_block_reason = $2, resource_evaluated_at = app_now(),
                            version = version + 1, updated_at = app_now()
            WHERE task_id = $1`,
          [task.task_id, blocked.reason],
        );
        if (reasonChanged) {
          await appendEvent(c, {
            task_id: task.task_id,
            event_type: "TASK_RESOURCE_BLOCKED",
            from_status: "QUEUED",
            to_status: "QUEUED",
            actor: "scheduler",
            payload: blocked,
            trace_id: input.trace_id,
          });
        }
        continue; // Stay QUEUED; try the next candidate
      }

      return assign(c, cfg, inst, host, task, input.trace_id);
    }

    return null;
  });
}

interface Blocked {
  reason:
    | "INSUFFICIENT_MEMORY"
    | "CPU_PRESSURE_HIGH"
    | "DISK_SPACE_LOW"
    | "CONCURRENCY_LIMIT"
    | "HOST_PROTECTING";
  detail: Record<string, unknown>;
}

/** Admission check (§6.2). Returns null when it passes. */
async function admit(
  c: Client,
  cfg: any,
  inst: any,
  host: any,
  task: any,
): Promise<Blocked | null> {
  // Concurrency limits: global / role pool / task type
  const globalActive = await countActive(
    c,
    `SELECT count(*)::int AS n FROM leases WHERE released_at IS NULL AND expires_at > app_now()`,
    [],
  );
  if (globalActive >= cfg.global_limit) {
    return { reason: "CONCURRENCY_LIMIT", detail: { scope: "global", limit: cfg.global_limit } };
  }

  const roleActive = await countActive(
    c,
    `SELECT count(*)::int AS n
       FROM leases l JOIN role_instances i USING (instance_id)
      WHERE i.role_id = $1 AND l.released_at IS NULL AND l.expires_at > app_now()`,
    [inst.role_id],
  );
  if (roleActive >= cfg.role_pool_limit) {
    return { reason: "CONCURRENCY_LIMIT", detail: { scope: "role_pool", limit: cfg.role_pool_limit } };
  }

  const typeActive = await countActive(
    c,
    `SELECT count(*)::int AS n
       FROM leases l JOIN tasks t USING (task_id)
      WHERE t.task_type = $1 AND l.released_at IS NULL AND l.expires_at > app_now()`,
    [task.task_type],
  );
  if (typeActive >= cfg.task_type_limit) {
    return { reason: "CONCURRENCY_LIMIT", detail: { scope: "task_type", limit: cfg.task_type_limit } };
  }

  // Host budget: already reserved (HELD/ACTIVE) + this request <= available
  const profile = (
    await c.query(`SELECT * FROM resource_profiles WHERE profile_id = $1`, [task.resource_profile_id])
  ).rows[0];
  if (!profile) {
    return { reason: "INSUFFICIENT_MEMORY", detail: { why: "资源画像不存在", profile: task.resource_profile_id } };
  }

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
  const needMem = BigInt(profile.memory_bytes);
  if (usedMem + needMem > BigInt(host.mem_available_bytes)) {
    return {
      reason: "INSUFFICIENT_MEMORY",
      detail: {
        host: host.host_id,
        available_bytes: host.mem_available_bytes.toString(),
        reserved_bytes: usedMem.toString(),
        requested_bytes: needMem.toString(),
      },
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
  traceId?: string,
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
    // P4: send only references, never implementations, API addresses or secrets; the instance validates against its locally loaded Profile
    agent: {
      profile_id: inst.agent_profile_id,
      version: inst.agent_profile_version ?? null,
    },
    api_profiles: inst.api_profile_ids ?? [],
    started: false,
  };
}
