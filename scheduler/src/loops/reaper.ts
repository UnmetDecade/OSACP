import { tx } from "../db.js";
import { appendEvent } from "../events.js";
import { backoffSeconds } from "../core/attempts.js";

/**
 * 租约回收（§5）。
 *
 * 两种触发，走同一条回收路径：
 *   1) 启动窗口超时：ASSIGNED 且 issued_at 超过 start_window_seconds
 *   2) 租约过期：expires_at <= app_now()
 *
 * 回收 = 释放租约 + 预留 RECLAIMED + attempt TIMEOUT + 任务回队（退避）或死信。
 * 每回收一次消耗一次 attempt；重试耗尽即 FAILED + 死信。
 */
export async function sweepLeases(limit = 50): Promise<{
  reclaimed: { task_id: string; cause: string; to: string }[];
}> {
  return tx(async (c) => {
    const cfg = (await c.query("SELECT * FROM scheduler_config WHERE id = TRUE")).rows[0];
    const rows = (
      await c.query(
        `SELECT l.lease_token, l.task_id, l.attempt_id, l.instance_id, l.issued_at, l.expires_at,
                (l.expires_at <= app_now()) AS expired,
                t.status AS task_status, t.attempt_count, t.max_attempts,
                a.status AS attempt_status
           FROM leases l
           JOIN tasks t ON t.task_id = l.task_id
           JOIN task_attempts a ON a.attempt_id = l.attempt_id
          WHERE l.released_at IS NULL
            AND (
              l.expires_at <= app_now()
              OR (t.status = 'ASSIGNED'
                  AND l.issued_at <= app_now() - make_interval(secs => $1))
            )
          ORDER BY l.issued_at
          FOR UPDATE OF l SKIP LOCKED
          LIMIT $2`,
        [cfg.start_window_seconds, limit],
      )
    ).rows;

    const out: { task_id: string; cause: string; to: string }[] = [];

    for (const row of rows) {
      const cause =
        row.task_status === "ASSIGNED" && !row.expired ? "START_TIMEOUT" : "LEASE_EXPIRED";

      // 释放租约 + 预留
      await c.query(
        `UPDATE leases SET released_at = app_now(), release_reason = $2
          WHERE lease_token = $1`,
        [row.lease_token, cause],
      );
      await c.query(
        `UPDATE resource_reservations
            SET state = 'RECLAIMED', closed_at = app_now(), close_reason = $2
          WHERE attempt_id = $1 AND state IN ('HELD','ACTIVE')`,
        [row.attempt_id, cause],
      );
      if (!["SUCCEEDED", "FAILED", "CANCELLED", "TIMEOUT"].includes(row.attempt_status)) {
        await c.query(
          `UPDATE task_attempts SET status = 'TIMEOUT', finished_at = app_now(),
                                    error = $2
            WHERE attempt_id = $1`,
          [row.attempt_id, JSON.stringify({ code: cause })],
        );
      }

      if (row.attempt_count >= row.max_attempts) {
        await c.query(
          `UPDATE tasks SET status = 'FAILED', current_attempt_id = NULL, dead_letter = TRUE,
                            version = version + 1, updated_at = app_now()
            WHERE task_id = $1`,
          [row.task_id],
        );
        await appendEvent(c, {
          task_id: row.task_id,
          event_type: "TASK_DEAD_LETTERED",
          from_status: row.task_status,
          to_status: "FAILED",
          actor: "scheduler",
          payload: { attempt_id: row.attempt_id, cause, alert: "P1" },
        });
        out.push({ task_id: row.task_id, cause, to: "FAILED" });
      } else {
        await c.query(
          `UPDATE tasks
              SET status = 'QUEUED', current_attempt_id = NULL,
                  next_attempt_at = app_now() + make_interval(secs => $2),
                  version = version + 1, updated_at = app_now()
            WHERE task_id = $1`,
          [row.task_id, backoffSeconds(cfg.retry_backoff_seconds, row.attempt_count)],
        );
        await appendEvent(c, {
          task_id: row.task_id,
          event_type: "TASK_RECLAIMED",
          from_status: row.task_status,
          to_status: "QUEUED",
          actor: "scheduler",
          payload: {
            attempt_id: row.attempt_id,
            cause,
            attempt_count: row.attempt_count,
            max_attempts: row.max_attempts,
            backoff_seconds: backoffSeconds(cfg.retry_backoff_seconds, row.attempt_count),
          },
        });
        out.push({ task_id: row.task_id, cause, to: "QUEUED" });
      }
    }

    return { reclaimed: out };
  });
}
