import type { Client } from "../db.js";

/**
 * Release the task's currently unreleased lease and close its reservation in sync.
 *
 * Kept in its own module because every parking/terminal path needs it, and those paths
 * (attempts, fan-out) must not import the task repository — it imports them.
 */
export async function closeActiveLease(
  c: Pick<Client, "query">,
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
