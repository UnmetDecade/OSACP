-- Agent 的“人格”与职责说明。
-- 这些字段随 PCS resolve 进入运行时视图，由 Agent 适配器拼进提示词；
-- description 只用于面板识别，不参与执行。

ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS description   TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS system_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS persona       TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS tone          TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS goals         TEXT NOT NULL DEFAULT '';
