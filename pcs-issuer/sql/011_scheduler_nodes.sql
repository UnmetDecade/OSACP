-- 011: a host can run multiple scheduler containers.
--
-- Architecture rules (架构图.html, figure 1):
--   1. Each host has at most one "root scheduler". It is the host's entry point for both internal and external traffic.
--   2. A root scheduler can have multiple "node schedulers" under it, and node schedulers in turn have builders/nodes,
--      all of these containers run on the same host and call each other over the container network.
--   3. A builder records which scheduler it registered with (scheduler_deployment_id),
--      otherwise multiple schedulers on the same host cannot tell their own builders apart.

ALTER TABLE pcs_deployments
  ADD COLUMN IF NOT EXISTS scheduler_role text,
  ADD COLUMN IF NOT EXISTS parent_deployment_id text,
  ADD COLUMN IF NOT EXISTS scheduler_url text,
  ADD COLUMN IF NOT EXISTS scheduler_deployment_id text;

DO $$
BEGIN
  ALTER TABLE pcs_deployments
    ADD CONSTRAINT pcs_deployments_scheduler_role_check
    CHECK (scheduler_role IS NULL OR scheduler_role IN ('root', 'node'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Legacy data: each host had only one scheduler at the time, and it is the root.
UPDATE pcs_deployments
   SET scheduler_role = 'root'
 WHERE role_id = 'scheduler'
   AND scheduler_role IS NULL
   AND status <> 'REMOVED';

-- Root scheduler uniqueness is enforced by the database: at most one active root per host.
CREATE UNIQUE INDEX IF NOT EXISTS pcs_deployments_root_scheduler_uniq
  ON pcs_deployments (host_id)
  WHERE role_id = 'scheduler' AND scheduler_role = 'root' AND status <> 'REMOVED';

CREATE INDEX IF NOT EXISTS pcs_deployments_parent_sched_idx
  ON pcs_deployments (parent_deployment_id);

CREATE INDEX IF NOT EXISTS pcs_deployments_builder_sched_idx
  ON pcs_deployments (scheduler_deployment_id);
