-- v4.1: SSH hosts support password login.
--
-- Not every new machine already has a public key installed, so onboarding allows logging in directly with a username and password;
-- passwords and private keys share the same AES-256-GCM ciphertext columns (key_ciphertext / key_iv / key_tag),
-- and auth_type records which one is in use. The API only echoes auth_type; neither the password nor the private key is echoed.

ALTER TABLE pcs_host_credentials
  ADD COLUMN IF NOT EXISTS auth_type TEXT NOT NULL DEFAULT 'key'
  CHECK (auth_type IN ('key', 'password'));
