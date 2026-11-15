-- Versioned admission policy and per-task mandates.
--
-- The policy document decides which sources may create work and how strong the
-- authorization is; a mandate is the immutable record attached to each task
-- ("why this work is allowed, under which policy version"). The scheduler only
-- carries the mandate reference in task requirements, so no scheduler schema
-- change is needed.

CREATE TABLE IF NOT EXISTS pcs_policies (
  version    TEXT PRIMARY KEY,
  document   JSONB NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pcs_mandates (
  mandate_id     TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  source_id      TEXT,
  actor          TEXT NOT NULL,
  task_id        TEXT,
  host_id        TEXT,
  policy_version TEXT NOT NULL,
  strength       TEXT NOT NULL CHECK (strength IN ('explicit', 'inferred')),
  scopes         TEXT[] NOT NULL DEFAULT '{}',
  target         JSONB NOT NULL DEFAULT '{}',
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pcs_mandates_task_idx ON pcs_mandates (task_id);
CREATE INDEX IF NOT EXISTS pcs_mandates_host_idx ON pcs_mandates (host_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS pcs_mandates_actor_idx ON pcs_mandates (actor, issued_at DESC);
