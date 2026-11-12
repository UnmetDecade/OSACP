-- 任务附件：管理员上传后，调度任务只携带一次性下载地址，构建机再从控制面取内容。
-- 这样大文件不进入任务 JSON，也不会被任务列表轮询反复传输。
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
