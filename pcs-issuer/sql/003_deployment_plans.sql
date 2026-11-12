-- 部署计划预览与摘要绑定（docs/admin-app-spec.md §4.6）。
-- 计划只保存构建计划所需的意图与预览快照；apply 时重新计算摘要，
-- 主机部署数量、实例 generation 等快照变化都会导致 409 PLAN_CHANGED。

CREATE TABLE IF NOT EXISTS deployment_plans (
  plan_id      TEXT PRIMARY KEY,
  plan_digest  TEXT NOT NULL,
  intent       JSONB NOT NULL,
  plan         JSONB NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  applied_at   TIMESTAMPTZ,
  deployment_ids TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS deployment_plans_expires_idx
  ON deployment_plans (expires_at);
