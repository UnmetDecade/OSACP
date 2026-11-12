-- Instance names are unique only within a host (two hosts can both have builder-a), so Agent / API bindings must also be host-scoped.
--
-- Legacy rows have no host_id: backfill the host from "the deployment closest to the binding time". For bindings with no matching deployment
-- ownership cannot be determined, so they are deleted outright (no instance would read such bindings anyway).
ALTER TABLE role_agent_bindings ADD COLUMN IF NOT EXISTS host_id TEXT;
ALTER TABLE role_api_bindings ADD COLUMN IF NOT EXISTS host_id TEXT;

UPDATE role_agent_bindings b
   SET host_id = (
     SELECT d.host_id
       FROM pcs_deployments d
      WHERE d.instance_id = b.instance_id
      ORDER BY abs(extract(epoch FROM (d.created_at - b.bound_at)))
      LIMIT 1
   )
 WHERE b.host_id IS NULL;

UPDATE role_api_bindings b
   SET host_id = (
     SELECT d.host_id
       FROM pcs_deployments d
      WHERE d.instance_id = b.instance_id
      ORDER BY abs(extract(epoch FROM (d.created_at - b.bound_at)))
      LIMIT 1
   )
 WHERE b.host_id IS NULL;

DELETE FROM role_agent_bindings WHERE host_id IS NULL;
DELETE FROM role_api_bindings WHERE host_id IS NULL;

-- Change the primary key from instance_id to (host_id, instance_id); skip if already applied.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'host_id'
     WHERE t.relname = 'role_agent_bindings'
       AND i.indisprimary
       AND a.attnum = ANY (i.indkey)
  ) THEN
    ALTER TABLE role_agent_bindings DROP CONSTRAINT IF EXISTS role_agent_bindings_pkey;
    ALTER TABLE role_agent_bindings ALTER COLUMN host_id SET NOT NULL;
    ALTER TABLE role_agent_bindings ADD PRIMARY KEY (host_id, instance_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'host_id'
     WHERE t.relname = 'role_api_bindings'
       AND i.indisprimary
       AND a.attnum = ANY (i.indkey)
  ) THEN
    ALTER TABLE role_api_bindings DROP CONSTRAINT IF EXISTS role_api_bindings_pkey;
    ALTER TABLE role_api_bindings ALTER COLUMN host_id SET NOT NULL;
    ALTER TABLE role_api_bindings ADD PRIMARY KEY (host_id, instance_id, api_profile_id);
  END IF;
END $$;
