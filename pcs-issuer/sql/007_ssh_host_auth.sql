-- v4.1：SSH 主机支持密码登录。
--
-- 不是每台新机器都已经装好公钥，接入时允许直接用账号密码登录；
-- 密码与私钥走同一套 AES-256-GCM 密文列（key_ciphertext / key_iv / key_tag），
-- auth_type 记录当前用哪一种。接口只回显 auth_type，密码与私钥都不回显。

ALTER TABLE pcs_host_credentials
  ADD COLUMN IF NOT EXISTS auth_type TEXT NOT NULL DEFAULT 'key'
  CHECK (auth_type IN ('key', 'password'));
