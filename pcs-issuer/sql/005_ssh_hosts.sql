-- v4.1：主机接入方式与 SSH 凭据。
--
-- 一台主机只有一种接入方式：
--   local —— PCS 所在机器（管理页面所在主机），不需要 SSH；
--   ssh   —— 远程主机，PCS 用平台保存的私钥做探测与引导。
--
-- 私钥只用 AES-256-GCM 密文落库（key_ciphertext / key_iv / key_tag），
-- 加密密钥放在 PCS_CREDENTIAL_KEY_FILE 指向的文件里，与数据库分离。
-- 接口只返回 key_fingerprint，私钥原文永不回显。

CREATE TABLE IF NOT EXISTS pcs_host_credentials (
  host_id         TEXT PRIMARY KEY REFERENCES pcs_hosts(host_id) ON DELETE CASCADE,
  transport       TEXT NOT NULL CHECK (transport IN ('local','ssh')),
  address         TEXT,
  ssh_port        INTEGER NOT NULL DEFAULT 22,
  ssh_user        TEXT,
  key_ciphertext  TEXT,
  key_iv          TEXT,
  key_tag         TEXT,
  key_fingerprint TEXT,
  last_probe      JSONB,
  last_probe_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
