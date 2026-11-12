-- 实例名只在主机内唯一（两台主机都可以有 builder-a），Agent / API 绑定也必须按主机作用域。
--
-- 旧行没有 host_id：按「离绑定时间最近的那次部署」回填主机。找不到任何部署的绑定
-- 无法确定归属，直接删除（这种绑定本来也没有实例会读取）。
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

-- 主键从 instance_id 换成 (host_id, instance_id)；重复执行时跳过。
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
