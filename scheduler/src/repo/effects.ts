import { q, q1, tx, type Client } from "../db.js";
import { ApiError } from "../errors.js";
import { newId } from "../ids.js";
import { latestEventId } from "./outbox.js";

/**
 * Effects are named outbox consumers with a durable cursor.
 *
 * Pull returns events after the cursor (optionally filtered to one event type); ack advances the
 * cursor and clears the retry record; nack records the failure and leaves the cursor where it is.
 * The cursor only moves forward, so a consumer sees every event at least once and retries are
 * explicit rather than silent gaps.
 */

export interface EffectRow {
  effect_id: string;
  name: string;
  event_type: string | null;
  status: "ACTIVE" | "PAUSED";
  cursor: string | number;
  delivered_count: string | number;
  retry_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
  last_delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

function requireName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9._-]{2,64}$/.test(name)) {
    throw new ApiError(422, "BAD_REQUEST", "name must be 2-64 characters: letters, digits, dot, underscore, dash");
  }
  return name;
}

function requireCursor(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiError(422, "BAD_REQUEST", `${field} must be a non-negative integer`);
  }
  return n;
}

export async function createEffect(input: {
  name?: string;
  event_type?: string;
  /** Start after this event id; defaults to the latest event (no history replay). */
  after?: number;
}) {
  const name = requireName(input.name);
  const after = input.after === undefined ? await latestEventId() : requireCursor(input.after, "after");
  const eventType = input.event_type?.trim().slice(0, 120) || null;
  const row = await q1<EffectRow>(
    `INSERT INTO outbox_effects (effect_id, name, event_type, cursor)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO NOTHING
     RETURNING *`,
    [newId("eff"), name, eventType, after],
  );
  if (!row) throw new ApiError(409, "EFFECT_EXISTS", `effect already exists: ${name}`);
  return withLag(row);
}

export async function listEffects() {
  const rows = await q<EffectRow & { lag: string | number }>(
    `SELECT e.*,
            GREATEST(0, (SELECT max(event_id) FROM outbox_events) - e.cursor) AS lag
       FROM outbox_effects e
      ORDER BY e.created_at, e.name`,
  );
  return rows.map(withLag);
}

/** Normalize BIGINT values to numbers: pg returns int8 as a string. */
function withLag<T extends EffectRow & { lag?: string | number }>(row: T) {
  return {
    ...row,
    cursor: Number(row.cursor),
    delivered_count: Number(row.delivered_count),
    ...(row.lag !== undefined ? { lag: Number(row.lag) } : {}),
  };
}

async function requireEffect(c: Client, effectId: string): Promise<EffectRow> {
  const row = (await c.query(`SELECT * FROM outbox_effects WHERE effect_id = $1`, [effectId]))
    .rows[0] as EffectRow | undefined;
  if (!row) throw new ApiError(404, "NOT_FOUND", `effect not found: ${effectId}`);
  return row;
}

/**
 * Peek at the next batch without moving the cursor. A paused effect refuses delivery until it
 * is resumed, so an operator can stop a misbehaving consumer without losing its place.
 */
export async function pullEffectEvents(effectId: string, limit = 100) {
  const effect = await q1<EffectRow>(`SELECT * FROM outbox_effects WHERE effect_id = $1`, [effectId]);
  if (!effect) throw new ApiError(404, "NOT_FOUND", `effect not found: ${effectId}`);
  if (effect.status === "PAUSED") {
    throw new ApiError(409, "EFFECT_PAUSED", `effect is paused: ${effect.name}`);
  }
  const size = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const items = await q(
    `SELECT * FROM outbox_events
      WHERE event_id > $1
        AND ($2::text IS NULL OR event_type = $2)
      ORDER BY event_id
      LIMIT $3`,
    [Number(effect.cursor), effect.event_type, size],
  );
  return {
    effect: withLag(effect),
    items,
    next_cursor: items.length ? Number(items[items.length - 1].event_id) : Number(effect.cursor),
  };
}

/**
 * Advance the cursor after delivery. The cursor never moves backwards; a client that acks an
 * older position gets a conflict instead of silently replaying events.
 */
export async function ackEffect(effectId: string, after: number) {
  const target = requireCursor(after, "after");
  return tx(async (c) => {
    const effect = await requireEffect(c, effectId);
    const current = Number(effect.cursor);
    if (target < current) {
      throw new ApiError(409, "CURSOR_REGRESSION", `cursor is ${current}; cannot ack ${target}`);
    }
    if (target === current) return withLag(effect);
    const latest = Number(
      (await c.query(`SELECT COALESCE(max(event_id), 0) AS id FROM outbox_events`)).rows[0]?.id ?? 0,
    );
    const cursor = Math.min(target, latest);
    if (cursor === current) return withLag(effect);
    const delivered = Number(
      (
        await c.query(
          `SELECT count(*) AS n FROM outbox_events
            WHERE event_id > $1 AND event_id <= $2
              AND ($3::text IS NULL OR event_type = $3)`,
          [current, cursor, effect.event_type],
        )
      ).rows[0]?.n ?? 0,
    );
    const row = (
      await c.query(
        `UPDATE outbox_effects
            SET cursor = $2, delivered_count = delivered_count + $3,
                retry_count = 0, last_error = NULL,
                last_attempt_at = now(), last_delivered_at = now(), updated_at = now()
          WHERE effect_id = $1 RETURNING *`,
        [effectId, cursor, delivered],
      )
    ).rows[0] as EffectRow;
    return withLag(row);
  });
}

/** Record a delivery failure: retries and the last error are visible, the cursor stays put. */
export async function nackEffect(effectId: string, error: string) {
  const message = typeof error === "string" ? error.trim().slice(0, 2000) : "";
  const row = await q1<EffectRow>(
    `UPDATE outbox_effects
        SET retry_count = retry_count + 1, last_error = $2,
            last_attempt_at = now(), updated_at = now()
      WHERE effect_id = $1 RETURNING *`,
    [effectId, message || "delivery failed"],
  );
  if (!row) throw new ApiError(404, "NOT_FOUND", `effect not found: ${effectId}`);
  return withLag(row);
}

export async function setEffectStatus(effectId: string, status: "ACTIVE" | "PAUSED") {
  if (status !== "ACTIVE" && status !== "PAUSED") {
    throw new ApiError(422, "BAD_REQUEST", "status must be ACTIVE or PAUSED");
  }
  const row = await q1<EffectRow>(
    `UPDATE outbox_effects SET status = $2, updated_at = now()
      WHERE effect_id = $1 RETURNING *`,
    [effectId, status],
  );
  if (!row) throw new ApiError(404, "NOT_FOUND", `effect not found: ${effectId}`);
  return withLag(row);
}

export async function deleteEffect(effectId: string) {
  const row = await q1<EffectRow>(
    `DELETE FROM outbox_effects WHERE effect_id = $1 RETURNING *`,
    [effectId],
  );
  if (!row) throw new ApiError(404, "NOT_FOUND", `effect not found: ${effectId}`);
  return withLag(row);
}

/** Outbox health: how far behind the slowest effect is, and which event types dominate. */
export async function outboxStats() {
  const summary = (
    await q(
      `SELECT COALESCE(max(event_id), 0) AS latest_id, COALESCE(min(event_id), 0) AS oldest_id,
              count(*) AS total
         FROM outbox_events`,
    )
  )[0] ?? { latest_id: 0, oldest_id: 0, total: 0 };
  const types = await q(
    `SELECT event_type, count(*) AS count, max(event_id) AS last_event_id
       FROM outbox_events
      GROUP BY event_type
      ORDER BY count(*) DESC, event_type
      LIMIT 50`,
  );
  const effects = await listEffects();
  const maxLag = effects.reduce((max, e) => Math.max(max, e.lag ?? 0), 0);
  return {
    latest_event_id: Number(summary.latest_id),
    oldest_event_id: Number(summary.oldest_id),
    total_events: Number(summary.total),
    effect_count: effects.length,
    max_lag: maxLag,
    by_type: types.map((t) => ({
      event_type: t.event_type,
      count: Number(t.count),
      last_event_id: Number(t.last_event_id),
    })),
  };
}
