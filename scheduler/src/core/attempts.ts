import { tx, type Client } from "../db.js";
import { ApiError } from "../errors.js";
import { appendEvent } from "../events.js";
import { closeActiveLease } from "../repo/tasks.js";
import { assertTransition, type TaskStatus } from "../statemachine.js";
import { advanceWorkflow } from "./workflow.js";

/**
 * Error codes that do not back off or consume a retry (§8).
 *
 * Artifact- and approval-related errors are all deterministic: upstream did not hand off, digest mismatch, approval subject changed.
 * Retrying would only repeat the same failure; stop immediately in FAILED and wait for manual handling.
 */
const NON_RETRYABLE = new Set([
  "PAYLOAD_INVALID",
  "AUTH",
  "PERMISSION_DENIED",
  "SCHEMA_MISMATCH",
  "TASK_TYPE_UNKNOWN",
  "UPSTREAM_ARTIFACT_REQUIRED",
  "UPSTREAM_ARTIFACT_INVALID",
  "UPSTREAM_ARTIFACT_DIGEST_MISMATCH",
  "APPROVAL_REQUIRED",
  "APPROVAL_SUBJECT_CHANGED",
  "REVIEW_REJECTED_SECRET",
  "REVIEW_REJECTED_INCOMPLETE",
  // P4: permission violations/config mismatches are not solved by retrying
  "AGENT_PROFILE_NOT_ALLOWED",
  "API_PROFILE_NOT_ALLOWED",
  "TOOL_NOT_ALLOWED",
  "TOOL_UNKNOWN",
  "TOOL_PHASE_DENIED",
  "TOOL_SCOPE_DENIED",
  "TOOL_IDENTITY_MISMATCH",
  "TOOL_INPUT_INVALID",
  "TOOL_TURN_LIMIT",
  "TOOL_IDEMPOTENCY_CONFLICT",
  "WORKSPACE_PATH_DENIED",
  "ARTIFACT_PATH_DENIED",
]);

/** Backoff table comes from scheduler_config.retry_backoff_seconds, default 5m → 15m → 45m */
const DEFAULT_BACKOFF = [300, 900, 2700];

export function backoffSeconds(table: number[], attemptCount: number): number {
  // Fall back to the default table when config is cleared or the column is missing; the reap loop must not throw and stall
  const arr = Array.isArray(table) && table.length > 0 ? table : DEFAULT_BACKOFF;
  const idx = Math.min(Math.max(attemptCount - 1, 0), arr.length - 1);
  return arr[idx] ?? 300;
}

export interface LeaseProof {
  lease_token: string;
  fencing_token: number;
  instance_id?: string;
  /** Filled in by the HTTP layer from a verified instance JWT; when present it must match the lease holder */
  auth_instance_id?: string;
}

interface Ctx {
  attempt: any;
  task: any;
  lease: any;
  now: Date;
}

async function lockContext(c: Client, attemptId: string, proof: LeaseProof): Promise<Ctx> {
  const attempt = (
    await c.query(`SELECT * FROM task_attempts WHERE attempt_id = $1 FOR UPDATE`, [attemptId])
  ).rows[0];
  if (!attempt) throw new ApiError(404, "NOT_FOUND", `attempt 不存在: ${attemptId}`);

  const task = (
    await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [attempt.task_id])
  ).rows[0];

  const lease = (
    await c.query(`SELECT * FROM leases WHERE attempt_id = $1 FOR UPDATE`, [attemptId])
  ).rows[0];

  // Write from an old attempt: the task already has a higher fencing, so return FENCING_STALE directly,
  // rather than a vague "lease expired" — this is the diagnostic basis for duplicate-execution cases.
  const maxF = (
    await c.query(
      `SELECT COALESCE(MAX(fencing_token), 0) AS f FROM leases WHERE task_id = $1`,
      [attempt.task_id],
    )
  ).rows[0].f;
  if (Number(proof.fencing_token) < Number(maxF)) {
    throw new ApiError(409, "FENCING_STALE", "fencing_token 已过期，写入被拒绝", {
      task_id: attempt.task_id,
      current_fencing: Number(maxF),
      got: Number(proof.fencing_token),
      attempt_id: attemptId,
    });
  }

  // No lease = already reaped
  if (!lease || lease.released_at) throw new ApiError(409, "LEASE_EXPIRED", "租约已释放或已回收");

  if (lease.lease_token !== proof.lease_token) {
    throw new ApiError(409, "LEASE_MISMATCH", "lease_token 与当前 attempt 不匹配");
  }
  // fencing: writes from old attempts are blocked here (§5)
  if (Number(lease.fencing_token) !== Number(proof.fencing_token)) {
    throw new ApiError(409, "FENCING_STALE", "fencing_token 已过期，写入被拒绝", {
      task_id: attempt.task_id,
      expected: Number(lease.fencing_token),
      got: Number(proof.fencing_token),
    });
  }

  const nowRes = await c.query(`SELECT app_now() AS t`);
  const now: Date = nowRes.rows[0].t;
  if (new Date(lease.expires_at).getTime() <= now.getTime()) {
    throw new ApiError(409, "LEASE_EXPIRED", "租约已过期");
  }

  if (proof.instance_id && proof.instance_id !== lease.instance_id) {
    throw new ApiError(409, "INSTANCE_MISMATCH", "该 attempt 不属于此实例");
  }
  // An instance token can only act on its own attempts; instance_id in the body is not an identity source
  if (proof.auth_instance_id && proof.auth_instance_id !== lease.instance_id) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "实例令牌不能操作其他实例的 attempt", {
      token_sub: proof.auth_instance_id,
      lease_owner: lease.instance_id,
    });
  }

  return { attempt, task, lease, now };
}

/** Start acknowledgement. accepted=false means local admission rejected it; no retry is consumed (§4.3). */
export async function startAck(
  attemptId: string,
  proof: LeaseProof & { accepted?: boolean },
) {
  return tx(async (c) => {
    const { attempt, task, lease } = await lockContext(c, attemptId, proof);

    // Idempotent: repeated start-ack succeeds directly
    if (attempt.status === "STARTED") {
      return { attempt_id: attemptId, status: "STARTED", idempotent: true };
    }
    if (attempt.status !== "CREATED") {
      throw new ApiError(409, "STATE_CONFLICT", `attempt 已是 ${attempt.status}`);
    }

    if (proof.accepted === false) {
      await c.query(
        `UPDATE task_attempts SET status = 'FAILED', finished_at = app_now(),
                                  error = $2 WHERE attempt_id = $1`,
        [attemptId, JSON.stringify({ code: "ADMISSION_DENIED_BY_HOST" })],
      );
      await closeActiveLease(c, task.task_id, "ADMISSION_REJECTED", "RELEASED");
      // Do not consume a retry: roll back the attempt_count added at claim
      const updated = await c.query(
        `UPDATE tasks
            SET status = 'QUEUED', attempt_count = GREATEST(0, attempt_count - 1),
                current_attempt_id = NULL, version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id],
      );
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "ADMISSION_REJECTED",
        from_status: "ASSIGNED",
        to_status: "QUEUED",
        actor: lease.instance_id,
        payload: { attempt_id: attemptId, consumed_retry: false },
      });
      return { attempt_id: attemptId, status: "REJECTED", task: updated.rows[0] };
    }

    assertTransition(task.status as TaskStatus, "RUNNING", "start_ack");
    await c.query(
      `UPDATE task_attempts SET status = 'STARTED', started_at = app_now() WHERE attempt_id = $1`,
      [attemptId],
    );
    await c.query(
      `UPDATE tasks SET status = 'RUNNING', version = version + 1, updated_at = app_now()
        WHERE task_id = $1`,
      [task.task_id],
    );
    // Two-phase reservation: HELD → ACTIVE
    await c.query(
      `UPDATE resource_reservations SET state = 'ACTIVE', activated_at = app_now()
        WHERE attempt_id = $1 AND state = 'HELD'`,
      [attemptId],
    );
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: "TASK_STARTED",
      from_status: "ASSIGNED",
      to_status: "RUNNING",
      actor: lease.instance_id,
      payload: { attempt_id: attemptId, fencing_token: Number(lease.fencing_token) },
    });

    return { attempt_id: attemptId, status: "STARTED", task_id: task.task_id };
  });
}

/** Renew lease: only the instance holding the attempt may renew */
export async function renew(attemptId: string, proof: LeaseProof) {
  return tx(async (c) => {
    const { attempt } = await lockContext(c, attemptId, proof);
    if (attempt.status === "STARTED" || attempt.status === "CREATED") {
      const res = await c.query(
        `UPDATE leases
            SET expires_at = app_now() + make_interval(secs =>
                  (SELECT lease_seconds FROM scheduler_config WHERE id = TRUE))
          WHERE attempt_id = $1 AND released_at IS NULL
          RETURNING expires_at`,
        [attemptId],
      );
      return { attempt_id: attemptId, lease_expires_at: res.rows[0].expires_at };
    }
    throw new ApiError(409, "STATE_CONFLICT", `attempt 已是 ${attempt.status}`);
  });
}

/** Progress report: only fencing is checked; state does not change */
export async function progress(
  attemptId: string,
  proof: LeaseProof & { percent?: number; note?: string },
) {
  return tx(async (c) => {
    const { task, lease } = await lockContext(c, attemptId, proof);
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: "TASK_PROGRESS",
      from_status: task.status,
      to_status: task.status,
      actor: lease.instance_id,
      payload: { attempt_id: attemptId, percent: proof.percent ?? null, note: proof.note ?? null },
    });
    return { ok: true };
  });
}

export interface ResultInput extends LeaseProof {
  status: "SUCCEEDED" | "FAILED" | "CANCELLED";
  summary?: string;
  outputs?: unknown;
  error?: { code: string; message?: string; detail?: unknown };
}

/**
 * Result submission.
 *  - repeated report from the same attempt → return the first result (idempotent)
 *  - report from an old attempt → FENCING_STALE (the last gate against duplicate execution)
 *  - FAILED and retryable → back off and requeue; retries exhausted → FAILED + dead-letter
 */
export async function submitResult(attemptId: string, input: ResultInput) {
  return tx(async (c) => {
    const attemptRow = (
      await c.query(`SELECT * FROM task_attempts WHERE attempt_id = $1 FOR UPDATE`, [attemptId])
    ).rows[0];
    if (!attemptRow) throw new ApiError(404, "NOT_FOUND", `attempt 不存在: ${attemptId}`);

    // Idempotent: a repeated report from the same attempt returns the first result.
    // Note that TIMEOUT does not count as "has a result" — it means the result never arrived, so a late write must still go through fencing checks.
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(attemptRow.status)) {
      return {
        idempotent: true,
        attempt_id: attemptId,
        task_id: attemptRow.task_id,
        attempt_status: attemptRow.status,
        result_summary: attemptRow.result_summary,
      };
    }

    const { task, lease } = await lockContext(c, attemptId, input);

    if (!["RUNNING", "ASSIGNED"].includes(task.status)) {
      throw new ApiError(409, "STATE_CONFLICT", `任务状态 ${task.status} 不接受结果`);
    }
    // The state machine allows ASSIGNED → SUCCEEDED/FAILED so the parent scheduler can mirror child task results;
    // the executor must first start-ack to be eligible to report a result; this transition must not skip start acknowledgement.
    if (task.status === "ASSIGNED") {
      throw new ApiError(409, "STATE_CONFLICT", "任务还没 start-ack，不接受结果");
    }

    if (input.status === "SUCCEEDED") {
      assertTransition(task.status as TaskStatus, "SUCCEEDED", "result_succeeded");
      await c.query(
        `UPDATE task_attempts SET status = 'SUCCEEDED', result_summary = $2,
                                  outputs = $3, finished_at = app_now()
          WHERE attempt_id = $1`,
        [attemptId, input.summary ?? null, input.outputs ? JSON.stringify(input.outputs) : null],
      );
      const updated = await c.query(
        `UPDATE tasks SET status = 'SUCCEEDED', current_attempt_id = NULL,
                          version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id],
      );
      await closeActiveLease(c, task.task_id, "SUCCEEDED", "RELEASED");
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "TASK_SUCCEEDED",
        from_status: task.status,
        to_status: "SUCCEEDED",
        actor: lease.instance_id,
        payload: { attempt_id: attemptId, summary: input.summary ?? null },
      });
      // Workflow advance and result write share one transaction, so there is no "task succeeded but next phase was not enqueued" gap
      await advanceWorkflow(c, task, "SUCCEEDED");
      return { task: updated.rows[0], attempt_status: "SUCCEEDED" };
    }

    if (input.status === "CANCELLED") {
      assertTransition(task.status as TaskStatus, "CANCELLED", "cancel_ack");
      await c.query(
        `UPDATE task_attempts SET status = 'CANCELLED', finished_at = app_now() WHERE attempt_id = $1`,
        [attemptId],
      );
      const updated = await c.query(
        `UPDATE tasks SET status = 'CANCELLED', current_attempt_id = NULL,
                          version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id],
      );
      await closeActiveLease(c, task.task_id, "TASK_CANCELLED", "RELEASED");
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "TASK_CANCELLED",
        from_status: task.status,
        to_status: "CANCELLED",
        actor: lease.instance_id,
        payload: { attempt_id: attemptId, confirmed: true },
      });
      await advanceWorkflow(c, task, "CANCELLED");
      return { task: updated.rows[0], attempt_status: "CANCELLED" };
    }

    // ---- FAILED
    const code = input.error?.code ?? "UNKNOWN";
    const retryable = !NON_RETRYABLE.has(code) && task.attempt_count < task.max_attempts;

    await c.query(
      `UPDATE task_attempts SET status = 'FAILED', error = $2, finished_at = app_now()
        WHERE attempt_id = $1`,
      [attemptId, JSON.stringify(input.error ?? { code })],
    );
    await closeActiveLease(c, task.task_id, "ATTEMPT_FAILED", "RELEASED");

    if (retryable) {
      const cfg = (await c.query(`SELECT retry_backoff_seconds FROM scheduler_config WHERE id = TRUE`))
        .rows[0];
      const backoff = backoffSeconds(cfg.retry_backoff_seconds, task.attempt_count);
      assertTransition(task.status as TaskStatus, "QUEUED", "result_failed_retryable");
      const updated = await c.query(
        `UPDATE tasks
            SET status = 'QUEUED', current_attempt_id = NULL,
                next_attempt_at = app_now() + make_interval(secs => $2),
                version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id, backoff],
      );
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "TASK_RETRY_SCHEDULED",
        from_status: task.status,
        to_status: "QUEUED",
        actor: lease.instance_id,
        payload: {
          attempt_id: attemptId,
          error_code: code,
          attempt_count: task.attempt_count,
          max_attempts: task.max_attempts,
          backoff_seconds: backoff,
        },
      });
      return { task: updated.rows[0], attempt_status: "FAILED", retry_in_seconds: backoff };
    }

    assertTransition(task.status as TaskStatus, "FAILED", "result_failed_retry_exhausted");
    const updated = await c.query(
      `UPDATE tasks SET status = 'FAILED', current_attempt_id = NULL, dead_letter = TRUE,
                        version = version + 1, updated_at = app_now()
        WHERE task_id = $1 RETURNING *`,
      [task.task_id],
    );
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: "TASK_DEAD_LETTERED",
      from_status: task.status,
      to_status: "FAILED",
      actor: lease.instance_id,
      payload: {
        attempt_id: attemptId,
        error_code: code,
        attempt_count: task.attempt_count,
        non_retryable: NON_RETRYABLE.has(code),
        alert: "P1",
      },
    });
    await advanceWorkflow(c, task, "FAILED");
    return { task: updated.rows[0], attempt_status: "FAILED", dead_letter: true };
  });
}
