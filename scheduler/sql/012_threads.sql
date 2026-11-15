-- 012: Sources, threads and subscriptions
--
-- A thread groups the tasks and messages that belong to one conversation or work stream.
-- A task still stands on its own (queue, lease, attempts); the thread is an index over tasks,
-- not an execution unit, so losing a thread row never blocks a running task.
--
-- Subscriptions let a reader follow a thread without polling every task: a subscription stores
-- a cursor into the outbox (event_id), and each poll returns the thread's events after it.

CREATE TABLE IF NOT EXISTS threads (
  thread_id  TEXT PRIMARY KEY,
  title      TEXT,
  -- Which intake created the thread: admin | sideload | api | relay.
  source     TEXT NOT NULL DEFAULT 'api',
  created_by TEXT,
  status     TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ARCHIVED')),
  metadata   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS threads_updated_idx ON threads (updated_at DESC);
CREATE INDEX IF NOT EXISTS threads_status_idx ON threads (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS thread_tasks (
  thread_id TEXT NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  task_id   TEXT NOT NULL,
  -- owner: the task the thread was created for; followup: created by a thread message;
  -- context: attached for reference only.
  relation  TEXT NOT NULL DEFAULT 'owner' CHECK (relation IN ('owner', 'followup', 'context')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, task_id)
);

CREATE INDEX IF NOT EXISTS thread_tasks_task_idx ON thread_tasks (task_id);

CREATE TABLE IF NOT EXISTS thread_messages (
  message_id TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  -- user: a person's message; agent: text produced by a task; system: scheduler notice.
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'agent', 'system')),
  actor      TEXT,
  body       TEXT NOT NULL,
  -- The task created from this message, if any.
  task_id    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS thread_messages_thread_idx ON thread_messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS thread_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  -- Free-form reader identity: an account name, a sideload id or an agent instance id.
  subscriber      TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'poll' CHECK (kind IN ('poll', 'outbox')),
  -- Last outbox event_id handed to this subscriber; the next poll starts after it.
  cursor          BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ,
  UNIQUE (thread_id, subscriber)
);
