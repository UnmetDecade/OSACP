#!/usr/bin/env bash
# Clear the demo database and reload seed data (including resetting the clock). Local/test environments only.
set -euo pipefail
PG_CONTAINER="${PG_CONTAINER:-pg-sched}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

docker exec "$PG_CONTAINER" psql -U postgres -d scheduler -q -c "
  TRUNCATE outbox_events, artifacts, approval_requests, approvals, task_events, leases,
           resource_reservations, task_attempts, tasks,
           workflow_runs, workflow_templates,
           role_instances, hosts, task_definitions, resource_profiles
  RESTART IDENTITY CASCADE;
  UPDATE _clock SET offset_ms = 0;
  UPDATE scheduler_config SET global_limit = 100, role_pool_limit = 20, instance_limit = 1,
         task_type_limit = 10, aging_after_seconds = 600, lease_seconds = 300,
         start_window_seconds = 30, suspect_after_seconds = 45, offline_after_seconds = 90,
         retry_backoff_seconds = ARRAY[300, 900, 2700];
"

docker exec -i "$PG_CONTAINER" psql -U postgres -d scheduler -q < "$DIR/sql/002_seed.sql"
echo "demo database reset"
