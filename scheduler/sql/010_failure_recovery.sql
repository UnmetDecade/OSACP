-- 010: Failure classification and recovery (v0.4)
--
-- A single retry policy is wrong for every failure:
--   * a usage/rate limit that resets in an hour is not solved by three short backoffs;
--   * a busy host is not a failure at all and must not consume the retry budget;
--   * a deterministic refusal is not retried at all.
-- The scheduler now classifies the failure first and then chooses the action. Waiting for an
-- external reset is bounded by retry_waivers so a permanently limited provider cannot park a task
-- forever. failure_class on the attempt records why, for the dead-letter view.
--
-- Idempotent: every migration re-runs on an existing database.

BEGIN;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS retry_waivers smallint NOT NULL DEFAULT 0;

ALTER TABLE task_attempts
  ADD COLUMN IF NOT EXISTS failure_class text,
  -- Grouping key over the normalized error text, so the same fleet-wide failure is one row.
  ADD COLUMN IF NOT EXISTS failure_signature text;

CREATE TABLE IF NOT EXISTS failure_signatures (
  signature     text PRIMARY KEY,
  kind          text NOT NULL,
  code          text NOT NULL,
  -- Normalized sample: paths, URLs, ids and numbers replaced; kept local as the readable title.
  sample        text,
  occurrences   bigint NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT app_now(),
  last_seen_at  timestamptz NOT NULL DEFAULT app_now()
);

CREATE INDEX IF NOT EXISTS failure_signatures_recent_idx
  ON failure_signatures (last_seen_at DESC);

COMMIT;
