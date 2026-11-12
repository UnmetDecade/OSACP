import { q, q1, tx } from "../db.js";
import { ApiError } from "../errors.js";
import { appendEvent } from "../events.js";
import { assertTransition, isTerminal, type TaskStatus } from "../statemachine.js";
import { advanceWorkflow } from "../core/workflow.js";
import { insertTask, type CreateTaskInput } from "./task-insert.js";

export { insertTask, type CreateTaskInput };

export async function createTask(input: CreateTaskInput) {
  return tx((c) => insertTask(c, input));
}

export async function getTask(taskId: string) {
  const task = await q1("SELECT * FROM tasks WHERE task_id = $1", [taskId]);
  if (!task) throw new ApiError(404, "NOT_FOUND", `任务不存在: ${taskId}`);
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
  // 下推中的任务在本机没有 attempt，执行现场在子结点；把中继信息一并返回，
  // 管理页可以显示「由哪个结点执行」以及子结点当前的原始状态。
  const relay = await q1(
    `SELECT child_node_id, child_url, child_task_id, state, child_state,
            child_result, sync_failures, last_error, created_at, updated_at
       FROM task_relays WHERE parent_task_id = $1`,
    [taskId],
  );
  return { ...task, attempts, lease, relay: relay ?? null };
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
 * 取消：
 *  - QUEUED / BLOCKED：立即 CANCELLED
 *  - ASSIGNED：回收租约后 CANCELLED
 *  - RUNNING：只登记 cancel_requested_at，等实例 ack 或超时强杀
 */
export async function cancelTask(taskId: string, actor = "operator") {
  return tx(async (c) => {
    const row = (
      await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [taskId])
    ).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", `任务不存在: ${taskId}`);
    const from = row.status as TaskStatus;
    if (isTerminal(from)) {
      throw new ApiError(409, "STATE_CONFLICT", `任务已终结（${from}），不能取消`);
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
      `UPDATE tasks SET status = 'CANCELLED', version = version + 1, updated_at = app_now()
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
    await advanceWorkflow(c, row, "CANCELLED");
    return updated.rows[0];
  });
}

/** 释放该任务当前未释放的租约，并同步关闭预留 */
export async function closeActiveLease(
  c: { query: (sql: string, params?: unknown[]) => Promise<any> },
  taskId: string,
  reason: string,
  reservationState: "RELEASED" | "RECLAIMED" = "RELEASED",
): Promise<void> {
  const lease = (
    await c.query(
      `UPDATE leases SET released_at = app_now(), release_reason = $2
        WHERE task_id = $1 AND released_at IS NULL
        RETURNING attempt_id`,
      [taskId, reason],
    )
  ).rows[0];
  if (!lease) return;
  await c.query(
    `UPDATE resource_reservations
        SET state = $3, closed_at = app_now(), close_reason = $2
      WHERE attempt_id = $1 AND state IN ('HELD','ACTIVE')`,
    [lease.attempt_id, reason, reservationState],
  );
}
