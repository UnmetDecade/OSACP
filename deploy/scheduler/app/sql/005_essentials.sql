-- 005: 运行必需的资源画像与 task.build 定义。
--
-- 002_seed.sql 里有演示主机和实例，只有 --seed 时才执行；但资源画像和
-- task.build 是平台能派发任务的硬前提（tasks.resource_profile_id 是外键，
-- task_definitions 决定 task_type 是否被认识）。每台主机的调度机各有独立库，
-- 不跑种子也应该能直接收任务，所以把这两块拆到这里，随迁移总是执行。

INSERT INTO resource_profiles (profile_id, cpu_millicores, memory_bytes, disk_bytes, timeout_seconds) VALUES
  ('rp_control',        2000, 1073741824,  5368709120, 7200),
  ('rp_builder_small',  1000, 2147483648, 17179869184, 3600),
  ('rp_builder_medium', 2000, 4294967296, 34359738368, 3600),
  ('rp_builder_large',  4000, 8589934592, 68719476736, 7200)
ON CONFLICT DO NOTHING;

INSERT INTO task_definitions (task_type, task_version, target_role, capabilities, default_profile, max_attempts) VALUES
  ('task.build', '1.0', 'builder', ARRAY['code.build','shell'], 'rp_builder_medium', 2)
ON CONFLICT DO NOTHING;
