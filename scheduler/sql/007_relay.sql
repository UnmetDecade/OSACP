-- 007：跨调度机任务中继（根 → 结点 → 孙结点）。
--
-- 根调度机把本机接不住的任务转给某个直接子结点；子结点照常用自己的
-- 构建机领取并执行，父结点按周期把状态和结果镜像回本地任务行。
-- 中继是「下推」而不是复制：同一时刻只允许一个结点持有任务。

-- 子结点上报时额外带上可达地址、最大构建机 W、空闲构建机数和子树实例名册，
-- 父结点据此决定把目标任务/高难度任务转给谁。
ALTER TABLE scheduler_nodes ADD COLUMN IF NOT EXISTS url text;
ALTER TABLE scheduler_nodes ADD COLUMN IF NOT EXISTS max_builder_score integer NOT NULL DEFAULT 0;
ALTER TABLE scheduler_nodes ADD COLUMN IF NOT EXISTS idle_builder_count integer NOT NULL DEFAULT 0;
ALTER TABLE scheduler_nodes
  ADD COLUMN IF NOT EXISTS instances jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 被中继的任务在父结点本地仍是 QUEUED，但不再参与本机领取；
-- relay_parent_task_id 同时保证同一个上游任务重复投递时只落一条。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS relay_parent_task_id text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS relay_depth integer NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result_summary text;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_relay_parent_uniq
  ON tasks (relay_parent_task_id)
  WHERE relay_parent_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_relays (
  parent_task_id text PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
  child_node_id  text NOT NULL,
  child_url      text NOT NULL,
  child_task_id  text NOT NULL,
  state          text NOT NULL DEFAULT 'ACTIVE'
                   CHECK (state IN ('ACTIVE', 'DONE', 'CANCELLED', 'ERROR')),
  child_state    text,
  child_result   jsonb,
  cancel_sent    boolean NOT NULL DEFAULT false,
  sync_failures  integer NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT app_now(),
  updated_at     timestamptz NOT NULL DEFAULT app_now()
);

CREATE INDEX IF NOT EXISTS task_relays_state_idx
  ON task_relays (state, updated_at);
