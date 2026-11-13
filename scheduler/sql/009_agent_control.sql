-- 009: Agent control (v0.4)
--
-- Three capabilities that all need durable scheduler state:
--   * NEEDS_INPUT: an attempt may stop and ask a person instead of failing or guessing.
--   * WAITING_CHILDREN: one task may be split into several child tasks that different
--     builders run in parallel; the parent resumes once every child is terminal.
--   * approval_mode + typed outcome: how much the executor may do without asking, and
--     what actually happened (done, denied, interrupted after an outward action, ...).
--
-- The file is idempotent: every migration re-runs on an existing database.

BEGIN;

-- ---------------------------------------------------------------- Defaults
ALTER TABLE scheduler_config
  -- Existing deployments run fully autonomous builders, so keep that as the default and let
  -- per-task or per-definition overrides tighten it. "ask" is never the default here: a
  -- stricter level than the deployment can execute would turn every build into a denial.
  ADD COLUMN IF NOT EXISTS default_approval_mode text NOT NULL DEFAULT 'full',
  -- How long a task may wait for a person's answer before it expires.
  ADD COLUMN IF NOT EXISTS needs_input_ttl_seconds integer NOT NULL DEFAULT 86400,
  -- Fan-out bounds: they keep a misbehaving agent from turning one task into an unbounded tree.
  ADD COLUMN IF NOT EXISTS max_fanout_children integer NOT NULL DEFAULT 16,
  ADD COLUMN IF NOT EXISTS max_fanout_depth integer NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS max_resume_rounds integer NOT NULL DEFAULT 8;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduler_config_approval_mode_chk'
  ) THEN
    ALTER TABLE scheduler_config
      ADD CONSTRAINT scheduler_config_approval_mode_chk
      CHECK (default_approval_mode IN ('ask', 'edits', 'auto', 'full'));
  END IF;
END $$;

-- ---------------------------------------------------------------- Task control fields
ALTER TABLE tasks
  -- ask: ask before acting | edits: edit files freely, ask before commands |
  -- auto: act within the workspace | full: no further gate (the deployment's current behaviour)
  ADD COLUMN IF NOT EXISTS approval_mode text NOT NULL DEFAULT 'full',
  ADD COLUMN IF NOT EXISTS outcome text,
  -- The question an agent parked on; cleared when an answer resumes the task.
  ADD COLUMN IF NOT EXISTS pending_question jsonb,
  ADD COLUMN IF NOT EXISTS needs_input_at timestamptz,
  ADD COLUMN IF NOT EXISTS needs_input_expires_at timestamptz,
  -- Set on a child task to the id of the task that split it. parent_task_id is also set, but
  -- it is shared with workflow phase chaining, so fan-out counting must not use it.
  ADD COLUMN IF NOT EXISTS fanout_id text,
  ADD COLUMN IF NOT EXISTS fanout_depth smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fanout_rounds smallint NOT NULL DEFAULT 0,
  -- Every resume (answer or settled children) counts here, not against the failure budget.
  ADD COLUMN IF NOT EXISTS resume_rounds smallint NOT NULL DEFAULT 0;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN
  ('QUEUED','ASSIGNED','RUNNING','SUCCEEDED','FAILED','BLOCKED','CANCELLED',
   'NEEDS_INPUT','WAITING_CHILDREN'));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_approval_mode_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_approval_mode_chk
  CHECK (approval_mode IN ('ask', 'edits', 'auto', 'full'));

-- ---------------------------------------------------------------- Attempt control fields
ALTER TABLE task_attempts
  ADD COLUMN IF NOT EXISTS outcome text,
  -- PARKED is an attempt that ended without success or failure and will be resumed by a new attempt.
  ADD COLUMN IF NOT EXISTS park_reason text,
  ADD COLUMN IF NOT EXISTS parked_at timestamptz,
  -- Append-only list of outward actions observed before/while the attempt ran. Its presence
  -- is what stops a lease expiry from blindly re-running side effects on another machine.
  ADD COLUMN IF NOT EXISTS outward_actions jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE task_attempts DROP CONSTRAINT IF EXISTS task_attempts_status_check;
ALTER TABLE task_attempts ADD CONSTRAINT task_attempts_status_check CHECK (status IN
  ('CREATED','STARTED','SUCCEEDED','FAILED','CANCELLED','TIMEOUT','PARKED'));

CREATE INDEX IF NOT EXISTS tasks_fanout_idx ON tasks (fanout_id, status);
CREATE INDEX IF NOT EXISTS tasks_needs_input_idx
  ON tasks (needs_input_expires_at) WHERE status = 'NEEDS_INPUT';

COMMIT;
