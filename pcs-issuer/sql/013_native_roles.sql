-- 013：主机可以直接充当角色（裸机），不必把角色装进容器。
--
-- execution = container：Docker 容器（默认，保持所有旧记录语义）。
-- execution = native：主机运行时直接在宿主机上拉起角色进程。
--                   目前只用于 role_mode=builder 的构建机。

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
