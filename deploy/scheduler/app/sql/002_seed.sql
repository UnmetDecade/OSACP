-- v4 demo seed: two roles (scheduler / builder); the builder is an Ubuntu container.
-- The scheduler stores only tasks, leases and dispatch records; the builder does the execution.
BEGIN;

INSERT INTO resource_profiles (profile_id, cpu_millicores, memory_bytes, disk_bytes, timeout_seconds) VALUES
  ('rp_control',        2000, 1073741824,  5368709120, 7200),
  ('rp_builder_small',  1000, 2147483648, 17179869184, 3600),
  ('rp_builder_medium', 2000, 4294967296, 34359738368, 3600),
  ('rp_builder_large',  4000, 8589934592, 68719476736, 7200)
ON CONFLICT DO NOTHING;

INSERT INTO task_definitions (task_type, task_version, target_role, capabilities, default_profile, max_attempts) VALUES
  ('task.build', '1.0', 'builder', ARRAY['code.build','shell'], 'rp_builder_medium', 2)
ON CONFLICT DO NOTHING;

INSERT INTO hosts (host_id, name, os, arch, host_state, cpu_total, mem_total_bytes, mem_available_bytes) VALUES
  ('docker-host-01', 'docker-host', 'Linux', 'x86_64', 'NORMAL', 16, 34359738368, 25769803776),
  ('dev-box',        'dev-box',     'Linux', 'x86_64', 'NORMAL', 8,  17179869184, 12884901888)
ON CONFLICT DO NOTHING;

INSERT INTO role_instances (instance_id, role_id, host_id, state, agent_profile_id,
                            allowed_task_types, capabilities, last_heartbeat_at) VALUES
  ('scheduler', 'scheduler', 'docker-host-01', 'ONLINE', 'agp_scheduler',
   ARRAY['task.chat.scheduler','task.console.scheduler'],
   '{"healthy":["queue","lease","shell","llm"]}', app_now()),

  ('builder-ubuntu20-a', 'builder', 'dev-box', 'ONLINE', 'agp_deepseek',
   ARRAY['task.build','task.chat.builder','task.console.builder'],
   '{"healthy":["code.build","shell","llm"],"os":"ubuntu20.04"}', app_now()),

  ('builder-ubuntu22-a', 'builder', 'docker-host-01', 'ONLINE', 'agp_builder',
   ARRAY['task.build','task.chat.builder','task.console.builder'],
   '{"healthy":["code.build","shell","llm"],"os":"ubuntu22.04"}', app_now()),

  ('builder-ubuntu24-a', 'builder', 'docker-host-01', 'ONLINE', 'agp_builder',
   ARRAY['task.build','task.chat.builder','task.console.builder'],
   '{"healthy":["code.build","shell","llm"],"os":"ubuntu24.04"}', app_now())
ON CONFLICT DO NOTHING;

-- v4 has only one workflow: a single build step. No review, approval or test-machine phases.
INSERT INTO workflow_templates
  (workflow_template_id, name, version, phases, approval_policy_ref)
VALUES
  ('wft_build', 'build', '4.0',
   '[{"phase":"EXECUTE","task_type":"task.build"}]'::jsonb,
   NULL)
ON CONFLICT DO NOTHING;

COMMIT;
