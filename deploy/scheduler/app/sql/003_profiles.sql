-- P4: Agent / API Profile references in the task envelope.
-- The scheduler only stores/returns references; it does not parse Profile contents or touch secrets.

ALTER TABLE role_instances
  ADD COLUMN IF NOT EXISTS agent_profile_version TEXT,
  ADD COLUMN IF NOT EXISTS api_profile_ids TEXT[] NOT NULL DEFAULT '{}';
