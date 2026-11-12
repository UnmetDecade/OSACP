-- Task attachments: after an admin uploads a file, the scheduling task carries only a one-time download URL, and the builder fetches the content from the control plane.
-- This keeps large files out of the task JSON and prevents them from being retransmitted on every task-list poll.
CREATE TABLE IF NOT EXISTS pcs_task_attachments (
  attachment_id TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,
  name          TEXT NOT NULL,
  media_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    BIGINT NOT NULL,
  data          BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS pcs_task_attachments_expires_idx
  ON pcs_task_attachments (expires_at);
