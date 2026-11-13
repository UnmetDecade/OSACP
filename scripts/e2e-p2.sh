#!/usr/bin/env bash
# P2 acceptance: three-process end-to-end with the scheduler + Host Runtime admission + two role instances.
#
# Covers:
#   A. Concurrent claim by multiple instances: each task gets exactly one attempt, no duplicates or omissions
#   B. Host Runtime admission rejection: task is requeued, does not consume retries, and does not bump the attempt count in place
#   C. kill -9 a role instance: lease reclaimed → another instance reclaims it (fencing+1) → old result FENCING_STALE
#   D. Scheduler restart: in-flight tasks complete as usual, without duplicate execution
#   E. No orphaned reservations (HELD/ACTIVE is 0)
#
# Prerequisites:
#   - Scheduler is running (PCS_PUBLIC_KEY_FILE configured), and both workers are registered
#   - Host Runtime daemon + watchdog are running, and the admission socket exists
#   - JWTs for builder-ubuntu22-a / builder-ubuntu24-a have been issued to INSTANCE_TOKEN_DIR
#   - Both workers in runtime.config.json have slot memory of 1 GiB and slots=1
#
# Note: the script uses _clock time travel (+602s) to verify lease expiry; do not treat it as a real clock afterwards.
# Re-running continues to push the offset forward, which is allowed by design; for a clean environment run scheduler/scripts/reset.sh.
#
# Usage: scripts/e2e-p2.sh
set -euo pipefail

SCHEDULER_URL=${SCHEDULER_URL:-http://127.0.0.1:7801}
RUNTIME_DIR=${RUNTIME_DIR:-$HOME/host-runtime}
SCHEDULER_DIR=${SCHEDULER_DIR:-$HOME/scheduler}
PCS_PUBLIC_KEY_FILE=${PCS_PUBLIC_KEY_FILE:-$HOME/pcs-issuer/keys/public.pem}
export HOST_ADMISSION_SOCKET=${HOST_ADMISSION_SOCKET:-$RUNTIME_DIR/run-live/runtime.sock}
export INSTANCE_TOKEN_DIR=${INSTANCE_TOKEN_DIR:-$RUNTIME_DIR/run/tokens}
PSQL_CMD=${PSQL_CMD:-"docker exec pg-sched psql -U postgres -d scheduler"}

WORKERS=(builder-ubuntu22-a builder-ubuntu24-a)
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
E2E_REF="svn://e2e/$RUN_ID"

say() { printf '\n== %s\n' "$*"; }
ok() { printf 'ok - %s\n' "$*"; }
fail() { printf 'FAIL - %s\n' "$*" >&2; exit 1; }

sql() { $PSQL_CMD -tA -c "$1"; }
advance() {
  sql "UPDATE _clock SET offset_ms = offset_ms + $1" >/dev/null
  echo "clock +$1 ms"
}

create_task() {
  curl -sf -X POST "$SCHEDULER_URL/v1/tasks" -H 'content-type: application/json' \
    -d "{\"task_type\":\"task.build\",\"payload_ref\":\"$E2E_REF/$1\"}" |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["task_id"])'
}

task_grants() {
  curl -s --unix-socket "$HOST_ADMISSION_SOCKET" http://runtime/grants |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["task_grants"])'
}

wait_task_status() { # task_id status timeout_s
  local i
  for i in $(seq 1 $(( $3 * 5 ))); do
    [[ "$(sql "SELECT status FROM tasks WHERE task_id = '$1'")" == "$2" ]] && return 0
    sleep 0.2
  done
  fail "task $1 did not reach $2 within $3s (currently $(sql "SELECT status FROM tasks WHERE task_id = '$1'"))"
}

wait_attempt_count() { # task_id n timeout_s
  local i
  for i in $(seq 1 $(( $3 * 5 ))); do
    [[ "$(sql "SELECT count(*) FROM task_attempts WHERE task_id = '$1'")" == "$2" ]] && return 0
    sleep 0.2
  done
  fail "task $1 did not reach attempt #$2 within $3s"
}

workers_stop() { (cd "$RUNTIME_DIR" && ./scripts/stop.sh "${WORKERS[@]}" >/dev/null 2>&1 || true); sleep 1; }
workers_start() { (cd "$RUNTIME_DIR" && ./scripts/start.sh "${WORKERS[@]}" | sed 's/^/  /'); }

# ---- Preflight checks -----------------------------------------------------
say "Preflight checks"
curl -sf "$SCHEDULER_URL/healthz" >/dev/null || fail "scheduler unavailable: $SCHEDULER_URL"
[[ -S "$HOST_ADMISSION_SOCKET" ]] || fail "Host Runtime admission socket not found: $HOST_ADMISSION_SOCKET"
for w in "${WORKERS[@]}"; do
  [[ -f "$INSTANCE_TOKEN_DIR/$w.jwt" ]] || fail "missing instance token: $INSTANCE_TOKEN_DIR/$w.jwt"
done
ok "scheduler, admission socket, and instance tokens are all present"

# ---- A. Concurrent claim by multiple instances -----------------------------
say "A. Two instances claim 6 tasks concurrently"
workers_stop
workers_start
# A crashed instance should release the leftover task grant from last time on startup; otherwise available capacity is falsely occupied
for i in $(seq 1 20); do
  g=$(task_grants)
  [[ "$g" == "0" ]] && break
  sleep 0.5
done
[[ "$g" == "0" ]] || fail "$g task grants are still held after startup reconcile"
ok "startup reconcile released the leftover task grants"

for i in 1 2 3 4 5 6; do create_task "burst-$i" >/dev/null; done
for i in $(seq 1 150); do
  left=$(sql "SELECT count(*) FROM tasks WHERE payload_ref LIKE '$E2E_REF/burst-%' AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED')")
  [[ "$left" == "0" ]] && break
  sleep 1
done
[[ "$left" == "0" ]] || fail "not all 6 tasks finished within 150s"
ok_n=$(sql "SELECT count(*) FROM tasks WHERE payload_ref LIKE '$E2E_REF/burst-%' AND status = 'SUCCEEDED'")
[[ "$ok_n" == "6" ]] || fail "all 6 should succeed; $ok_n/6 succeeded"
# Admission rejection is not duplicate execution; the criterion is exactly one genuinely successful execution per task
bad=$(sql "SELECT count(*) FROM (SELECT t.task_id FROM tasks t JOIN task_attempts a USING (task_id)
            WHERE t.payload_ref LIKE '$E2E_REF/burst-%' GROUP BY t.task_id
           HAVING count(*) FILTER (WHERE a.status = 'SUCCEEDED') <> 1) x")
[[ "$bad" == "0" ]] || fail "$bad tasks were executed more than once"
ok "all 6 tasks succeeded, each executed exactly once"
denied=$(sql "SELECT count(*) FROM task_attempts a JOIN tasks t USING (task_id)
               WHERE t.payload_ref LIKE '$E2E_REF/burst-%' AND a.status = 'FAILED'")
echo "  attempts caused by admission rejections: $denied (allowed, not counted as duplicate execution)"
used=$(sql "SELECT count(DISTINCT a.instance_id) FROM task_attempts a JOIN tasks t USING (task_id)
             WHERE t.payload_ref LIKE '$E2E_REF/burst-%'")
echo "  instances that executed work: $used (dispatch may concentrate on one instance; even spread is not required)"

# ---- B. Host Runtime admission rejection -----------------------------------
say "B. Admission rejection: no retry consumption, no attempt churn"
workers_stop
cp "$RUNTIME_DIR/runtime.config.json" "$RUNTIME_DIR/runtime.config.e2e-bak.json"
restore_config() {
  if [[ -f "$RUNTIME_DIR/runtime.config.e2e-bak.json" ]]; then
    mv "$RUNTIME_DIR/runtime.config.e2e-bak.json" "$RUNTIME_DIR/runtime.config.json"
  fi
}
trap restore_config EXIT
python3 - "$RUNTIME_DIR/runtime.config.json" <<'EOF'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
for i in d["instances"]:
    if i["instance_id"]=="builder-ubuntu24-a": i["slot_memory_bytes"]=5*1024**3
json.dump(d,open(p,"w"),indent=2)
EOF
(cd "$RUNTIME_DIR" && ./scripts/start.sh builder-ubuntu24-a | sed 's/^/  /')
DENY_TASK=$(create_task deny)
sleep 8
st=$(sql "SELECT status || '|' || attempt_count FROM tasks WHERE task_id = '$DENY_TASK'")
[[ "$st" == "QUEUED|0" ]] || fail "after an admission rejection the task must stay QUEUED with attempt_count=0; got $st"
n=$(sql "SELECT count(*) FROM task_attempts WHERE task_id = '$DENY_TASK'")
[[ "$n" -ge 1 && "$n" -le 6 ]] || fail "attempts within 8s must be 1..6 (claim backoff); got $n"
rej=$(sql "SELECT count(*) FROM task_events WHERE task_id = '$DENY_TASK' AND event_type = 'ADMISSION_REJECTED'")
[[ "$rej" -ge 1 ]] || fail "missing ADMISSION_REJECTED event"
ok "task requeued, attempt_count=0, only $n attempts within 8s"
workers_stop
restore_config

say "B2. The task completes normally after the config is restored"
workers_start
wait_task_status "$DENY_TASK" SUCCEEDED 60
ok "a task that was admission-rejected eventually succeeds"

# ---- C. kill -9 + lease reclaim + fencing ----------------------------------
say "C. kill -9 a role instance; after lease reclaim another instance takes over"
workers_stop
(cd "$RUNTIME_DIR" && ./scripts/start.sh builder-ubuntu22-a | sed 's/^/  /')
CRASH_TASK=$(create_task crash)
wait_task_status "$CRASH_TASK" RUNNING 20
IFS='|' read -r OLD_ATT OLD_LEASE OLD_FENCE <<<"$(
  sql "SELECT a.attempt_id || '|' || l.lease_token || '|' || l.fencing_token
         FROM task_attempts a JOIN leases l USING (attempt_id)
        WHERE a.task_id = '$CRASH_TASK' AND l.released_at IS NULL"
)" || true
[[ -n "${OLD_ATT:-}" ]] || fail "no in-flight attempt found"
(cd "$RUNTIME_DIR" && ./scripts/stop.sh --force builder-ubuntu22-a | sed 's/^/  /')
advance 301000 # Expire the lease (lease_seconds=300)
wait_task_status "$CRASH_TASK" QUEUED 15
[[ "$(sql "SELECT status FROM task_attempts WHERE attempt_id = '$OLD_ATT'")" == "TIMEOUT" ]] ||
  fail "the old attempt should be marked TIMEOUT"
[[ "$(sql "SELECT state || '|' || close_reason FROM resource_reservations WHERE attempt_id = '$OLD_ATT'")" == "RECLAIMED|LEASE_EXPIRED" ]] ||
  fail "the old reservation should be reclaimed as LEASE_EXPIRED"
ok "old attempt TIMEOUT, reservation RECLAIMED"

advance 301000 # Skip the retry backoff
(cd "$RUNTIME_DIR" && ./scripts/start.sh builder-ubuntu24-a | sed 's/^/  /')
wait_attempt_count "$CRASH_TASK" 2 20
NEW_FENCE=$(sql "SELECT fencing_token FROM leases WHERE task_id = '$CRASH_TASK' AND released_at IS NULL")
[[ "$NEW_FENCE" == "$((OLD_FENCE + 1))" ]] || fail "new lease fencing should be $((OLD_FENCE + 1)); got $NEW_FENCE"

code=$(curl -s -o /tmp/e2e-stale.json -w '%{http_code}' -X POST \
  "$SCHEDULER_URL/v1/attempts/$OLD_ATT/result" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(cat "$INSTANCE_TOKEN_DIR/builder-ubuntu22-a.jwt")" \
  -d "{\"status\":\"SUCCEEDED\",\"instance_id\":\"builder-ubuntu22-a\",
       \"lease_token\":\"$OLD_LEASE\",\"fencing_token\":$OLD_FENCE,\"summary\":\"zombie\"}")
[[ "$code" == "409" ]] || fail "a late result from the old attempt should return 409; got $code"
grep -q FENCING_STALE /tmp/e2e-stale.json || fail "the old attempt's result was not blocked by FENCING_STALE"
ok "new lease fencing=$NEW_FENCE; the old result got 409 FENCING_STALE"
wait_task_status "$CRASH_TASK" SUCCEEDED 60
ok "the crashed task was completed by another instance"

# ---- D. Scheduler restart --------------------------------------------------
say "D. The scheduler restarts while a task is running"
RESTART_TASK=$(create_task restart)
wait_task_status "$RESTART_TASK" RUNNING 20
SPID=$(ss -ltnp 2>/dev/null | grep ':7801' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[[ -n "$SPID" ]] || fail "scheduler process not found"
kill "$SPID"
sleep 1
# setsid: new session + detach from this script; otherwise non-interactive bash waits for this background child process on exit
(cd "$SCHEDULER_DIR" && PCS_PUBLIC_KEY_FILE="$PCS_PUBLIC_KEY_FILE" \
  setsid npm start >> server.log 2>&1 < /dev/null &)
for i in $(seq 1 40); do curl -sf "$SCHEDULER_URL/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "$SCHEDULER_URL/healthz" >/dev/null || fail "the scheduler did not come back up"
wait_task_status "$RESTART_TASK" SUCCEEDED 60
[[ "$(sql "SELECT count(*) FROM task_attempts WHERE task_id = '$RESTART_TASK'")" == "1" ]] ||
  fail "no second attempt may be created after the scheduler restarts"
[[ "$(sql "SELECT count(*) FROM task_events WHERE task_id = '$RESTART_TASK' AND event_type = 'TASK_ASSIGNED'")" == "1" ]] ||
  fail "no duplicate dispatch may occur after the scheduler restarts"
ok "the task still completes after the restart with one attempt and one dispatch"

# ---- E. Orphaned reservations ----------------------------------------------
live=$(sql "SELECT count(*) FROM resource_reservations WHERE state IN ('HELD','ACTIVE')")
[[ "$live" == "0" ]] || fail "$live HELD/ACTIVE reservations remain"
ok "no orphaned reservations"

say "Cleanup: start two workers"
workers_start

say "P2 acceptance passed"
