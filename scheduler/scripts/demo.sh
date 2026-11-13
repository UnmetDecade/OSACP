#!/usr/bin/env bash
# End-to-end demo: create task → claim → start → instance lost → lease reaped → poison message rejected → reclaim → success
# Usage: BASE=http://127.0.0.1:7801 ./scripts/demo.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:7801}"
PG_CONTAINER="${PG_CONTAINER:-pg-sched}"

jget() { python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("'"$1"'",""))'; }
hr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Test-only: "time travel" with a controllable clock; never done in production
travel() {
  docker exec "$PG_CONTAINER" psql -U postgres -d scheduler -q \
    -c "UPDATE _clock SET offset_ms = offset_ms + $1" >/dev/null
  sleep 1.5   # wait for the background sweep to run one round
}

hr "0. Health check"
curl -s "$BASE/healthz"; echo
curl -s "$BASE/readyz"; echo

hr "1. Instance heartbeat comes online"
curl -s -X POST "$BASE/v1/instances/heartbeat" \
  -H 'content-type: application/json' \
  -d '{"instance_id":"worker-a","state":"ONLINE","load":{"cpu":0.1}}'; echo

hr "2. Create a task (P1)"
TASK=$(curl -s -X POST "$BASE/v1/tasks" -H 'content-type: application/json' \
  -d '{"task_type":"task.build","priority_class":1,"payload_ref":"svn://demo/r1","payload_schema":"1.0"}')
TASK_ID=$(echo "$TASK" | jget task_id)
echo "task_id=$TASK_ID  status=$(echo "$TASK" | jget status)"

hr "3. worker-a claims it"
A=$(curl -s -X POST "$BASE/v1/claim" -H 'content-type: application/json' \
  -d '{"instance_id":"worker-a"}')
ATTEMPT=$(echo "$A" | jget attempt_id)
LEASE=$(echo "$A" | jget lease_token)
FENCE=$(echo "$A" | jget fencing_token)
echo "attempt=$ATTEMPT fencing=$FENCE expires=$(echo "$A" | jget lease_expires_at)"

hr "4. The same instance claims again (concurrency limit 1) → expect 204"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/claim" \
  -H 'content-type: application/json' -d '{"instance_id":"worker-a"}')
echo "HTTP $CODE"

hr "5. start-ack → RUNNING"
curl -s -X POST "$BASE/v1/attempts/$ATTEMPT/start-ack" -H 'content-type: application/json' \
  -d "{\"lease_token\":\"$LEASE\",\"fencing_token\":$FENCE,\"instance_id\":\"worker-a\"}"; echo

hr "6. Simulate a lost instance: advance time by 301s so the lease expires"
travel 301000
curl -s "$BASE/v1/tasks/$TASK_ID" | python3 -c \
  'import sys,json;d=json.load(sys.stdin);print("task status:",d["status"],"| attempt_count:",d["attempt_count"])'

hr "7. worker-b takes over after backoff (fencing should be 2)"
travel 301000
# After time advances worker-b is also marked SUSPECT/OFFLINE; send a heartbeat first to bring it back ONLINE
curl -s -X POST "$BASE/v1/instances/heartbeat" -H 'content-type: application/json' \
  -d '{"instance_id":"worker-b","state":"ONLINE"}' >/dev/null
B=$(curl -s -X POST "$BASE/v1/claim" -H 'content-type: application/json' \
  -d '{"instance_id":"worker-b"}')
ATTEMPT2=$(echo "$B" | jget attempt_id)
LEASE2=$(echo "$B" | jget lease_token)
FENCE2=$(echo "$B" | jget fencing_token)
echo "attempt=$ATTEMPT2 fencing=$FENCE2"

hr "8. The old attempt writes its result now (poison message) → expect FENCING_STALE"
curl -s -X POST "$BASE/v1/attempts/$ATTEMPT/result" -H 'content-type: application/json' \
  -d "{\"lease_token\":\"$LEASE\",\"fencing_token\":$FENCE,\"status\":\"SUCCEEDED\",\"summary\":\"late success\"}"; echo

hr "9. The new attempt completes normally"
curl -s -X POST "$BASE/v1/attempts/$ATTEMPT2/start-ack" -H 'content-type: application/json' \
  -d "{\"lease_token\":\"$LEASE2\",\"fencing_token\":$FENCE2,\"instance_id\":\"worker-b\"}" >/dev/null
curl -s -X POST "$BASE/v1/attempts/$ATTEMPT2/result" -H 'content-type: application/json' \
  -d "{\"lease_token\":\"$LEASE2\",\"fencing_token\":$FENCE2,\"status\":\"SUCCEEDED\",\"summary\":\"ok\"}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("task:",d["task"]["status"],"attempt:",d["attempt_status"])'

hr "10. Event timeline (append-only)"
curl -s "$BASE/v1/tasks/$TASK_ID/events" | python3 "$(dirname "$0")/timeline.py"

hr "11. Queue stats"
curl -s "$BASE/v1/queue/stats"; echo
