-- Scheduler skeleton · initial schema
-- Corresponds to docs/scheduler-spec.md §9; fields/tables marked [supplemental] are required by the implementation but not listed in the spec.

BEGIN;

-- ---------------------------------------------------------------- Clock
-- All timestamps come from app_now(), not the process clock and not the now() literal.
-- In production offset_ms is always 0, so app_now() is equivalent to now();
-- Tests use it to "time travel" instead of actually sleeping 45 seconds waiting for SUSPECT.
CREATE TABLE IF NOT EXISTS _clock (
  id        BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  offset_ms BIGINT  NOT NULL DEFAULT 0
);
INSERT INTO _clock (id, offset_ms) VALUES (TRUE, 0) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION app_now() RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT now() + make_interval(secs => (SELECT offset_ms / 1000.0 FROM _clock LIMIT 1))
$$;

-- Effective priority after aging: lower numbers are higher priority (P0 is highest).
-- P0 does not age; everything else gains one level per full aging_after_seconds, capped at P1.
CREATE OR REPLACE FUNCTION effective_priority(
  p_priority SMALLINT, p_enqueued TIMESTAMPTZ, p_aging INTEGER DEFAULT 600
) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_priority = 0 THEN 0
    ELSE GREATEST(1, p_priority - (EXTRACT(EPOCH FROM (app_now() - p_enqueued)) / p_aging)::int)
  END
$$;

-- ---------------------------------------------------------------- Config tables (owned by PCS, read-only to the scheduler)
CREATE TABLE IF NOT EXISTS task_definitions (
  task_type        TEXT PRIMARY KEY,
  task_version     TEXT NOT NULL,
  target_role      TEXT NOT NULL,
  capabilities     TEXT[] NOT NULL DEFAULT '{}',
  input_schema     JSONB,
  output_schema    JSONB,
  default_profile  TEXT,
  max_attempts     SMALLINT NOT NULL DEFAULT 3,
  retryable_errors TEXT[] NOT NULL DEFAULT '{}'   -- [supplemental] Empty means "everything is retryable except non-retryable errors"
);

CREATE TABLE IF NOT EXISTS resource_profiles (
  profile_id      TEXT PRIMARY KEY,
  cpu_millicores  INTEGER NOT NULL,
  memory_bytes    BIGINT NOT NULL,
  disk_bytes      BIGINT NOT NULL DEFAULT 0,
  timeout_seconds INTEGER NOT NULL DEFAULT 3600
);

CREATE TABLE IF NOT EXISTS hosts (
  host_id             TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  os                  TEXT NOT NULL,
  arch                TEXT NOT NULL,
  host_state          TEXT NOT NULL CHECK (host_state IN
                        ('NORMAL','WARNING','THROTTLED','PROTECTING','RECOVERING')),
  cpu_total           INTEGER NOT NULL DEFAULT 4,
  mem_total_bytes     BIGINT NOT NULL,
  mem_available_bytes BIGINT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

CREATE TABLE IF NOT EXISTS role_instances (
  instance_id        TEXT PRIMARY KEY,
  role_id            TEXT NOT NULL,
  host_id            TEXT NOT NULL REFERENCES hosts(host_id),
  state              TEXT NOT NULL CHECK (state IN
                       ('PROVISIONING','STARTING','ONLINE','SUSPECT','DRAINING','OFFLINE','FAILED')),
  agent_profile_id   TEXT,
  allowed_task_types TEXT[] NOT NULL DEFAULT '{}',
  capabilities       JSONB NOT NULL DEFAULT '{"healthy":[]}',
  config_version     BIGINT NOT NULL DEFAULT 1,
  protocol_version   TEXT NOT NULL DEFAULT '1.0',
  payload_schemas    TEXT[] NOT NULL DEFAULT ARRAY['1.0'],
  last_heartbeat_at  TIMESTAMPTZ,
  load               JSONB NOT NULL DEFAULT '{}',
  -- [supplemental] drain deadline: not finished in time → OFFLINE (§7.10)
  drain_deadline_at  TIMESTAMPTZ,
  -- [supplemental] Capability ceiling configured in PCS: the capabilities endpoint can only narrow, not widen (§7.3)
  capability_ceiling TEXT[],
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

CREATE TABLE IF NOT EXISTS scheduler_config (
  id                  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  global_limit        INTEGER NOT NULL DEFAULT 100,
  role_pool_limit     INTEGER NOT NULL DEFAULT 20,
  instance_limit      INTEGER NOT NULL DEFAULT 1,
  task_type_limit     INTEGER NOT NULL DEFAULT 10,
  aging_after_seconds INTEGER NOT NULL DEFAULT 600,
  lease_seconds       INTEGER NOT NULL DEFAULT 300,
  start_window_seconds INTEGER NOT NULL DEFAULT 30,
  suspect_after_seconds INTEGER NOT NULL DEFAULT 45,
  offline_after_seconds INTEGER NOT NULL DEFAULT 90,
  retry_backoff_seconds INTEGER[] NOT NULL DEFAULT ARRAY[300, 900, 2700],  -- 5m → 15m → 45m
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO scheduler_config (id) VALUES (TRUE) ON CONFLICT DO NOTHING;

-- Idempotent column additions: this skeleton has no migration tool, so re-running 001 patches an old database
ALTER TABLE scheduler_config
  ADD COLUMN IF NOT EXISTS retry_backoff_seconds INTEGER[] NOT NULL DEFAULT ARRAY[300, 900, 2700];
ALTER TABLE role_instances
  ADD COLUMN IF NOT EXISTS drain_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capability_ceiling TEXT[];

-- ---------------------------------------------------------------- Workflows
-- Templates are maintained by PCS; the scheduler is read-only (§7.1)
CREATE TABLE IF NOT EXISTS workflow_templates (
  workflow_template_id TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  version              TEXT NOT NULL,
  phases               JSONB NOT NULL,
  approval_policy_ref  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  workflow_run_id      TEXT PRIMARY KEY,
  workflow_template_id TEXT NOT NULL,
  template_version     TEXT NOT NULL,
  status               TEXT NOT NULL,
  current_phase        TEXT,
  root_task_id         TEXT,
  -- [supplemental] Task for the current phase; the APPROVE phase has no task, so the previous phase task is kept for binding the approval subject
  current_task_id      TEXT,
  -- [supplemental] Cross-phase context (priority, resource profile, etc.), copied to the next phase task on advance
  context              JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS current_task_id TEXT,
  ADD COLUMN IF NOT EXISTS context JSONB NOT NULL DEFAULT '{}';

-- Pending approvals (§7.3): approvals is written only after the decision; this records "who must approve what".
-- Created after tasks because task_id has a foreign key.

-- ---------------------------------------------------------------- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  task_id               TEXT PRIMARY KEY,
  task_type             TEXT NOT NULL,
  task_version          TEXT NOT NULL,
  workflow_run_id       TEXT REFERENCES workflow_runs(workflow_run_id),
  parent_task_id        TEXT REFERENCES tasks(task_id),
  priority_class        SMALLINT NOT NULL CHECK (priority_class BETWEEN 0 AND 3),
  status                TEXT NOT NULL CHECK (status IN
                          ('QUEUED','ASSIGNED','RUNNING','SUCCEEDED','FAILED','BLOCKED','CANCELLED')),
  payload_ref           TEXT,
  payload_sha256        TEXT,
  payload_schema        TEXT NOT NULL,
  requirements          JSONB NOT NULL DEFAULT '{}',
  resource_profile_id   TEXT NOT NULL REFERENCES resource_profiles(profile_id),
  resource_block_reason TEXT,
  resource_evaluated_at TIMESTAMPTZ,
  attempt_count         SMALLINT NOT NULL DEFAULT 0,
  max_attempts          SMALLINT NOT NULL DEFAULT 3,
  current_attempt_id    TEXT,
  enqueued_at           TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  deadline_at           TIMESTAMPTZ,
  cancel_requested_at   TIMESTAMPTZ,
  -- [supplemental] Backoff window: non-null and not yet elapsed means not claimable
  next_attempt_at       TIMESTAMPTZ,
  -- [supplemental] Dead-letter marker
  dead_letter           BOOLEAN NOT NULL DEFAULT FALSE,
  version               BIGINT NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

CREATE TABLE IF NOT EXISTS approval_requests (
  approval_request_id TEXT PRIMARY KEY,
  workflow_run_id     TEXT NOT NULL REFERENCES workflow_runs(workflow_run_id),
  task_id             TEXT NOT NULL REFERENCES tasks(task_id),
  status              TEXT NOT NULL CHECK (status IN
                         ('PENDING','APPROVED','REJECTED','INVALIDATED','EXPIRED')),
  subject_digest      TEXT,
  action_scope        TEXT[] NOT NULL DEFAULT '{}',
  policy_version      TEXT,
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  decided_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_one_pending
  ON approval_requests (task_id) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS task_attempts (
  attempt_id        TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_number    SMALLINT NOT NULL,
  instance_id       TEXT NOT NULL,
  host_id           TEXT NOT NULL,
  agent_profile_id  TEXT,
  status            TEXT NOT NULL CHECK (status IN
                      ('CREATED','STARTED','SUCCEEDED','FAILED','CANCELLED','TIMEOUT')),
  result_summary    TEXT,
  outputs           JSONB,
  error             JSONB,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  UNIQUE (task_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS leases (
  lease_token       TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id        TEXT NOT NULL REFERENCES task_attempts(attempt_id),
  instance_id       TEXT NOT NULL,
  fencing_token     BIGINT NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  released_at       TIMESTAMPTZ,
  release_reason    TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  event_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id           TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  from_status       TEXT,
  to_status         TEXT,
  actor             TEXT,
  payload           JSONB,
  trace_id          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

-- Reliable event source (protocol §8.1): written in the same transaction as state transitions, append-only.
-- SSE / polling notifications both read from here; notifications may be lost, but only this table is source of truth.
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type        TEXT NOT NULL,
  schema_version    TEXT NOT NULL DEFAULT '1.0',
  aggregate_type    TEXT NOT NULL,
  aggregate_id      TEXT NOT NULL,
  aggregate_version BIGINT,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  trace_id          TEXT,
  actor_id          TEXT,
  idempotency_key   TEXT,
  payload           JSONB
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id       TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  workflow_run_id   TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  operator_id       TEXT NOT NULL,
  comment           TEXT,
  approval_token    TEXT NOT NULL UNIQUE,
  subject_digest    TEXT NOT NULL,
  action_scope      TEXT[] NOT NULL,
  policy_version    TEXT NOT NULL,
  invalidated_at    TIMESTAMPTZ,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

-- jti of the approval token: a token can be persisted only once
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS token_jti TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS approvals_token_jti
  ON approvals (token_jti) WHERE token_jti IS NOT NULL;
-- Approvals with no bound digest (e.g. workflows without artifacts) may be null
ALTER TABLE approvals ALTER COLUMN subject_digest DROP NOT NULL;

-- Artifacts (§7.8): the scheduler records only metadata and storage references, never parses content.
-- declared_sha256 is declared by the uploader; on complete the server recomputes actual_sha256 and compares.
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id     TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id      TEXT REFERENCES task_attempts(attempt_id),
  instance_id     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETE','FAILED')),
  declared_sha256 TEXT NOT NULL,
  actual_sha256   TEXT,
  size_bytes      BIGINT,
  media_type      TEXT,
  storage_ref     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts (task_id, status);

CREATE TABLE IF NOT EXISTS resource_reservations (
  grant_id        TEXT PRIMARY KEY,
  host_id         TEXT NOT NULL,
  instance_id     TEXT NOT NULL,
  task_id         TEXT,
  attempt_id      TEXT,
  profile_id      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('DEPLOYMENT','TASK')),
  state           TEXT NOT NULL CHECK (state IN ('HELD','ACTIVE','RELEASED','RECLAIMED')),
  cpu_millicores  INTEGER,
  memory_bytes    BIGINT,
  disk_bytes      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  activated_at    TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  close_reason    TEXT,
  CHECK (kind <> 'TASK' OR (task_id IS NOT NULL AND attempt_id IS NOT NULL))
);

-- ---------------------------------------------------------------- Invariants
-- Events are append-only: any UPDATE/DELETE raises an error (§4.4)
CREATE OR REPLACE FUNCTION append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task_events is append-only (attempted %)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS task_events_append_only ON task_events;
CREATE TRIGGER task_events_append_only
  BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW EXECUTE FUNCTION append_only();

DROP TRIGGER IF EXISTS outbox_events_append_only ON outbox_events;
CREATE TRIGGER outbox_events_append_only
  BEFORE UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- At most one unreleased lease per task at any moment (the last gate against duplicate claims by multiple instances)
CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_per_task
  ON leases (task_id) WHERE released_at IS NULL;

-- ---------------------------------------------------------------- Indexes
CREATE INDEX IF NOT EXISTS tasks_claim_idx
  ON tasks (status, priority_class, enqueued_at, task_id);
CREATE INDEX IF NOT EXISTS tasks_workflow_idx ON tasks (workflow_run_id);
CREATE INDEX IF NOT EXISTS tasks_block_reason_idx
  ON tasks (resource_block_reason) WHERE resource_block_reason IS NOT NULL;
CREATE INDEX IF NOT EXISTS leases_expiry_idx
  ON leases (expires_at) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id, created_at);
CREATE INDEX IF NOT EXISTS outbox_events_aggregate_idx
  ON outbox_events (aggregate_type, aggregate_id, event_id);
CREATE INDEX IF NOT EXISTS reservations_host_idx ON resource_reservations (host_id, state);
CREATE INDEX IF NOT EXISTS instances_heartbeat_idx ON role_instances (last_heartbeat_at);

COMMIT;
