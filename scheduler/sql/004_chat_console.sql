-- 004: Chat and builder terminal
--
-- Neither chat nor terminal is a "bypass": like builds, they are ordinary tasks on the scheduler,
-- subject to allowed_task_types, resource profiles, leases, fencing, timeouts and auditing.
--
-- v4 constraints:
--   * task.chat.builder / task.chat.scheduler can be routed to an Agent
--     (Claude Code / Codex, etc.), and the Agent sees only this message and explicit history.
--   * task.console.builder runs a full shell inside the builder container, equivalent to SSH;
--     there is no command allowlist. Isolation relies on container boundaries, resource limits and network policy.
--   * console tasks have max attempts fixed at 1: never retry blindly when the command result is uncertain.

INSERT INTO task_definitions (task_type, task_version, target_role, capabilities, default_profile, max_attempts) VALUES
  ('task.chat.builder',      '1.0', 'builder',   ARRAY['llm','shell'], 'rp_builder_small', 1),
  ('task.chat.scheduler',    '1.0', 'scheduler', ARRAY['llm'],         'rp_control',       1),
  ('task.console.builder',   '1.0', 'builder',   ARRAY['shell'],       'rp_builder_small', 1),
  ('task.console.scheduler', '1.0', 'scheduler', ARRAY['shell'],       'rp_control',       1)
ON CONFLICT DO NOTHING;

-- Add the corresponding task types to already-registered instances; appended only once, so re-running the migration is idempotent.
UPDATE role_instances
   SET allowed_task_types = allowed_task_types || ARRAY['task.chat.' || role_id]
 WHERE role_id IN ('builder', 'scheduler')
   AND NOT ('task.chat.' || role_id = ANY(allowed_task_types));

UPDATE role_instances
   SET allowed_task_types = allowed_task_types || ARRAY['task.console.' || role_id]
 WHERE role_id IN ('builder', 'scheduler')
   AND NOT ('task.console.' || role_id = ANY(allowed_task_types));
