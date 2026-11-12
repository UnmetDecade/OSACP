-- 013: a host can act as a role directly (bare metal) without packaging the role in a container.
--
-- execution = container: Docker container (default, preserving the semantics of all legacy records).
-- execution = native: the host runtime launches the role process directly on the host machine.
--                   Currently used only for builders with role_mode=builder.

ALTER TABLE pcs_deployments
  ADD COLUMN IF NOT EXISTS execution TEXT NOT NULL DEFAULT 'container';

DO $$
BEGIN
  ALTER TABLE pcs_deployments
    ADD CONSTRAINT pcs_deployments_execution_check
    CHECK (execution IN ('container', 'native'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS pcs_deployments_execution_idx
  ON pcs_deployments (host_id, execution)
  WHERE status <> 'REMOVED';
