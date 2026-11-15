-- Demo storyline: the studio should show the development workstreams, not the
-- placeholder builders from the scheduler's own seed. Runs once per `up`, after
-- migrations and the seed have applied.
--
-- The real instances (dev-ui / dev-middle / dev-driver / kernel-dev /
-- scheduler-kernel) register over the normal heartbeat path; nothing is faked here.
BEGIN;

DELETE FROM role_instances
 WHERE instance_id IN ('builder-ubuntu20-a', 'builder-ubuntu22-a', 'builder-ubuntu24-a');

COMMIT;
