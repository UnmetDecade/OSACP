-- P4：任务信封中的 Agent / API Profile 引用。
-- 调度机只保存/回传引用，不解析 Profile 内容，也不接触密钥。

ALTER TABLE role_instances
  ADD COLUMN IF NOT EXISTS agent_profile_version TEXT,
  ADD COLUMN IF NOT EXISTS api_profile_ids TEXT[] NOT NULL DEFAULT '{}';
