-- 010: host roles, host federation (federation tree), and deployment capability scores.
--
-- Architecture rules:
--   1. Each host has exactly one root scheduler; below it there can be multiple leaf builders/node schedulers.
--   2. After host B joins host A, B's root scheduler is a node scheduler in A's tree;
--      B itself still runs local scheduling as a root scheduler. parent_host_id expresses this tree.
--   4. Host role is one of three: containers (container host) / builder (acts directly as a builder) /
--      scheduler (acts directly as a scheduler). The current version records the role; container deployments still go by role_id.

ALTER TABLE pcs_hosts
  ADD COLUMN IF NOT EXISTS parent_host_id text REFERENCES pcs_hosts(host_id) ON DELETE SET NULL;

ALTER TABLE pcs_hosts
  ADD COLUMN IF NOT EXISTS role_mode text NOT NULL DEFAULT 'containers';

DO $$
BEGIN
  ALTER TABLE pcs_hosts
    ADD CONSTRAINT pcs_hosts_role_mode_check
    CHECK (role_mode IN ('containers', 'builder', 'scheduler'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS pcs_hosts_parent_idx ON pcs_hosts (parent_host_id);

ALTER TABLE pcs_deployments
  ADD COLUMN IF NOT EXISTS capability_score integer NOT NULL DEFAULT 0;
ALTER TABLE pcs_deployments
  ADD COLUMN IF NOT EXISTS capability_detail jsonb NOT NULL DEFAULT '{}'::jsonb;
