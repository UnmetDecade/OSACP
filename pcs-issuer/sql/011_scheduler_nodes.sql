-- 011：一台主机可以跑多个调度机容器。
--
-- 架构规则（架构图.html 图 1）：
--   1. 每台主机最多一个「根调度机」。它是这台主机对内、对外的入口。
--   2. 根调度机下面可以挂多个「结点调度机」，结点调度机再挂构建机/结点，
--      这些容器都在同一台主机上，彼此通过容器网络调用。
--   3. 构建机记录自己注册到哪台调度机（scheduler_deployment_id），
--      否则同一台主机上的多个调度机无法区分各自名下的构建机。

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

-- 旧数据：每台主机当时只有一个调度机，它就是根。
UPDATE pcs_deployments
   SET scheduler_role = 'root'
 WHERE role_id = 'scheduler'
   AND scheduler_role IS NULL
   AND status <> 'REMOVED';

-- 根调度机唯一性由数据库兜底：同一台主机最多一个活动根。
CREATE UNIQUE INDEX IF NOT EXISTS pcs_deployments_root_scheduler_uniq
  ON pcs_deployments (host_id)
  WHERE role_id = 'scheduler' AND scheduler_role = 'root' AND status <> 'REMOVED';

CREATE INDEX IF NOT EXISTS pcs_deployments_parent_sched_idx
  ON pcs_deployments (parent_deployment_id);

CREATE INDEX IF NOT EXISTS pcs_deployments_builder_sched_idx
  ON pcs_deployments (scheduler_deployment_id);
