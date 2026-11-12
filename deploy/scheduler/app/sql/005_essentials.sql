-- 005: Resource profiles and the task.build definition required at runtime.
--
-- 002_seed.sql contains demo hosts and instances and runs only with --seed; but resource profiles and
-- task.build are hard prerequisites for dispatching tasks (tasks.resource_profile_id is a foreign key,
-- and task_definitions decides whether a task_type is known). Each host has its own scheduler database,
-- and should accept tasks without the seed, so these two blocks live here and always run with migrations.

INSERT INTO resource_profiles (profile_id, cpu_millicores, memory_bytes, disk_bytes, timeout_seconds) VALUES
  ('rp_control',        2000, 1073741824,  5368709120, 7200),
  ('rp_builder_small',  1000, 2147483648, 17179869184, 3600),
  ('rp_builder_medium', 2000, 4294967296, 34359738368, 3600),
  ('rp_builder_large',  4000, 8589934592, 68719476736, 7200)
ON CONFLICT DO NOTHING;

INSERT INTO task_definitions (task_type, task_version, target_role, capabilities, default_profile, max_attempts) VALUES
  ('task.build', '1.0', 'builder', ARRAY['code.build','shell'], 'rp_builder_medium', 2)
ON CONFLICT DO NOTHING;
