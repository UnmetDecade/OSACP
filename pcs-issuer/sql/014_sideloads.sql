-- Side-load access (侧载).
--
-- A device on the same LAN holds a bearer token and calls /api/v1/sideload/* to create and watch tasks on
-- one host, without an admin JWT. The token is stored hashed; the plaintext is returned once at creation.
-- A sideload belongs to exactly one host and can never see another host's sideloads.
CREATE TABLE IF NOT EXISTS pcs_sideloads (
  sideload_id   TEXT PRIMARY KEY,
  host_id       TEXT NOT NULL REFERENCES pcs_hosts(host_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  token_hint    TEXT NOT NULL,
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ,
  last_ip       TEXT,
  revoked_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS pcs_sideloads_token_hash_idx ON pcs_sideloads (token_hash);
CREATE INDEX IF NOT EXISTS pcs_sideloads_host_idx ON pcs_sideloads (host_id, created_at DESC);
