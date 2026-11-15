-- Accounts, sessions and audit attribution.
--
-- The admin app used to authenticate with a single shared JWT injected by the
-- reverse proxy. Accounts replace that in the browser while the CLI-issued admin
-- token stays available for automation. Sessions are opaque tokens, hashed at
-- rest, bound to one account, expiring and revocable.

CREATE TABLE IF NOT EXISTS pcs_accounts (
  account_id    TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer', 'custom')),
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'DISABLED')) DEFAULT 'PENDING',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by   TEXT,
  last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pcs_accounts_status_idx ON pcs_accounts (status, created_at);

CREATE TABLE IF NOT EXISTS pcs_sessions (
  session_id   TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES pcs_accounts(account_id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_hash    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip           TEXT,
  user_agent   TEXT,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pcs_sessions_account_idx ON pcs_sessions (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pcs_sessions_expiry_idx ON pcs_sessions (expires_at);

-- Audit rows keep the account link as a plain string: deleting an account must not
-- delete its history. actor_ip is filled for authentication events.
ALTER TABLE pcs_audit_logs ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE pcs_audit_logs ADD COLUMN IF NOT EXISTS actor_ip TEXT;
CREATE INDEX IF NOT EXISTS pcs_audit_logs_account_idx ON pcs_audit_logs (account_id, created_at DESC);
