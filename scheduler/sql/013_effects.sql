-- 013: Outbox effects
--
-- The outbox is the durable source of external notifications. An effect is a named consumer
-- that reads the outbox with a cursor: pull returns events after the cursor, ack advances it,
-- and nack records the failure without moving the cursor, so delivery is at-least-once and
-- retries are visible instead of silently dropped. Effects are pull-based: the consumer owns
-- its transport, and the scheduler only guarantees ordering and cursor durability.

CREATE TABLE IF NOT EXISTS outbox_effects (
  effect_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  -- NULL means every event type; otherwise only this event_type is delivered.
  event_type  TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED')),
  -- Last delivered outbox event_id; pull starts strictly after it.
  cursor      BIGINT NOT NULL DEFAULT 0,
  delivered_count BIGINT NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  last_attempt_at TIMESTAMPTZ,
  last_delivered_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cursor >= 0)
);

CREATE INDEX IF NOT EXISTS outbox_effects_status_idx ON outbox_effects (status, updated_at DESC);
