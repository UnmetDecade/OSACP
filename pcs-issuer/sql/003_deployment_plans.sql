-- Deployment plan preview and digest binding (docs/admin-app-spec.md §4.6).
-- A plan stores only the intent and preview snapshot needed to build it; the digest is recomputed on apply,
-- so snapshot changes such as host deployment counts or instance generations result in 409 PLAN_CHANGED.

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
