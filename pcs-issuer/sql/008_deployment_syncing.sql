-- 镜像不在目标主机时，控制面先把镜像运过去，再下发部署命令。
-- 同步期间部署状态是 SYNCING，界面显示“同步镜像”。
ALTER TABLE pcs_deployments DROP CONSTRAINT IF EXISTS pcs_deployments_status_check;
ALTER TABLE pcs_deployments ADD CONSTRAINT pcs_deployments_status_check CHECK (status IN
  ('PENDING','PLANNED','SYNCING','PULLING','STARTING','HEALTHY','FAILED','STOPPED','ROLLED_BACK','REMOVED'));
