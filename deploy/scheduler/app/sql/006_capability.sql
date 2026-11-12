-- 006：工作能力值（W）与任务难度（D），以及结点调度机上报。
--
-- W 由创建构建机的一方按核心数/频率/内存/磁盘/模型/API 六项加权算出 0–1000 的整数，
-- 随注册请求写入 role_instances；调度机领取任务时按 D <= W 过滤。
-- D = 0 表示“不限制”，兼容升级前的历史任务与未上报 W 的实例。

ALTER TABLE role_instances
  ADD COLUMN IF NOT EXISTS capability_score integer NOT NULL DEFAULT 0;
ALTER TABLE role_instances
  ADD COLUMN IF NOT EXISTS capability_detail jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS difficulty integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS tasks_claim_difficulty_idx
  ON tasks (difficulty) WHERE status = 'QUEUED';

-- 子结点调度机上报的聚合能力。每一级只保存直接子结点，树由 parent_node_id 还原；
-- subtree_score 由子结点自己递归算好，父结点直接相加，避免父结点重复遍历整棵树。
CREATE TABLE IF NOT EXISTS scheduler_nodes (
  node_id text PRIMARY KEY,
  parent_node_id text NULL,
  host_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('root', 'node')),
  local_score integer NOT NULL DEFAULT 0,
  subtree_score integer NOT NULL DEFAULT 0,
  builder_count integer NOT NULL DEFAULT 0,
  child_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduler_nodes_parent_idx
  ON scheduler_nodes (parent_node_id);
