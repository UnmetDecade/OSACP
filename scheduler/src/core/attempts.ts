import { tx, type Client } from "../db.js";
import { ApiError } from "../errors.js";
import { appendEvent } from "../events.js";
import { closeActiveLease } from "./lease.js";
import { assertTransition, type TaskStatus } from "../statemachine.js";
import { advanceWorkflow } from "./workflow.js";
import { settleFanout } from "./fanout.js";
import { recordFailureSignature } from "../repo/failures.js";

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

/** The provider refused for a reason that has a reset time (usage quota, 429, signed-out token). */
export const RATE_LIMIT_CODES = new Set([
  "PROVIDER_RATE_LIMITED",
  "RATE_LIMITED",
  "RATE_LIMIT",
  "USAGE_LIMIT",
  "QUOTA_EXCEEDED",
  "TOO_MANY_REQUESTS",
]);

/** The host or engine was occupied. It is not a failure and must not consume the retry budget. */
export const BUSY_CODES = new Set(["AGENT_BUSY", "HOST_BUSY", "WORKSPACE_BUSY"]);

export type FailureClass = "permanent" | "outward" | "rate_limit" | "busy" | "transient";

export interface FailurePlan {
  failure_class: FailureClass;
  /** retry: consume a retry slot with backoff | wait: requeue without consuming | dead: terminal. */
  action: "retry" | "wait" | "dead";
  outcome: string;
  wait_seconds?: number;
}

/** A task may wait for an external reset at most this many times; then it dead-letters. */
const MAX_RETRY_WAIVERS = 6;
const BUSY_RECHECK_SECONDS = 30;
const RATE_LIMIT_DEFAULT_WAIT_SECONDS = 15 * 60;
const RATE_LIMIT_MAX_WAIT_SECONDS = 12 * 3600;

function parseRetryAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Accept epoch seconds or milliseconds; anything below 1e12 is seconds.
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * Decide what a failure means before deciding how to recover from it.
 *
 * A rate limit waits for the provider's reset instead of spending retries; a busy host is a short
 * recheck that gives the retry slot back; a deterministic refusal is never retried. `retry_waivers`
 * bounds the wait paths so a permanently limited provider cannot park a task forever.
 */
export function planFailure(input: {
  code: string;
  outward: boolean;
  retryAt?: unknown;
  now: Date;
  attemptCount: number;
  maxAttempts: number;
  waivers: number;
  backoffSeconds: number;
}): FailurePlan {
  if (input.outward) {
    return { failure_class: "outward", action: "dead", outcome: "interrupted_after_outward" };
  }
  const mayWait = input.waivers < MAX_RETRY_WAIVERS;
  if (RATE_LIMIT_CODES.has(input.code)) {
    if (!mayWait) return { failure_class: "rate_limit", action: "dead", outcome: "rate_limited" };
    const reset = parseRetryAt(input.retryAt);
    const byReset = reset
      ? Math.round((reset.getTime() - input.now.getTime()) / 1000)
      : RATE_LIMIT_DEFAULT_WAIT_SECONDS;
    const wait = Math.min(RATE_LIMIT_MAX_WAIT_SECONDS, Math.max(60, byReset));
    return { failure_class: "rate_limit", action: "wait", outcome: "rate_limited_wait", wait_seconds: wait };
  }
  if (BUSY_CODES.has(input.code)) {
    if (!mayWait) return { failure_class: "busy", action: "dead", outcome: "error" };
    return { failure_class: "busy", action: "wait", outcome: "busy_wait", wait_seconds: BUSY_RECHECK_SECONDS };
  }
  if (NON_RETRYABLE.has(input.code)) {
    return { failure_class: "permanent", action: "dead", outcome: "error" };
  }
  if (input.attemptCount >= input.maxAttempts) {
    return { failure_class: "transient", action: "dead", outcome: "error" };
  }
  return { failure_class: "transient", action: "retry", outcome: "error", wait_seconds: input.backoffSeconds };
}

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

/** Rows locked by lockContext; only the columns read by the attempt protocol are named. */
interface AttemptRow {
  attempt_id: string;
  task_id: string;
  status: string;
  outward_actions: unknown;
  [column: string]: unknown;
}
interface TaskRow {
  task_id: string;
  status: string;
  fanout_id?: string | null;
  attempt_count: number;
  max_attempts: number;
  [column: string]: unknown;
}
interface LeaseRow {
  lease_token: string;
  fencing_token: number | string;
  expires_at: string;
  instance_id: string | null;
  released_at: string | null;
  [column: string]: unknown;
}

interface Ctx {
  attempt: AttemptRow;
  task: TaskRow;
  lease: LeaseRow;
  now: Date;
}

async function lockContext(c: Client, attemptId: string, proof: LeaseProof): Promise<Ctx> {
  const attempt = (
    await c.query<AttemptRow>(`SELECT * FROM task_attempts WHERE attempt_id = $1 FOR UPDATE`, [attemptId])
  ).rows[0];
  if (!attempt) throw new ApiError(404, "NOT_FOUND", `attempt not found: ${attemptId}`);

  const task = (
    await c.query<TaskRow>(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [attempt.task_id])
  ).rows[0];

  const lease = (
    await c.query<LeaseRow>(`SELECT * FROM leases WHERE attempt_id = $1 FOR UPDATE`, [attemptId])
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
    throw new ApiError(409, "FENCING_STALE", "fencing_token is stale; write rejected", {
      task_id: attempt.task_id,
      current_fencing: Number(maxF),
      got: Number(proof.fencing_token),
      attempt_id: attemptId,
    });
  }

  // No lease = already reaped
  if (!lease || lease.released_at) throw new ApiError(409, "LEASE_EXPIRED", "lease has been released or reclaimed");

  if (lease.lease_token !== proof.lease_token) {
    throw new ApiError(409, "LEASE_MISMATCH", "lease_token does not match the current attempt");
  }
  // fencing: writes from old attempts are blocked here (§5)
  if (Number(lease.fencing_token) !== Number(proof.fencing_token)) {
    throw new ApiError(409, "FENCING_STALE", "fencing_token is stale; write rejected", {
      task_id: attempt.task_id,
      expected: Number(lease.fencing_token),
      got: Number(proof.fencing_token),
    });
  }

  const nowRes = await c.query(`SELECT app_now() AS t`);
  const now: Date = nowRes.rows[0].t;
  if (new Date(lease.expires_at).getTime() <= now.getTime()) {
    throw new ApiError(409, "LEASE_EXPIRED", "lease has expired");
  }

  if (proof.instance_id && proof.instance_id !== lease.instance_id) {
    throw new ApiError(409, "INSTANCE_MISMATCH", "this attempt does not belong to this instance");
  }
  // An instance token can only act on its own attempts; instance_id in the body is not an identity source
  if (proof.auth_instance_id && proof.auth_instance_id !== lease.instance_id) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "instance tokens cannot operate on attempts of other instances", {
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
      throw new ApiError(409, "STATE_CONFLICT", `attempt is already ${attempt.status}`);
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
    throw new ApiError(409, "STATE_CONFLICT", `attempt is already ${attempt.status}`);
  });
}

/**
 * Progress report: only fencing is checked; state does not change.
 *
 * `outward` actions (push / upload / deploy / publish) are persisted before the executor is
 * allowed to continue. If the lease later expires, the reaper sees them and refuses to rerun
 * the attempt on another machine, which is the only reliable protection against a duplicate
 * push after a host disappears mid-run.
 */
export async function progress(
  attemptId: string,
  proof: LeaseProof & { percent?: number; note?: string; outward?: string[] },
) {
  return tx(async (c) => {
    const { attempt, task, lease } = await lockContext(c, attemptId, proof);
    const added = mergeOutward(attempt.outward_actions, proof.outward);
    if (added.length) {
      await c.query(`UPDATE task_attempts SET outward_actions = $2 WHERE attempt_id = $1`, [
        attemptId,
        JSON.stringify(added),
      ]);
    }
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: added.length && proof.outward?.length ? "TASK_OUTWARD_ACTION" : "TASK_PROGRESS",
      from_status: task.status,
      to_status: task.status,
      actor: lease.instance_id,
      payload: {
        attempt_id: attemptId,
        percent: proof.percent ?? null,
        note: proof.note ?? null,
        ...(added.length ? { outward_actions: added } : {}),
      },
    });
    return { ok: true, outward_actions: added };
  });
}

/** Merge outward actions without duplicates; the list is append-only evidence. */
function mergeOutward(existing: unknown, incoming: unknown): string[] {
  const out = new Set<string>();
  for (const v of Array.isArray(existing) ? existing : []) out.add(String(v));
  for (const v of Array.isArray(incoming) ? incoming : []) {
    const action = String(v).trim();
    if (action) out.add(action.slice(0, 200));
  }
  return [...out];
}

export interface ResultInput extends LeaseProof {
  status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "NEEDS_INPUT";
  summary?: string;
  outputs?: unknown;
  /** `detail.retry_at` (ISO time or epoch) is the provider's reset time when it reported one. */
  error?: { code: string; message?: string; detail?: unknown };
  /** NEEDS_INPUT: the question a person has to answer before the task can continue. */
  question?: string;
  /** Typed outcome; defaults are derived from the status and the error code. */
  outcome?: string;
  /** Outward actions the executor performed; any entry makes a failure non-retryable. */
  outward_actions?: string[];
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
    if (!attemptRow) throw new ApiError(404, "NOT_FOUND", `attempt not found: ${attemptId}`);

    // Idempotent: a repeated report from the same attempt returns the first result.
    // Note that TIMEOUT does not count as "has a result" — it means the result never arrived, so a late write must still go through fencing checks.
    // PARKED does count: the attempt already handed control back (question or split) and must not be resumed twice.
    if (["SUCCEEDED", "FAILED", "CANCELLED", "PARKED"].includes(attemptRow.status)) {
      return {
        idempotent: true,
        attempt_id: attemptId,
        task_id: attemptRow.task_id,
        attempt_status: attemptRow.status,
        result_summary: attemptRow.result_summary,
      };
    }

    const { attempt, task, lease, now } = await lockContext(c, attemptId, input);

    if (!["RUNNING", "ASSIGNED"].includes(task.status)) {
      throw new ApiError(409, "STATE_CONFLICT", `task state ${task.status} does not accept results`);
    }
    // The state machine allows ASSIGNED → SUCCEEDED/FAILED so the parent scheduler can mirror child task results;
    // the executor must first start-ack to be eligible to report a result; this transition must not skip start acknowledgement.
    if (task.status === "ASSIGNED") {
      throw new ApiError(409, "STATE_CONFLICT", "task has not been start-acked; results are not accepted");
    }

    // Outward actions may arrive with the result as well as through progress reports.
    const outward = mergeOutward(attempt.outward_actions, input.outward_actions);
    if (outward.length !== (Array.isArray(attempt.outward_actions) ? attempt.outward_actions.length : 0)) {
      await c.query(`UPDATE task_attempts SET outward_actions = $2 WHERE attempt_id = $1`, [
        attemptId,
        JSON.stringify(outward),
      ]);
    }

    if (input.status === "NEEDS_INPUT") {
      const question = String(input.question ?? "").trim();
      if (!question) {
        throw new ApiError(422, "QUESTION_REQUIRED", "NEEDS_INPUT requires a non-empty question");
      }
      assertTransition(task.status as TaskStatus, "NEEDS_INPUT", "agent_needs_input");
      const ttl = Number(
        (await c.query(`SELECT needs_input_ttl_seconds FROM scheduler_config WHERE id = TRUE`)).rows[0]
          ?.needs_input_ttl_seconds,
      ) || 86400;
      await c.query(
        `UPDATE task_attempts
            SET status = 'PARKED', park_reason = 'NEEDS_INPUT', parked_at = app_now(),
                result_summary = $2
          WHERE attempt_id = $1`,
        [attemptId, String(input.summary ?? question).slice(0, 500)],
      );
      await closeActiveLease(c, task.task_id, "NEEDS_INPUT", "RELEASED");
      const updated = await c.query(
        `UPDATE tasks
            SET status = 'NEEDS_INPUT', current_attempt_id = NULL,
                pending_question = $2,
                needs_input_at = app_now(),
                needs_input_expires_at = app_now() + make_interval(secs => $3),
                version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [
          task.task_id,
          JSON.stringify({ question: question.slice(0, 4000), attempt_id: attemptId, asked_at: new Date().toISOString() }),
          ttl,
        ],
      );
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "TASK_NEEDS_INPUT",
        from_status: task.status,
        to_status: "NEEDS_INPUT",
        actor: lease.instance_id,
        // The question may contain business detail; the event keeps its shape, not its text.
        payload: { attempt_id: attemptId, question_chars: question.length, expires_in_seconds: ttl },
      });
      return { task: updated.rows[0], attempt_status: "PARKED", needs_input: true };
    }

    if (input.status === "SUCCEEDED") {
      assertTransition(task.status as TaskStatus, "SUCCEEDED", "result_succeeded");
      const outcome = input.outcome ?? "completed";
      await c.query(
        `UPDATE task_attempts SET status = 'SUCCEEDED', result_summary = $2,
                                  outputs = $3, outcome = $4, finished_at = app_now()
          WHERE attempt_id = $1`,
        [attemptId, input.summary ?? null, input.outputs ? JSON.stringify(input.outputs) : null, outcome],
      );
      const updated = await c.query(
        `UPDATE tasks SET status = 'SUCCEEDED', outcome = $2, current_attempt_id = NULL,
                          version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id, outcome],
      );
      await closeActiveLease(c, task.task_id, "SUCCEEDED", "RELEASED");
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "TASK_SUCCEEDED",
        from_status: task.status,
        to_status: "SUCCEEDED",
        actor: lease.instance_id,
        payload: {
          attempt_id: attemptId,
          summary: input.summary ?? null,
          outcome,
          ...(outward.length ? { outward_actions: outward } : {}),
        },
      });
      // Workflow advance and result write share one transaction, so there is no "task succeeded but next phase was not enqueued" gap
      await advanceWorkflow(c, task, "SUCCEEDED");
      await settleFanout(c, { task_id: task.task_id, fanout_id: task.fanout_id });
      return { task: updated.rows[0], attempt_status: "SUCCEEDED", outcome };
    }

    if (input.status === "CANCELLED") {
      assertTransition(task.status as TaskStatus, "CANCELLED", "cancel_ack");
      await c.query(
        `UPDATE task_attempts SET status = 'CANCELLED', outcome = 'cancelled', finished_at = app_now()
          WHERE attempt_id = $1`,
        [attemptId],
      );
      const updated = await c.query(
        `UPDATE tasks SET status = 'CANCELLED', outcome = 'cancelled', current_attempt_id = NULL,
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
      await settleFanout(c, { task_id: task.task_id, fanout_id: task.fanout_id });
      return { task: updated.rows[0], attempt_status: "CANCELLED" };
    }

    // ---- FAILED
    const code = input.error?.code ?? "UNKNOWN";
    // A failure after an outward action is never retried: the network side effect may already
    // exist, and a retry on another builder would repeat it. Everything else is classified before
    // a recovery action is chosen: a rate limit waits for the reset, a busy host gets the retry
    // slot back, a deterministic refusal is never retried.
    const outwardFailure = outward.length > 0;
    const cfg = (
      await c.query<{ retry_backoff_seconds: number[] }>(
        `SELECT retry_backoff_seconds FROM scheduler_config WHERE id = TRUE`,
      )
    ).rows[0];
    const backoff = backoffSeconds(cfg.retry_backoff_seconds, task.attempt_count);
    const detail = (input.error?.detail ?? {}) as Record<string, unknown>;
    const plan = planFailure({
      code,
      outward: outwardFailure,
      retryAt: detail.retry_at ?? detail.reset_at,
      now,
      attemptCount: task.attempt_count,
      maxAttempts: task.max_attempts,
      waivers: Number(task.retry_waivers ?? 0),
      backoffSeconds: backoff,
    });
    const outcome = input.outcome ?? plan.outcome;

    // Group fleet-wide failures by normalized text; the raw message stays on the attempt as evidence.
    const signature = await recordFailureSignature(c, {
      code,
      message: input.error?.message ?? input.summary ?? code,
    });

    await c.query(
      `UPDATE task_attempts
          SET status = 'FAILED', error = $2, outcome = $3, failure_class = $4,
              failure_signature = $5, finished_at = app_now()
        WHERE attempt_id = $1`,
      [attemptId, JSON.stringify(input.error ?? { code }), outcome, plan.failure_class, signature],
    );
    await closeActiveLease(c, task.task_id, "ATTEMPT_FAILED", "RELEASED");

    // What the next attempt must know: the previous attempt failed, how, and what it may already
    // have changed. It travels in requirements as information only (see the adapter's envelope).
    const priorFailure = {
      attempt_number: Number(attempt.attempt_number ?? task.attempt_count),
      builder: lease.instance_id,
      error_code: code,
      failure_class: plan.failure_class,
      outcome,
      at: new Date(now).toISOString(),
      ...(outward.length ? { outward_actions: outward } : {}),
    };
    const priorJson = JSON.stringify({ prior_failure: priorFailure });

    if (plan.action === "wait") {
      // An external wait is not a failure: the retry slot is given back and bounded separately.
      assertTransition(task.status as TaskStatus, "QUEUED", "result_failed_wait");
      const updated = await c.query(
        `UPDATE tasks
            SET status = 'QUEUED', current_attempt_id = NULL,
                attempt_count = GREATEST(0, attempt_count - 1),
                retry_waivers = retry_waivers + 1,
                next_attempt_at = app_now() + make_interval(secs => $2),
                requirements = COALESCE(requirements, '{}'::jsonb) || $3::jsonb,
                version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id, plan.wait_seconds ?? 60, priorJson],
      );
      await appendEvent(c, {
        task_id: task.task_id,
        event_type: "TASK_RETRY_WAITED",
        from_status: task.status,
        to_status: "QUEUED",
        actor: lease.instance_id,
        payload: {
          attempt_id: attemptId,
          error_code: code,
          failure_class: plan.failure_class,
          failure_signature: signature,
          wait_reason: plan.outcome,
          wait_seconds: plan.wait_seconds ?? 60,
          retry_waivers: Number(task.retry_waivers ?? 0) + 1,
          ...(outward.length ? { outward_actions: outward } : {}),
        },
      });
      return {
        task: updated.rows[0],
        attempt_status: "FAILED",
        retry_in_seconds: plan.wait_seconds ?? 60,
        outcome,
        failure_class: plan.failure_class,
      };
    }

    if (plan.action === "retry") {
      assertTransition(task.status as TaskStatus, "QUEUED", "result_failed_retryable");
      const updated = await c.query(
        `UPDATE tasks
            SET status = 'QUEUED', current_attempt_id = NULL,
                next_attempt_at = app_now() + make_interval(secs => $2),
                requirements = COALESCE(requirements, '{}'::jsonb) || $3::jsonb,
                version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [task.task_id, backoff, priorJson],
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
          failure_class: plan.failure_class,
          failure_signature: signature,
          attempt_count: task.attempt_count,
          max_attempts: task.max_attempts,
          backoff_seconds: backoff,
          ...(outward.length ? { outward_actions: outward } : {}),
        },
      });
      return {
        task: updated.rows[0],
        attempt_status: "FAILED",
        retry_in_seconds: backoff,
        outcome,
        failure_class: plan.failure_class,
      };
    }

    assertTransition(task.status as TaskStatus, "FAILED", "result_failed_retry_exhausted");
    const updated = await c.query(
      `UPDATE tasks SET status = 'FAILED', outcome = $2, current_attempt_id = NULL, dead_letter = TRUE,
                        version = version + 1, updated_at = app_now()
        WHERE task_id = $1 RETURNING *`,
      [task.task_id, outcome],
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
        failure_class: plan.failure_class,
        failure_signature: signature,
        outcome,
        attempt_count: task.attempt_count,
        non_retryable: plan.failure_class === "permanent" || plan.failure_class === "outward",
        retry_waivers: Number(task.retry_waivers ?? 0),
        ...(outward.length ? { outward_actions: outward } : {}),
        alert: "P1",
      },
    });
    await advanceWorkflow(c, task, "FAILED");
    await settleFanout(c, { task_id: task.task_id, fanout_id: task.fanout_id });
    return {
      task: updated.rows[0],
      attempt_status: "FAILED",
      dead_letter: true,
      outcome,
      failure_class: plan.failure_class,
    };
  });
}
