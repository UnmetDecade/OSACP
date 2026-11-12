-- PCS 管理面（Host Runtime ↔ 平台控制服务）。对应 docs/host-runtime-spec.md §5–§9、§13。
-- 调度机的 hosts / role_instances 是调度视图；这里是 PCS 持有的期望态与命令队列。

CREATE TABLE IF NOT EXISTS pcs_hosts (
  host_id        TEXT PRIMARY KEY,
  hostname       TEXT NOT NULL,
  os             TEXT NOT NULL DEFAULT '',
  arch           TEXT NOT NULL DEFAULT '',
  fingerprint    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL CHECK (status IN
                   ('PENDING','ENROLLED','ONLINE','DEGRADED','OFFLINE','REVOKED')),
  labels         JSONB NOT NULL DEFAULT '{}',
  resources      JSONB NOT NULL DEFAULT '{}',
  devices        JSONB NOT NULL DEFAULT '[]',
  tools          JSONB NOT NULL DEFAULT '[]',
  enrolled_at    TIMESTAMPTZ,
  last_seen_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 一次性注册令牌只存哈希；原文只在创建时返回一次。
CREATE TABLE IF NOT EXISTS pcs_enrollment_tokens (
  token_hash     TEXT PRIMARY KEY,
  host_id        TEXT NOT NULL REFERENCES pcs_hosts(host_id) ON DELETE CASCADE,
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pcs_host_runtimes (
  host_id           TEXT PRIMARY KEY REFERENCES pcs_hosts(host_id) ON DELETE CASCADE,
  runtime_version   TEXT NOT NULL,
  container_runtime TEXT NOT NULL,
  capabilities      JSONB NOT NULL DEFAULT '{}',
  healthy           BOOLEAN NOT NULL DEFAULT false,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pcs_deployments (
  deployment_id    TEXT PRIMARY KEY,
  instance_id      TEXT NOT NULL,
  host_id          TEXT NOT NULL REFERENCES pcs_hosts(host_id),
  role_id          TEXT NOT NULL,
  display_name     TEXT,
  image            TEXT NOT NULL,
  previous_image   TEXT,
  desired_state    TEXT NOT NULL CHECK (desired_state IN ('RUNNING','STOPPED','REMOVED')),
  actual_state     TEXT NOT NULL DEFAULT 'PENDING' CHECK (actual_state IN
                     ('PENDING','STARTING','RUNNING','STOPPED','MISSING','REMOVED','FAILED')),
  config_version   BIGINT NOT NULL DEFAULT 1,
  generation       BIGINT NOT NULL DEFAULT 1,
  resource_profile JSONB NOT NULL DEFAULT '{}',
  env              JSONB NOT NULL DEFAULT '{}',
  volumes          JSONB NOT NULL DEFAULT '[]',
  network_policy   TEXT NOT NULL DEFAULT 'default',
  command          JSONB,
  status           TEXT NOT NULL CHECK (status IN
                     ('PENDING','PLANNED','SYNCING','PULLING','STARTING','HEALTHY','FAILED','STOPPED','ROLLED_BACK','REMOVED')),
  observed         JSONB NOT NULL DEFAULT '{}',
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pcs_deployments_host_idx ON pcs_deployments (host_id, status);
CREATE INDEX IF NOT EXISTS pcs_deployments_instance_idx ON pcs_deployments (instance_id);

-- Host Runtime 只领取本主机的命令；签名在 payload 里，PCS 不保存任何明文凭据。
CREATE TABLE IF NOT EXISTS pcs_commands (
  command_id      TEXT PRIMARY KEY,
  host_id         TEXT NOT NULL REFERENCES pcs_hosts(host_id),
  deployment_id   TEXT,
  instance_id     TEXT,
  command_type    TEXT NOT NULL,
  generation      BIGINT,
  payload         JSONB NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('PENDING','DELIVERED','ACKED','FAILED','EXPIRED')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  acked_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pcs_commands_pending_idx
  ON pcs_commands (host_id, state, created_at);

CREATE TABLE IF NOT EXISTS pcs_host_reports (
  host_id      TEXT PRIMARY KEY REFERENCES pcs_hosts(host_id) ON DELETE CASCADE,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
