-- v4.1: host access modes and SSH credentials.
--
-- A host has exactly one access mode:
--   local — the machine where the PCS runs (the host serving the admin UI); no SSH needed;
--   ssh   — a remote host; the PCS uses the platform-stored private key for probing and bootstrapping.
--
-- Private keys are stored only as AES-256-GCM ciphertext (key_ciphertext / key_iv / key_tag),
-- with the encryption key in the file pointed to by PCS_CREDENTIAL_KEY_FILE, separate from the database.
-- The API returns only key_fingerprint; the private key plaintext is never echoed back.

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
