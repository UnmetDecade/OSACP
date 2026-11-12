-- 调度机骨架 · 初始 schema
-- 对应 docs/scheduler-spec.md §9；标注 [增补] 的是实现所需、规范未列出的字段/表。

BEGIN;

-- ---------------------------------------------------------------- 时钟
-- 所有时间戳都取 app_now()，而不是进程时钟，也不是 now() 字面量。
-- 生产环境 offset_ms 恒为 0，app_now() 与 now() 等价；
-- 测试用它可以“时间旅行”，不必真的 sleep 45 秒来等 SUSPECT。
CREATE TABLE IF NOT EXISTS _clock (
  id        BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  offset_ms BIGINT  NOT NULL DEFAULT 0
);
INSERT INTO _clock (id, offset_ms) VALUES (TRUE, 0) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION app_now() RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT now() + make_interval(secs => (SELECT offset_ms / 1000.0 FROM _clock LIMIT 1))
$$;

-- 老化后的有效优先级：数字越小优先级越高（P0 最高）。
-- P0 不参与老化；其余每满 aging_after_seconds 提升一级，封顶 P1。
CREATE OR REPLACE FUNCTION effective_priority(
  p_priority SMALLINT, p_enqueued TIMESTAMPTZ, p_aging INTEGER DEFAULT 600
) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_priority = 0 THEN 0
    ELSE GREATEST(1, p_priority - (EXTRACT(EPOCH FROM (app_now() - p_enqueued)) / p_aging)::int)
  END
$$;

-- ---------------------------------------------------------------- 配置表（PCS 所有，调度机只读）
CREATE TABLE IF NOT EXISTS task_definitions (
  task_type        TEXT PRIMARY KEY,
  task_version     TEXT NOT NULL,
  target_role      TEXT NOT NULL,
  capabilities     TEXT[] NOT NULL DEFAULT '{}',
  input_schema     JSONB,
  output_schema    JSONB,
  default_profile  TEXT,
  max_attempts     SMALLINT NOT NULL DEFAULT 3,
  retryable_errors TEXT[] NOT NULL DEFAULT '{}'   -- [增补] 空表示“除不可重试错误外都可重试”
);

CREATE TABLE IF NOT EXISTS resource_profiles (
  profile_id      TEXT PRIMARY KEY,
  cpu_millicores  INTEGER NOT NULL,
  memory_bytes    BIGINT NOT NULL,
  disk_bytes      BIGINT NOT NULL DEFAULT 0,
  timeout_seconds INTEGER NOT NULL DEFAULT 3600
);

CREATE TABLE IF NOT EXISTS hosts (
  host_id             TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  os                  TEXT NOT NULL,
  arch                TEXT NOT NULL,
  host_state          TEXT NOT NULL CHECK (host_state IN
                        ('NORMAL','WARNING','THROTTLED','PROTECTING','RECOVERING')),
  cpu_total           INTEGER NOT NULL DEFAULT 4,
  mem_total_bytes     BIGINT NOT NULL,
  mem_available_bytes BIGINT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

CREATE TABLE IF NOT EXISTS role_instances (
  instance_id        TEXT PRIMARY KEY,
  role_id            TEXT NOT NULL,
  host_id            TEXT NOT NULL REFERENCES hosts(host_id),
  state              TEXT NOT NULL CHECK (state IN
                       ('PROVISIONING','STARTING','ONLINE','SUSPECT','DRAINING','OFFLINE','FAILED')),
  agent_profile_id   TEXT,
  allowed_task_types TEXT[] NOT NULL DEFAULT '{}',
  capabilities       JSONB NOT NULL DEFAULT '{"healthy":[]}',
  config_version     BIGINT NOT NULL DEFAULT 1,
  protocol_version   TEXT NOT NULL DEFAULT '1.0',
  payload_schemas    TEXT[] NOT NULL DEFAULT ARRAY['1.0'],
  last_heartbeat_at  TIMESTAMPTZ,
  load               JSONB NOT NULL DEFAULT '{}',
  -- [增补] drain 截止时间：超时未完成 → OFFLINE（§7.10）
  drain_deadline_at  TIMESTAMPTZ,
  -- [增补] PCS 配置的能力上限：capabilities 接口只能收窄，不能扩大（§7.3）
  capability_ceiling TEXT[],
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

CREATE TABLE IF NOT EXISTS scheduler_config (
  id                  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  global_limit        INTEGER NOT NULL DEFAULT 100,
  role_pool_limit     INTEGER NOT NULL DEFAULT 20,
  instance_limit      INTEGER NOT NULL DEFAULT 1,
  task_type_limit     INTEGER NOT NULL DEFAULT 10,
  aging_after_seconds INTEGER NOT NULL DEFAULT 600,
  lease_seconds       INTEGER NOT NULL DEFAULT 300,
  start_window_seconds INTEGER NOT NULL DEFAULT 30,
  suspect_after_seconds INTEGER NOT NULL DEFAULT 45,
  offline_after_seconds INTEGER NOT NULL DEFAULT 90,
  retry_backoff_seconds INTEGER[] NOT NULL DEFAULT ARRAY[300, 900, 2700],  -- 5m → 15m → 45m
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO scheduler_config (id) VALUES (TRUE) ON CONFLICT DO NOTHING;

-- 幂等补列：这个骨架不用迁移工具，重跑 001 就能把老库补齐
ALTER TABLE scheduler_config
  ADD COLUMN IF NOT EXISTS retry_backoff_seconds INTEGER[] NOT NULL DEFAULT ARRAY[300, 900, 2700];
ALTER TABLE role_instances
  ADD COLUMN IF NOT EXISTS drain_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capability_ceiling TEXT[];

-- ---------------------------------------------------------------- 工作流
-- 模板由 PCS 维护，调度机只读（§7.1）
CREATE TABLE IF NOT EXISTS workflow_templates (
  workflow_template_id TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  version              TEXT NOT NULL,
  phases               JSONB NOT NULL,
  approval_policy_ref  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  workflow_run_id      TEXT PRIMARY KEY,
  workflow_template_id TEXT NOT NULL,
  template_version     TEXT NOT NULL,
  status               TEXT NOT NULL,
  current_phase        TEXT,
  root_task_id         TEXT,
  -- [增补] 当前阶段任务；APPROVE 阶段没有任务，保持上一阶段任务用于绑定审批对象
  current_task_id      TEXT,
  -- [增补] 跨阶段上下文（优先级、资源画像等），推进时复制给下一阶段任务
  context              JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS current_task_id TEXT,
  ADD COLUMN IF NOT EXISTS context JSONB NOT NULL DEFAULT '{}';

-- 待决审批（§7.3）：approvals 只在决定后写入，这里记录“等谁批、批什么”。
-- 建在 tasks 之后，因为 task_id 有外键。

-- ---------------------------------------------------------------- 任务
CREATE TABLE IF NOT EXISTS tasks (
  task_id               TEXT PRIMARY KEY,
  task_type             TEXT NOT NULL,
  task_version          TEXT NOT NULL,
  workflow_run_id       TEXT REFERENCES workflow_runs(workflow_run_id),
  parent_task_id        TEXT REFERENCES tasks(task_id),
  priority_class        SMALLINT NOT NULL CHECK (priority_class BETWEEN 0 AND 3),
  status                TEXT NOT NULL CHECK (status IN
                          ('QUEUED','ASSIGNED','RUNNING','SUCCEEDED','FAILED','BLOCKED','CANCELLED')),
  payload_ref           TEXT,
  payload_sha256        TEXT,
  payload_schema        TEXT NOT NULL,
  requirements          JSONB NOT NULL DEFAULT '{}',
  resource_profile_id   TEXT NOT NULL REFERENCES resource_profiles(profile_id),
  resource_block_reason TEXT,
  resource_evaluated_at TIMESTAMPTZ,
  attempt_count         SMALLINT NOT NULL DEFAULT 0,
  max_attempts          SMALLINT NOT NULL DEFAULT 3,
  current_attempt_id    TEXT,
  enqueued_at           TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  deadline_at           TIMESTAMPTZ,
  cancel_requested_at   TIMESTAMPTZ,
  -- [增补] 退避窗口：非空且未到点则不可领取
  next_attempt_at       TIMESTAMPTZ,
  -- [增补] 死信标记
  dead_letter           BOOLEAN NOT NULL DEFAULT FALSE,
  version               BIGINT NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

CREATE TABLE IF NOT EXISTS approval_requests (
  approval_request_id TEXT PRIMARY KEY,
  workflow_run_id     TEXT NOT NULL REFERENCES workflow_runs(workflow_run_id),
  task_id             TEXT NOT NULL REFERENCES tasks(task_id),
  status              TEXT NOT NULL CHECK (status IN
                         ('PENDING','APPROVED','REJECTED','INVALIDATED','EXPIRED')),
  subject_digest      TEXT,
  action_scope        TEXT[] NOT NULL DEFAULT '{}',
  policy_version      TEXT,
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  decided_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_one_pending
  ON approval_requests (task_id) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS task_attempts (
  attempt_id        TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_number    SMALLINT NOT NULL,
  instance_id       TEXT NOT NULL,
  host_id           TEXT NOT NULL,
  agent_profile_id  TEXT,
  status            TEXT NOT NULL CHECK (status IN
                      ('CREATED','STARTED','SUCCEEDED','FAILED','CANCELLED','TIMEOUT')),
  result_summary    TEXT,
  outputs           JSONB,
  error             JSONB,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  UNIQUE (task_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS leases (
  lease_token       TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id        TEXT NOT NULL REFERENCES task_attempts(attempt_id),
  instance_id       TEXT NOT NULL,
  fencing_token     BIGINT NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  released_at       TIMESTAMPTZ,
  release_reason    TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  event_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id           TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  from_status       TEXT,
  to_status         TEXT,
  actor             TEXT,
  payload           JSONB,
  trace_id          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

-- 可靠事件源（protocol §8.1）：与状态迁移同事务写入，只追加。
-- SSE / 轮询通知都从这里读；通知允许丢，事实只认这张表。
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type        TEXT NOT NULL,
  schema_version    TEXT NOT NULL DEFAULT '1.0',
  aggregate_type    TEXT NOT NULL,
  aggregate_id      TEXT NOT NULL,
  aggregate_version BIGINT,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  trace_id          TEXT,
  actor_id          TEXT,
  idempotency_key   TEXT,
  payload           JSONB
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id       TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  workflow_run_id   TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  operator_id       TEXT NOT NULL,
  comment           TEXT,
  approval_token    TEXT NOT NULL UNIQUE,
  subject_digest    TEXT NOT NULL,
  action_scope      TEXT[] NOT NULL,
  policy_version    TEXT NOT NULL,
  invalidated_at    TIMESTAMPTZ,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

-- 审批令牌的 jti：一个令牌只能落一次库
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS token_jti TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS approvals_token_jti
  ON approvals (token_jti) WHERE token_jti IS NOT NULL;
-- 没有绑定摘要的审批（例如没有制品的流程）允许为空
ALTER TABLE approvals ALTER COLUMN subject_digest DROP NOT NULL;

-- 制品（§7.8）：调度机只记录元数据与落盘引用，不解析内容。
-- declared_sha256 由上传方声明，complete 时服务端重算 actual_sha256 并比对。
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id     TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id      TEXT REFERENCES task_attempts(attempt_id),
  instance_id     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETE','FAILED')),
  declared_sha256 TEXT NOT NULL,
  actual_sha256   TEXT,
  size_bytes      BIGINT,
  media_type      TEXT,
  storage_ref     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts (task_id, status);

CREATE TABLE IF NOT EXISTS resource_reservations (
  grant_id        TEXT PRIMARY KEY,
  host_id         TEXT NOT NULL,
  instance_id     TEXT NOT NULL,
  task_id         TEXT,
  attempt_id      TEXT,
  profile_id      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('DEPLOYMENT','TASK')),
  state           TEXT NOT NULL CHECK (state IN ('HELD','ACTIVE','RELEASED','RECLAIMED')),
  cpu_millicores  INTEGER,
  memory_bytes    BIGINT,
  disk_bytes      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  activated_at    TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  close_reason    TEXT,
  CHECK (kind <> 'TASK' OR (task_id IS NOT NULL AND attempt_id IS NOT NULL))
);

-- ---------------------------------------------------------------- 不变量
-- 事件只追加：任何 UPDATE/DELETE 直接抛错（§4.4）
CREATE OR REPLACE FUNCTION append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task_events is append-only (attempted %)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS task_events_append_only ON task_events;
CREATE TRIGGER task_events_append_only
  BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW EXECUTE FUNCTION append_only();

DROP TRIGGER IF EXISTS outbox_events_append_only ON outbox_events;
CREATE TRIGGER outbox_events_append_only
  BEFORE UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- 同一任务同一时刻最多一条未释放租约（多实例重复领取的最后一道闸）
CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_per_task
  ON leases (task_id) WHERE released_at IS NULL;

-- ---------------------------------------------------------------- 索引
CREATE INDEX IF NOT EXISTS tasks_claim_idx
  ON tasks (status, priority_class, enqueued_at, task_id);
CREATE INDEX IF NOT EXISTS tasks_workflow_idx ON tasks (workflow_run_id);
CREATE INDEX IF NOT EXISTS tasks_block_reason_idx
  ON tasks (resource_block_reason) WHERE resource_block_reason IS NOT NULL;
CREATE INDEX IF NOT EXISTS leases_expiry_idx
  ON leases (expires_at) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id, created_at);
CREATE INDEX IF NOT EXISTS outbox_events_aggregate_idx
  ON outbox_events (aggregate_type, aggregate_id, event_id);
CREATE INDEX IF NOT EXISTS reservations_host_idx ON resource_reservations (host_id, state);
CREATE INDEX IF NOT EXISTS instances_heartbeat_idx ON role_instances (last_heartbeat_at);

COMMIT;
