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
  fail "任务 $1 在 $3s 内没有变成 $2（当前 $(sql "SELECT status FROM tasks WHERE task_id = '$1'")）"
}

wait_attempt_count() { # task_id n timeout_s
  local i
  for i in $(seq 1 $(( $3 * 5 ))); do
    [[ "$(sql "SELECT count(*) FROM task_attempts WHERE task_id = '$1'")" == "$2" ]] && return 0
    sleep 0.2
  done
  fail "任务 $1 在 $3s 内没有第 $2 个 attempt"
}

workers_stop() { (cd "$RUNTIME_DIR" && ./scripts/stop.sh "${WORKERS[@]}" >/dev/null 2>&1 || true); sleep 1; }
workers_start() { (cd "$RUNTIME_DIR" && ./scripts/start.sh "${WORKERS[@]}" | sed 's/^/  /'); }

# ---- Preflight checks -----------------------------------------------------
say "前置检查"
curl -sf "$SCHEDULER_URL/healthz" >/dev/null || fail "调度机不可用：$SCHEDULER_URL"
[[ -S "$HOST_ADMISSION_SOCKET" ]] || fail "Host Runtime 准入 socket 不存在：$HOST_ADMISSION_SOCKET"
for w in "${WORKERS[@]}"; do
  [[ -f "$INSTANCE_TOKEN_DIR/$w.jwt" ]] || fail "缺少实例令牌：$INSTANCE_TOKEN_DIR/$w.jwt"
done
ok "调度机、准入 socket、实例令牌齐备"

# ---- A. Concurrent claim by multiple instances -----------------------------
say "A. 两个实例并发领取 6 个任务"
workers_stop
workers_start
# A crashed instance should release the leftover task grant from last time on startup; otherwise available capacity is falsely occupied
for i in $(seq 1 20); do
  g=$(task_grants)
  [[ "$g" == "0" ]] && break
  sleep 0.5
done
[[ "$g" == "0" ]] || fail "启动对账后仍有 $g 个 task grant 未释放"
ok "启动对账释放了残留 task grant"

for i in 1 2 3 4 5 6; do create_task "burst-$i" >/dev/null; done
for i in $(seq 1 150); do
  left=$(sql "SELECT count(*) FROM tasks WHERE payload_ref LIKE '$E2E_REF/burst-%' AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED')")
  [[ "$left" == "0" ]] && break
  sleep 1
done
[[ "$left" == "0" ]] || fail "6 个任务在 150s 内没有全部终结"
ok_n=$(sql "SELECT count(*) FROM tasks WHERE payload_ref LIKE '$E2E_REF/burst-%' AND status = 'SUCCEEDED'")
[[ "$ok_n" == "6" ]] || fail "应全部成功，实际成功 $ok_n/6"
# Admission rejection is not duplicate execution; the criterion is exactly one genuinely successful execution per task
bad=$(sql "SELECT count(*) FROM (SELECT t.task_id FROM tasks t JOIN task_attempts a USING (task_id)
            WHERE t.payload_ref LIKE '$E2E_REF/burst-%' GROUP BY t.task_id
           HAVING count(*) FILTER (WHERE a.status = 'SUCCEEDED') <> 1) x")
[[ "$bad" == "0" ]] || fail "有 $bad 个任务出现了重复执行"
ok "6 个任务全部成功，每个恰好一次执行"
denied=$(sql "SELECT count(*) FROM task_attempts a JOIN tasks t USING (task_id)
               WHERE t.payload_ref LIKE '$E2E_REF/burst-%' AND a.status = 'FAILED'")
echo "  准入拒绝产生的 attempt：$denied（允许，不计重复执行）"
used=$(sql "SELECT count(DISTINCT a.instance_id) FROM task_attempts a JOIN tasks t USING (task_id)
             WHERE t.payload_ref LIKE '$E2E_REF/burst-%'")
echo "  参与执行的实例数：$used（调度可能集中在一个实例，不强制均分）"

# ---- B. Host Runtime admission rejection -----------------------------------
say "B. 准入拒绝：不消耗重试、不原地刷 attempt"
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
[[ "$st" == "QUEUED|0" ]] || fail "准入拒绝后任务应保持 QUEUED 且 attempt_count=0，实际 $st"
n=$(sql "SELECT count(*) FROM task_attempts WHERE task_id = '$DENY_TASK'")
[[ "$n" -ge 1 && "$n" -le 6 ]] || fail "8s 内 attempt 数应在 1..6（claim 间隔退避），实际 $n"
rej=$(sql "SELECT count(*) FROM task_events WHERE task_id = '$DENY_TASK' AND event_type = 'ADMISSION_REJECTED'")
[[ "$rej" -ge 1 ]] || fail "缺少 ADMISSION_REJECTED 事件"
ok "任务回队、attempt_count=0、8s 内只产生 $n 个 attempt"
workers_stop
restore_config

say "B2. 恢复配置后任务正常完成"
workers_start
wait_task_status "$DENY_TASK" SUCCEEDED 60
ok "准入拒绝过的任务最终成功"

# ---- C. kill -9 + lease reclaim + fencing ----------------------------------
say "C. kill -9 角色实例，租约回收后由另一实例重领"
workers_stop
(cd "$RUNTIME_DIR" && ./scripts/start.sh builder-ubuntu22-a | sed 's/^/  /')
CRASH_TASK=$(create_task crash)
wait_task_status "$CRASH_TASK" RUNNING 20
IFS='|' read -r OLD_ATT OLD_LEASE OLD_FENCE <<<"$(
  sql "SELECT a.attempt_id || '|' || l.lease_token || '|' || l.fencing_token
         FROM task_attempts a JOIN leases l USING (attempt_id)
        WHERE a.task_id = '$CRASH_TASK' AND l.released_at IS NULL"
)" || true
[[ -n "${OLD_ATT:-}" ]] || fail "找不到在途 attempt"
(cd "$RUNTIME_DIR" && ./scripts/stop.sh --force builder-ubuntu22-a | sed 's/^/  /')
advance 301000 # Expire the lease (lease_seconds=300)
wait_task_status "$CRASH_TASK" QUEUED 15
[[ "$(sql "SELECT status FROM task_attempts WHERE attempt_id = '$OLD_ATT'")" == "TIMEOUT" ]] ||
  fail "旧 attempt 应被标记 TIMEOUT"
[[ "$(sql "SELECT state || '|' || close_reason FROM resource_reservations WHERE attempt_id = '$OLD_ATT'")" == "RECLAIMED|LEASE_EXPIRED" ]] ||
  fail "旧预留应按 LEASE_EXPIRED 回收"
ok "旧 attempt TIMEOUT、预留 RECLAIMED"

advance 301000 # Skip the retry backoff
(cd "$RUNTIME_DIR" && ./scripts/start.sh builder-ubuntu24-a | sed 's/^/  /')
wait_attempt_count "$CRASH_TASK" 2 20
NEW_FENCE=$(sql "SELECT fencing_token FROM leases WHERE task_id = '$CRASH_TASK' AND released_at IS NULL")
[[ "$NEW_FENCE" == "$((OLD_FENCE + 1))" ]] || fail "新租约 fencing 应为 $((OLD_FENCE + 1))，实际 $NEW_FENCE"

code=$(curl -s -o /tmp/e2e-stale.json -w '%{http_code}' -X POST \
  "$SCHEDULER_URL/v1/attempts/$OLD_ATT/result" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $(cat "$INSTANCE_TOKEN_DIR/builder-ubuntu22-a.jwt")" \
  -d "{\"status\":\"SUCCEEDED\",\"instance_id\":\"builder-ubuntu22-a\",
       \"lease_token\":\"$OLD_LEASE\",\"fencing_token\":$OLD_FENCE,\"summary\":\"zombie\"}")
[[ "$code" == "409" ]] || fail "旧 attempt 的迟到结果应返回 409，实际 $code"
grep -q FENCING_STALE /tmp/e2e-stale.json || fail "旧 attempt 的结果没有被 FENCING_STALE 挡住"
ok "新租约 fencing=$NEW_FENCE，旧结果 409 FENCING_STALE"
wait_task_status "$CRASH_TASK" SUCCEEDED 60
ok "崩溃任务由另一实例完成"

# ---- D. Scheduler restart --------------------------------------------------
say "D. 调度机在任务执行中重启"
RESTART_TASK=$(create_task restart)
wait_task_status "$RESTART_TASK" RUNNING 20
SPID=$(ss -ltnp 2>/dev/null | grep ':7801' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[[ -n "$SPID" ]] || fail "找不到调度机进程"
kill "$SPID"
sleep 1
# setsid: new session + detach from this script; otherwise non-interactive bash waits for this background child process on exit
(cd "$SCHEDULER_DIR" && PCS_PUBLIC_KEY_FILE="$PCS_PUBLIC_KEY_FILE" \
  setsid npm start >> server.log 2>&1 < /dev/null &)
for i in $(seq 1 40); do curl -sf "$SCHEDULER_URL/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "$SCHEDULER_URL/healthz" >/dev/null || fail "调度机没有重新起来"
wait_task_status "$RESTART_TASK" SUCCEEDED 60
[[ "$(sql "SELECT count(*) FROM task_attempts WHERE task_id = '$RESTART_TASK'")" == "1" ]] ||
  fail "调度机重启后不得产生第二个 attempt"
[[ "$(sql "SELECT count(*) FROM task_events WHERE task_id = '$RESTART_TASK' AND event_type = 'TASK_ASSIGNED'")" == "1" ]] ||
  fail "调度机重启后不得重复派发"
ok "重启后任务照常完成，只有一个 attempt、一次派发"

# ---- E. Orphaned reservations ----------------------------------------------
live=$(sql "SELECT count(*) FROM resource_reservations WHERE state IN ('HELD','ACTIVE')")
[[ "$live" == "0" ]] || fail "仍有 $live 条 HELD/ACTIVE 预留"
ok "没有孤儿预留"

say "恢复：启动两个 worker"
workers_start

say "P2 验收全部通过"
