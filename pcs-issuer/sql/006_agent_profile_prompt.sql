-- Agent "persona" and responsibility description.
-- These fields enter the runtime view via PCS resolve, and the agent adapter weaves them into the prompt;
-- description is for panel identification only and does not affect execution.

ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS description   TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS system_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS persona       TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS tone          TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS goals         TEXT NOT NULL DEFAULT '';
