-- 007: Cross-scheduler task relay (root → node → grandchild).
--
-- The root scheduler forwards tasks it cannot handle to one of its direct children; the child uses its own
-- builders to claim and execute, and the parent periodically mirrors status and results back to its local task row.
-- Relay is "push-down", not replication: at any moment only one node may hold the task.

-- Child reports also carry the reachable address, max builder W, idle builder count and subtree instance roster,
-- which the parent uses to decide which child gets targeted or high-difficulty tasks.
ALTER TABLE scheduler_nodes ADD COLUMN IF NOT EXISTS url text;
ALTER TABLE scheduler_nodes ADD COLUMN IF NOT EXISTS max_builder_score integer NOT NULL DEFAULT 0;
ALTER TABLE scheduler_nodes ADD COLUMN IF NOT EXISTS idle_builder_count integer NOT NULL DEFAULT 0;
ALTER TABLE scheduler_nodes
  ADD COLUMN IF NOT EXISTS instances jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A relayed task remains QUEUED locally on the parent but no longer participates in local claims;
-- relay_parent_task_id also ensures a repeatedly delivered upstream task creates only one row.
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
