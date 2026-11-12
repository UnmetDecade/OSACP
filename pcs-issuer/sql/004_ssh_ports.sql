-- v4：构建机 SSH 端口映射。
--
-- 容器内 sshd 监听固定端口（构建机 2222），部署时把宿主端口映射进去。
-- 端口属于部署意图的一部分：进入签名命令、部署记录与部署计划摘要。

ALTER TABLE pcs_deployments
  ADD COLUMN IF NOT EXISTS ports JSONB NOT NULL DEFAULT '[]';
