-- 006: Capability score (W) and task difficulty (D), plus node scheduler reporting.
--
-- W is computed by whoever creates the builder as an integer 0–1000, weighting six items: cores/frequency/memory/disk/model/API,
-- and written to role_instances with the registration request; the scheduler filters claims by D <= W.
-- D = 0 means "unrestricted", compatible with pre-upgrade historical tasks and instances that never reported W.

ALTER TABLE role_instances
  ADD COLUMN IF NOT EXISTS capability_score integer NOT NULL DEFAULT 0;
ALTER TABLE role_instances
  ADD COLUMN IF NOT EXISTS capability_detail jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS difficulty integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS tasks_claim_difficulty_idx
  ON tasks (difficulty) WHERE status = 'QUEUED';

-- Aggregated capability reported by child schedulers. Each level stores only direct children; the tree is reconstructed from parent_node_id;
-- subtree_score is computed recursively by the child itself and simply summed by the parent, avoiding repeated whole-tree traversal.
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
