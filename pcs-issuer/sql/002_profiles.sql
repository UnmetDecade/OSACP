-- Agent / API profiles and bindings (docs/agent-api-spec.md §9).
-- Only references are stored here; no plaintext secrets are ever persisted. Secret values belong to the Secret Store.

CREATE TABLE IF NOT EXISTS agent_profiles (
  agent_profile_id     TEXT PRIMARY KEY,
  role_id              TEXT NOT NULL,
  name                 TEXT NOT NULL,
  version              TEXT NOT NULL,
  adapter              TEXT NOT NULL CHECK (adapter IN ('stdio-jsonrpc','http-local')),
  artifact_image       TEXT NOT NULL,
  entrypoint           JSONB NOT NULL DEFAULT '[]',
  args                 JSONB NOT NULL DEFAULT '[]',
  model_api_profile_id TEXT,
  tool_api_profile_ids TEXT[] NOT NULL DEFAULT '{}',
  limits               JSONB NOT NULL DEFAULT '{}',
  capabilities         TEXT[] NOT NULL DEFAULT '{}',
  -- [added] tool_ids allowed for this agent; an empty array means unrestricted (all permissions by default)
  allowed_tools        TEXT[] NOT NULL DEFAULT '{}',
  -- [added] task types this agent version can take on; the role is still constrained by the scheduler
  task_types           TEXT[] NOT NULL DEFAULT '{}',
  enabled              BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_profiles (
  api_profile_id   TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('llm','http','tool','storage')),
  base_url         TEXT NOT NULL,
  auth_type        TEXT NOT NULL CHECK (auth_type IN ('bearer','api_key','oauth2_client','mtls')),
  secret_ref       TEXT NOT NULL,
  scopes           TEXT[] NOT NULL DEFAULT '{}',
  quota            JSONB NOT NULL DEFAULT '{}',
  timeout_seconds  INTEGER NOT NULL DEFAULT 60,
  egress           TEXT,
  fallback         TEXT[] NOT NULL DEFAULT '{}',
  enabled          BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- [added] role_id is used to validate cross-role bindings; an instance's role comes from the registrar, and the PCS rejects self-contradictory bindings.
CREATE TABLE IF NOT EXISTS role_agent_bindings (
  instance_id      TEXT PRIMARY KEY,
  role_id          TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(agent_profile_id),
  bound_by         TEXT NOT NULL,
  bound_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_api_bindings (
  instance_id    TEXT NOT NULL,
  api_profile_id TEXT NOT NULL REFERENCES api_profiles(api_profile_id),
  bound_by       TEXT NOT NULL,
  bound_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, api_profile_id)
);

CREATE TABLE IF NOT EXISTS pcs_audit_logs (
  audit_id    BIGSERIAL PRIMARY KEY,
  action      TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  subject     TEXT NOT NULL,
  instance_id TEXT,
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pcs_audit_logs_created_idx ON pcs_audit_logs (created_at DESC);
