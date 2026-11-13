import { tx } from "../db.js";
import { appendEvent } from "../events.js";
import { backoffSeconds } from "../core/attempts.js";
import { settleFanout } from "../core/fanout.js";

/**
 * Lease reaping (§5).
 *
 * Two triggers share one reap path:
 *   1) start-window timeout: ASSIGNED and issued_at older than start_window_seconds
 *   2) lease expired: expires_at <= app_now()
 *
 * Reap = release lease + reservation RECLAIMED + attempt TIMEOUT + requeue task (with backoff) or dead-letter.
 * Each reap consumes one attempt; when retries are exhausted the task becomes FAILED + dead-letter.
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
                t.status AS task_status, t.attempt_count, t.max_attempts, t.fanout_id,
                a.status AS attempt_status, a.outward_actions
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

      // Release lease + reservation
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
      if (!["SUCCEEDED", "FAILED", "CANCELLED", "TIMEOUT", "PARKED"].includes(row.attempt_status)) {
        await c.query(
          `UPDATE task_attempts SET status = 'TIMEOUT', finished_at = app_now(),
                                    error = $2
            WHERE attempt_id = $1`,
          [row.attempt_id, JSON.stringify({ code: cause })],
        );
      }

      // The attempt already pushed / uploaded / deployed. It may have been interrupted halfway,
      // so rerunning it elsewhere could repeat a real side effect. Stop here and let a person decide.
      const outward = Array.isArray(row.outward_actions) ? row.outward_actions : [];
      if (outward.length > 0) {
        await c.query(
          `UPDATE tasks SET status = 'FAILED', outcome = 'interrupted_after_outward',
                            current_attempt_id = NULL, dead_letter = TRUE,
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
          payload: {
            attempt_id: row.attempt_id,
            cause,
            error_code: "INTERRUPTED_AFTER_OUTWARD_ACTION",
            outcome: "interrupted_after_outward",
            outward_actions: outward,
            non_retryable: true,
            alert: "P1",
          },
        });
        await settleFanout(c, { task_id: row.task_id, fanout_id: row.fanout_id });
        out.push({ task_id: row.task_id, cause, to: "FAILED" });
        continue;
      }

      if (row.attempt_count >= row.max_attempts) {
        await c.query(
          `UPDATE tasks SET status = 'FAILED', outcome = 'error', current_attempt_id = NULL,
                            dead_letter = TRUE, version = version + 1, updated_at = app_now()
            WHERE task_id = $1`,
          [row.task_id],
        );
        await appendEvent(c, {
          task_id: row.task_id,
          event_type: "TASK_DEAD_LETTERED",
          from_status: row.task_status,
          to_status: "FAILED",
          actor: "scheduler",
          payload: { attempt_id: row.attempt_id, cause, outcome: "error", alert: "P1" },
        });
        await settleFanout(c, { task_id: row.task_id, fanout_id: row.fanout_id });
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

/**
 * Expire parked questions.
 *
 * A NEEDS_INPUT task holds no lease, so nothing else would ever move it. Once the TTL passes
 * it becomes a non-retryable failure: rerunning it later would not answer the question either.
 */
export async function sweepNeedsInput(limit = 50): Promise<{ expired: string[] }> {
  return tx(async (c) => {
    const rows = (
      await c.query(
        `SELECT task_id, fanout_id, pending_question, needs_input_at
           FROM tasks
          WHERE status = 'NEEDS_INPUT'
            AND needs_input_expires_at IS NOT NULL
            AND needs_input_expires_at <= app_now()
          ORDER BY needs_input_expires_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1`,
        [limit],
      )
    ).rows;
    const expired: string[] = [];
    for (const row of rows) {
      await c.query(
        `UPDATE tasks SET status = 'FAILED', outcome = 'input_expired', dead_letter = TRUE,
                          current_attempt_id = NULL, version = version + 1, updated_at = app_now()
          WHERE task_id = $1`,
        [row.task_id],
      );
      await appendEvent(c, {
        task_id: row.task_id,
        event_type: "TASK_INPUT_EXPIRED",
        from_status: "NEEDS_INPUT",
        to_status: "FAILED",
        actor: "scheduler",
        payload: {
          outcome: "input_expired",
          question_chars: row.pending_question?.question ? String(row.pending_question.question).length : 0,
          asked_at: row.needs_input_at,
        },
      });
      await settleFanout(c, { task_id: row.task_id, fanout_id: row.fanout_id });
      expired.push(row.task_id);
    }
    return { expired };
  });
}
