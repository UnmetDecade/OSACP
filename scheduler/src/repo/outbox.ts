import { q, q1 } from "../db.js";

/** outbox is the only reliable source for external event notifications; both SSE and the polling API read from it. */

export interface OutboxRow {
  event_id: string | number;
  event_type: string;
  schema_version: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string | null;
  occurred_at: string;
  trace_id: string | null;
  actor_id: string | null;
  idempotency_key: string | null;
  payload: unknown;
}

export async function listOutbox(after: number, limit = 200): Promise<OutboxRow[]> {
  return q<OutboxRow>(
    `SELECT * FROM outbox_events WHERE event_id > $1 ORDER BY event_id LIMIT $2`,
    [after, Math.min(Math.max(limit, 1), 1000)],
  );
}

/** New connections start from the current latest by default and only push events after connecting; reconnects resume with Last-Event-ID */
export async function latestEventId(): Promise<number> {
  const row = await q1<{ id: string | null }>(`SELECT max(event_id) AS id FROM outbox_events`);
  return Number(row?.id ?? 0);
}
