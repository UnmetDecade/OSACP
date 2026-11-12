import type { Client } from "./db.js";

export interface EventInput {
  task_id: string;
  event_type: string;
  from_status?: string | null;
  to_status?: string | null;
  actor?: string | null;
  payload?: unknown;
  trace_id?: string | null;
}

/**
 * 事件只追加，与状态变更同事务（§4.4）。
 *
 * 同时写 outbox_events（§8.1）：task_events 是审计视野，outbox 是对外通知的
 * 唯一可靠来源。两者必须在一个事务里落库，否则界面看到的事件和数据库状态会分叉。
 */
export async function appendEvent(c: Client, e: EventInput): Promise<void> {
  await c.query(
    `INSERT INTO task_events (task_id, event_type, from_status, to_status, actor, payload, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.task_id,
      e.event_type,
      e.from_status ?? null,
      e.to_status ?? null,
      e.actor ?? null,
      e.payload === undefined ? null : JSON.stringify(e.payload),
      e.trace_id ?? null,
    ],
  );

  const version = (
    await c.query(`SELECT version FROM tasks WHERE task_id = $1`, [e.task_id])
  ).rows[0]?.version;

  await c.query(
    `INSERT INTO outbox_events
       (event_type, schema_version, aggregate_type, aggregate_id, aggregate_version,
        trace_id, actor_id, idempotency_key, payload)
     VALUES ($1, '1.0', 'task', $2, $3, $4, $5, $6, $7)`,
    [
      e.event_type,
      e.task_id,
      version ?? null,
      e.trace_id ?? null,
      e.actor ?? null,
      `${e.task_id}:${e.event_type}:${version ?? 0}`,
      JSON.stringify({
        task_id: e.task_id,
        from_status: e.from_status ?? null,
        to_status: e.to_status ?? null,
        ...(e.payload && typeof e.payload === "object" ? { payload: e.payload } : {}),
      }),
    ],
  );
}
