-- Agent / API Profile 与绑定（docs/agent-api-spec.md §9）。
-- 这里只保存引用，绝不保存任何密钥明文；密钥值属于 Secret Store。

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
  -- [增补] 该 Agent 允许的 tool_id；空数组表示不限制（默认全部权限）
  allowed_tools        TEXT[] NOT NULL DEFAULT '{}',
  -- [增补] 该 Agent 版本可以承接的任务类型；角色仍由调度机限定
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

-- [增补] role_id 用于校验跨角色绑定；instance 的角色由注册方提供，PCS 不接受自相矛盾的绑定。
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
