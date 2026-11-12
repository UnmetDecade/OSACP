-- When the image is not on the target host, the control plane ships it over first, then dispatches the deployment command.
-- During sync the deployment status is SYNCING, and the UI shows "syncing image".
ALTER TABLE pcs_deployments DROP CONSTRAINT IF EXISTS pcs_deployments_status_check;
ALTER TABLE pcs_deployments ADD CONSTRAINT pcs_deployments_status_check CHECK (status IN
  ('PENDING','PLANNED','SYNCING','PULLING','STARTING','HEALTHY','FAILED','STOPPED','ROLLED_BACK','REMOVED'));
