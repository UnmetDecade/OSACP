import { q, q1, tx } from "../db.js";
import { ApiError } from "../errors.js";
import { appendEvent } from "../events.js";
import { assertTransition, isTerminal, type TaskStatus } from "../statemachine.js";
import { advanceWorkflow } from "../core/workflow.js";
import { cancelFanoutChildren, settleFanout } from "../core/fanout.js";
import { closeActiveLease } from "../core/lease.js";
import { insertTask, type CreateTaskInput } from "./task-insert.js";

export { insertTask, type CreateTaskInput };

export async function createTask(input: CreateTaskInput) {
  return tx((c) => insertTask(c, input));
}

export async function getTask(taskId: string) {
  const task = await q1("SELECT * FROM tasks WHERE task_id = $1", [taskId]);
  if (!task) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
  const attempts = await q(
    `SELECT attempt_id, attempt_number, instance_id, status, result_summary, outputs,
            error, started_at, finished_at
       FROM task_attempts WHERE task_id = $1 ORDER BY attempt_number`,
    [taskId],
  );
  const lease = await q1(
    `SELECT lease_token, attempt_id, fencing_token, issued_at, expires_at
       FROM leases WHERE task_id = $1 AND released_at IS NULL`,
    [taskId],
  );
  // A pushed-down task has no local attempt; execution happens on the child. Return relay info as well,
  // so the admin page can show "which node executes it" and the child's current raw state.
  const relay = await q1(
    `SELECT child_node_id, child_url, child_task_id, state, child_state,
            child_result, sync_failures, last_error, created_at, updated_at
       FROM task_relays WHERE parent_task_id = $1`,
    [taskId],
  );
  // Fan-out children are ordinary tasks linked by parent_task_id; the detail view needs their
  // state in one round trip so a split job reads as a tree, not as unrelated rows.
  const children = await q(
    `SELECT task_id, task_type, status, outcome, parent_task_id, fanout_id,
            requirements->'build'->>'title' AS title,
            created_at, updated_at
       FROM tasks WHERE parent_task_id = $1
      ORDER BY created_at, task_id`,
    [taskId],
  );
  return { ...task, attempts, lease, relay: relay ?? null, children };
}

export async function listTasks(filter: {
  status?: string;
  task_type?: string;
  role?: string;
  limit?: number;
}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    params.push(filter.status);
    where.push(`t.status = $${params.length}`);
  }
  if (filter.task_type) {
    params.push(filter.task_type);
    where.push(`t.task_type = $${params.length}`);
  }
  if (filter.role) {
    params.push(filter.role);
    where.push(`td.target_role = $${params.length}`);
  }
  params.push(Math.min(filter.limit ?? 100, 500));
  return q(
    `SELECT t.*, td.target_role,
            a.instance_id AS current_instance_id,
            a.attempt_number AS current_attempt_number
       FROM tasks t
       JOIN task_definitions td USING (task_type)
       LEFT JOIN task_attempts a ON a.attempt_id = t.current_attempt_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY t.enqueued_at DESC, t.task_id
      LIMIT $${params.length}`,
    params,
  );
}

export async function listEvents(taskId: string) {
  return q(
    `SELECT event_id::text, event_type, from_status, to_status, actor, payload, created_at
       FROM task_events WHERE task_id = $1 ORDER BY event_id`,
    [taskId],
  );
}

/**
 * Requeue a terminal task for another round of attempts.
 *
 * A dead-lettered task is terminal by definition, so the state machine has no FAILED -> QUEUED edge; an operator's
 * retry is an explicit reset: the attempt budget is renewed, the task re-enters the queue, and its attempts and events
 * stay as history. attempt_number keeps growing (it is derived from the attempts table), so old attempts are never
 * overwritten.
 */
export async function retryTask(taskId: string, actor = "operator") {
  return tx(async (c) => {
    const row = (
      await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [taskId])
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
    const from = row.status as TaskStatus;
    if (from !== "FAILED" && from !== "CANCELLED") {
      throw new ApiError(
        409,
        "STATE_CONFLICT",
        `task is ${from}; only a FAILED or CANCELLED task can be retried`,
      );
    }
    const updated = await c.query(
      `UPDATE tasks
          SET status = 'QUEUED', attempt_count = 0, dead_letter = FALSE,
              current_attempt_id = NULL, next_attempt_at = NULL,
              cancel_requested_at = NULL, resource_block_reason = NULL,
              resource_evaluated_at = NULL, resource_retry_after = NULL,
              blocked_attempts = 0, unschedulable = FALSE, result_summary = NULL,
              outcome = NULL, pending_question = NULL,
              needs_input_at = NULL, needs_input_expires_at = NULL, resume_rounds = 0,
              enqueued_at = app_now(), version = version + 1, updated_at = app_now()
        WHERE task_id = $1 RETURNING *`,
      [taskId],
    );
    await appendEvent(c, {
      task_id: taskId,
      event_type: "TASK_REQUEUED",
      from_status: from,
      to_status: "QUEUED",
      actor,
      payload: { previous_attempts: Number(row.attempt_count ?? 0) },
    });
    return updated.rows[0];
  });
}

/**
 * Cancel:
 *  - QUEUED / BLOCKED: CANCELLED immediately
 *  - ASSIGNED: reaped lease, then CANCELLED
 *  - RUNNING: only record cancel_requested_at; wait for instance ack or force-kill on timeout
 */
export async function cancelTask(taskId: string, actor = "operator") {
  return tx(async (c) => {
    const row = (
      await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [taskId])
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
    const from = row.status as TaskStatus;
    if (isTerminal(from)) {
      throw new ApiError(409, "STATE_CONFLICT", `task is already terminal (${from}); cannot cancel`);
    }

    if (from === "RUNNING") {
      await c.query(
        `UPDATE tasks SET cancel_requested_at = COALESCE(cancel_requested_at, app_now()),
                          version = version + 1, updated_at = app_now()
          WHERE task_id = $1`,
        [taskId],
      );
      await appendEvent(c, {
        task_id: taskId,
        event_type: "CANCEL_REQUESTED",
        from_status: from,
        to_status: from,
        actor,
      });
      return { ...row, cancel_requested_at: new Date(), status: from };
    }

    assertTransition(from, "CANCELLED", "operator_cancel");
    await closeActiveLease(c, taskId, "CANCEL_REQUESTED");
    const updated = await c.query(
      `UPDATE tasks SET status = 'CANCELLED', outcome = 'cancelled', current_attempt_id = NULL,
                        pending_question = NULL, needs_input_at = NULL, needs_input_expires_at = NULL,
                        version = version + 1, updated_at = app_now()
        WHERE task_id = $1 RETURNING *`,
      [taskId],
    );
    await appendEvent(c, {
      task_id: taskId,
      event_type: "TASK_CANCELLED",
      from_status: from,
      to_status: "CANCELLED",
      actor,
    });
    // The parent is already terminal here, so cancelling descendants cannot resume it.
    const cancelledChildren = await cancelFanoutChildren(c, taskId, actor);
    if (cancelledChildren.length) {
      await appendEvent(c, {
        task_id: taskId,
        event_type: "TASK_CHILDREN_CANCELLED",
        from_status: "CANCELLED",
        to_status: "CANCELLED",
        actor,
        payload: { child_ids: cancelledChildren },
      });
    }
    await advanceWorkflow(c, row, "CANCELLED");
    // Cancelling one child may have been the last thing its parent was waiting for; settleFanout
    // only acts when every sibling is terminal and the parent is parked, so this is safe for
    // ordinary (non-fan-out) tasks too.
    await settleFanout(c, { task_id: taskId, fanout_id: row.fanout_id });
    return updated.rows[0];
  });
}

/**
 * Answer a parked question and resume the task.
 *
 * The answer rides in `requirements.input_answers`, so the next attempt's agent sees it
 * together with the question it answered. The parked attempt is not a failure: the resume
 * does not consume the retry budget, but it does count against resume_rounds, which is what
 * stops an agent from parking forever.
 */
export async function answerTask(taskId: string, answer: string, actor = "operator") {
  const text = String(answer ?? "").trim();
  if (!text) throw new ApiError(422, "ANSWER_REQUIRED", "answer must not be empty");

  return tx(async (c) => {
    const row = (
      await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [taskId])
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
    if (row.status !== "NEEDS_INPUT") {
      throw new ApiError(409, "STATE_CONFLICT", `task is ${row.status}; it is not waiting for an answer`);
    }

    const cfg = (await c.query(`SELECT max_resume_rounds FROM scheduler_config WHERE id = TRUE`)).rows[0];
    const maxRounds = Number(cfg?.max_resume_rounds) || 8;
    if (Number(row.resume_rounds) >= maxRounds) {
      const failed = await c.query(
        `UPDATE tasks SET status = 'FAILED', outcome = 'input_exhausted', dead_letter = TRUE,
                          current_attempt_id = NULL, version = version + 1, updated_at = app_now()
          WHERE task_id = $1 RETURNING *`,
        [taskId],
      );
      await appendEvent(c, {
        task_id: taskId,
        event_type: "TASK_DEAD_LETTERED",
        from_status: "NEEDS_INPUT",
        to_status: "FAILED",
        actor,
        payload: { outcome: "input_exhausted", resume_rounds: Number(row.resume_rounds) },
      });
      return { ...failed.rows[0], answer_rejected: "TOO_MANY_RESUMES" };
    }

    const req = (row.requirements && typeof row.requirements === "object" ? row.requirements : {}) as Record<
      string,
      unknown
    >;
    const answers = Array.isArray(req.input_answers) ? (req.input_answers as unknown[]) : [];
    const question = row.pending_question?.question ?? null;
    const requirements = {
      ...req,
      input_answers: [
        ...answers,
        { question, answer: text.slice(0, 8000), at: new Date().toISOString(), actor },
      ].slice(-20),
    };

    const updated = await c.query(
      `UPDATE tasks
          SET status = 'QUEUED', current_attempt_id = NULL,
              requirements = $2,
              pending_question = NULL, needs_input_at = NULL, needs_input_expires_at = NULL,
              attempt_count = GREATEST(0, attempt_count - 1),
              resume_rounds = resume_rounds + 1,
              next_attempt_at = NULL, enqueued_at = app_now(),
              version = version + 1, updated_at = app_now()
        WHERE task_id = $1 RETURNING *`,
      [taskId, JSON.stringify(requirements)],
    );
    await appendEvent(c, {
      task_id: taskId,
      event_type: "TASK_ANSWERED",
      from_status: "NEEDS_INPUT",
      to_status: "QUEUED",
      actor,
      // The answer itself is business content and stays in requirements, not in the event log.
      payload: { question_chars: question ? String(question).length : 0, answer_chars: text.length },
    });
    return updated.rows[0];
  });
}

// Kept re-exported so existing callers keep one import site; the implementation lives in
// core/lease to keep the repo module free of a cycle with attempt/fan-out code.
export { closeActiveLease };
