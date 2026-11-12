-- 010：主机角色、主机并入（联邦树）与部署工作能力值。
--
-- 架构规则：
--   1. 每台主机只有一个根调度机；它下面可以有多个叶构建机/结点调度机。
--   2. 主机 B 并入主机 A 后，B 的根调度机在 A 的树里是结点调度机；
--      B 自己仍然以根调度机的身份运行本地调度。parent_host_id 表达这棵树。
--   4. 主机角色三选一：containers（容器宿主）/ builder（直接作为构建机）/
--      scheduler（直接作为调度机）。当前版本记录角色，容器部署仍按 role_id 执行。

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
