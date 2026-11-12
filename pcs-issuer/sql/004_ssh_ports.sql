-- v4: builder SSH port mapping.
--
-- sshd inside the container listens on a fixed port (2222 for builders), and the host port is mapped into it at deployment time.
-- Ports are part of the deployment intent: they go into the signed command, the deployment record, and the deployment plan digest.

ALTER TABLE pcs_deployments
  ADD COLUMN IF NOT EXISTS ports JSONB NOT NULL DEFAULT '[]';
