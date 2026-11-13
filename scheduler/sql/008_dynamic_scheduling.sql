-- 008: Dynamic scheduling (v0.3)
--
-- Adds the scheduler-side ledger for static/dynamic scheduling:
--   * host resource pool capacity and live cgroup metrics
--   * per-instance cap / demand / live capability fields
--   * grant generations applied by host-runtime (PENDING -> APPLIED)
--   * durable claim backoff fields, so a blocked head-of-line task no longer stalls the queue
--
-- The file is idempotent: every migration re-runs on an existing database.

BEGIN;

-- ---------------------------------------------------------------- Queue / admission tuning
ALTER TABLE scheduler_config
  ADD COLUMN IF NOT EXISTS max_candidate_scan integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS backoff_base_seconds integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS backoff_max_seconds integer NOT NULL DEFAULT 60,
  -- How many tasks of one type a single builder may run at once (§9.1 k_max).
  ADD COLUMN IF NOT EXISTS task_type_instance_limit integer NOT NULL DEFAULT 4,
  -- Consecutive task-specific resource blocks before the task is marked unschedulable.
  ADD COLUMN IF NOT EXISTS max_blocked_attempts integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS scheduling_mode text NOT NULL DEFAULT 'static',
  ADD COLUMN IF NOT EXISTS dynamic_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduler_config_scheduling_mode_chk'
  ) THEN
    ALTER TABLE scheduler_config
      ADD CONSTRAINT scheduler_config_scheduling_mode_chk
      CHECK (scheduling_mode IN ('static', 'dynamic'));
  END IF;
END $$;

-- ---------------------------------------------------------------- Instance capability / capacity
ALTER TABLE role_instances
  ADD COLUMN IF NOT EXISTS scheduling_mode text NOT NULL DEFAULT 'static',
  -- Instance cap: deployment resource_profile, in the scheduler's integer units.
  ADD COLUMN IF NOT EXISTS cap_cpu_millicores integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cap_mem_bytes bigint NOT NULL DEFAULT 0,
  -- v0.3 capability split. capability_score remains the legacy frozen W for compatibility.
  ADD COLUMN IF NOT EXISTS capability_static_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capability_ceiling_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capability_live_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capability_dispatch_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capability_guaranteed_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capability_schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS capability_updated_at timestamptz,
  -- Latest per-instance usage reported by host-runtime; used for demand only.
  ADD COLUMN IF NOT EXISTS usage_mem_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_cpu_millicores integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'role_instances_scheduling_mode_chk'
  ) THEN
    ALTER TABLE role_instances
      ADD CONSTRAINT role_instances_scheduling_mode_chk
      CHECK (scheduling_mode IN ('static', 'dynamic'));
  END IF;
END $$;

-- ---------------------------------------------------------------- Task head-of-line blocking
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS resource_retry_after timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unschedulable boolean NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS tasks_claim_ready_idx
  ON tasks (status, resource_retry_after, enqueued_at)
  WHERE status = 'QUEUED' AND unschedulable = FALSE;

-- ---------------------------------------------------------------- Host resource pool
-- One row per host. Capacity (C_mem/C_cpu) is the same number used by pool.slice
-- and by the fair-share ledger, so the account and the kernel limit never disagree.
CREATE TABLE IF NOT EXISTS host_resource_pools (
  host_id                    text PRIMARY KEY REFERENCES hosts(host_id) ON DELETE CASCADE,
  pool_id                    text NOT NULL DEFAULT 'osacp.slice/pool.slice',
  cgroup_available           boolean NOT NULL DEFAULT FALSE,
  cgroup_driver              text NOT NULL DEFAULT 'cgroupfs',
  cpu_total_millicores       integer NOT NULL DEFAULT 0,
  mem_total_bytes            bigint NOT NULL DEFAULT 0,
  cpu_granted_millicores     integer NOT NULL DEFAULT 0,
  mem_granted_bytes          bigint NOT NULL DEFAULT 0,
  cpu_used_millicores        integer NOT NULL DEFAULT 0,
  mem_used_bytes             bigint NOT NULL DEFAULT 0,
  mem_working_set_bytes      bigint NOT NULL DEFAULT 0,
  available_commitment_bytes bigint NOT NULL DEFAULT 0,
  pressure_state             text NOT NULL DEFAULT 'NORMAL'
                               CHECK (pressure_state IN ('NORMAL','BUSY','PRESSURE','CRITICAL','RECOVERING')),
  psi                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  cgroup                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  reported_at                timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT app_now()
);

-- ---------------------------------------------------------------- Grants
-- One current grant row per instance. generation is monotonic per instance.
-- Host-runtime applies the values to the builder cgroup and reports them back as APPLIED.
CREATE TABLE IF NOT EXISTS resource_grants (
  host_id            text NOT NULL,
  instance_id        text NOT NULL,
  generation         bigint NOT NULL DEFAULT 1,
  cpu_millicores     integer NOT NULL DEFAULT 0,
  memory_bytes       bigint NOT NULL DEFAULT 0,
  memory_low_bytes   bigint NOT NULL DEFAULT 0,
  memory_high_bytes  bigint NOT NULL DEFAULT 0,
  cpu_weight         integer NOT NULL DEFAULT 1,
  state              text NOT NULL DEFAULT 'PENDING'
                       CHECK (state IN ('PENDING','APPLYING','APPLIED','FAILED','SUPERSEDED')),
  applied_generation bigint,
  applied_cpu_millicores integer,
  applied_memory_bytes bigint,
  applied_memory_low_bytes bigint,
  applied_memory_high_bytes bigint,
  applied_cpu_weight integer,
  applied_at         timestamptz,
  last_error         text,
  updated_at         timestamptz NOT NULL DEFAULT app_now(),
  PRIMARY KEY (host_id, instance_id)
);

CREATE INDEX IF NOT EXISTS resource_grants_state_idx
  ON resource_grants (host_id, state);

-- ---------------------------------------------------------------- Federation snapshot
ALTER TABLE scheduler_nodes
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'static',
  ADD COLUMN IF NOT EXISTS max_builder_ceiling integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_builder_live integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS guaranteed_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_commitment_mem_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pressure_state text NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS stale boolean NOT NULL DEFAULT FALSE;

-- Legacy rows: keep max_builder_score as the ceiling until the next report fills the new columns.
UPDATE scheduler_nodes
   SET max_builder_ceiling = GREATEST(max_builder_ceiling, max_builder_score)
 WHERE max_builder_ceiling = 0;

COMMIT;
