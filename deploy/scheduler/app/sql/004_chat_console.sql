-- 004: 对话与构建机终端
--
-- 对话和终端都不是“旁路”：它们和构建一样，是调度机上的普通任务，
-- 受 allowed_task_types、资源画像、租约、fencing、超时和审计约束。
--
-- v4 约束：
--   * task.chat.builder / task.chat.scheduler 可以路由到 Agent
--     （Claude Code / Codex 等），Agent 只能看到本条消息与显式 history。
--   * task.console.builder 在构建机容器内执行完整 shell，与 SSH 等价；
--     没有命令白名单。隔离靠容器边界、资源限额和网络策略。
--   * console 任务最大尝试次数固定为 1：命令结果不确定时不得盲目重试。

INSERT INTO task_definitions (task_type, task_version, target_role, capabilities, default_profile, max_attempts) VALUES
  ('task.chat.builder',      '1.0', 'builder',   ARRAY['llm','shell'], 'rp_builder_small', 1),
  ('task.chat.scheduler',    '1.0', 'scheduler', ARRAY['llm'],         'rp_control',       1),
  ('task.console.builder',   '1.0', 'builder',   ARRAY['shell'],       'rp_builder_small', 1),
  ('task.console.scheduler', '1.0', 'scheduler', ARRAY['shell'],       'rp_control',       1)
ON CONFLICT DO NOTHING;

-- 已注册实例补上对应任务类型；只追加一次，重复执行迁移是幂等的。
UPDATE role_instances
   SET allowed_task_types = allowed_task_types || ARRAY['task.chat.' || role_id]
 WHERE role_id IN ('builder', 'scheduler')
   AND NOT ('task.chat.' || role_id = ANY(allowed_task_types));

UPDATE role_instances
   SET allowed_task_types = allowed_task_types || ARRAY['task.console.' || role_id]
 WHERE role_id IN ('builder', 'scheduler')
   AND NOT ('task.console.' || role_id = ANY(allowed_task_types));
