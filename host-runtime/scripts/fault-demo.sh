#!/usr/bin/env bash
# Fault drill: two real instances run tasks → force-kill one → lease expires and is reclaimed → the other instance takes over → the killed instance restarts and rejoins
#
# Real time throughout, no clock skipping: leases are compressed to 6s and backoff to 5s, so the full takeover is visible within a dozen or so seconds.
# Production values come from scheduler_config (defaults 300s / 5m→15m→45m); here we just turn the parameters down.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${BASE:-http://127.0.0.1:7801}"
PG="${PG_CONTAINER:-pg-sched}"
SCHEDULER_DIR="${SCHEDULER_DIR:-$HOME/scheduler}"

hr() { printf '\n\033[1m%s\033[0m\n' "$1"; }
tasks_json() {
  curl -s "$BASE/v1/tasks" | python3 -c '
import sys, json
for t in json.load(sys.stdin)["items"]:
    tid = t["task_id"]
    st = t["status"]
    who = t.get("current_instance_id") or "-"
    n = t.get("current_attempt_number")
    if n:
        who = f"{who}(#{n})"
    print(f"{tid:<22} {st:<10} {who}")'
}

hr "0. 清库、调整演示用参数、起两个实例"
"$DIR/scripts/stop.sh" builder-ubuntu22-a builder-ubuntu24-a >/dev/null 2>&1 || true
"$SCHEDULER_DIR/scripts/reset.sh" >/dev/null
docker exec "$PG" psql -U postgres -d scheduler -q -c "
  UPDATE scheduler_config SET lease_seconds = 6, start_window_seconds = 3,
         retry_backoff_seconds = ARRAY[5, 15, 45];" >/dev/null

mkdir -p "$DIR/run"
python3 - "$DIR" <<'PY'
import json, sys
d = sys.argv[1]
cfg = json.load(open(f"{d}/runtime.config.json"))
cfg.update(lease_renew_seconds=2, progress_seconds=1, claim_interval_seconds=1)
json.dump(cfg, open(f"{d}/run/runtime.demo.json", "w"), ensure_ascii=False, indent=2)
PY
export RUNTIME_CONFIG=run/runtime.demo.json
"$DIR/scripts/start.sh" builder-ubuntu22-a builder-ubuntu24-a
sleep 3

hr "1. 提交 2 个任务，两个实例各跑一个"
for i in 1 2; do
  curl -s -X POST "$BASE/v1/tasks" -H 'content-type: application/json' \
    -d "{\"task_type\":\"task.build\",\"priority_class\":1,\"payload_ref\":\"svn://fault/r$i\"}" >/dev/null
done
sleep 3
tasks_json

hr "2. 强杀 builder-ubuntu22-a（任务还在跑，租约未释放）"
"$DIR/scripts/stop.sh" --force builder-ubuntu22-a
sleep 1
tasks_json

hr "3. 等 7s：租约过期，调度机回收、回队"
sleep 7
tasks_json

hr "4. 等 8s：退避结束，builder-ubuntu24-a 接手同一个任务（attempt #2）"
sleep 8
tasks_json

hr "5. 等 10s：任务完成"
sleep 10
tasks_json
echo "--- builder-ubuntu24-a 日志："
grep -E "开始|完成|续租" "$DIR/run/builder-ubuntu24-a.log" | tail -6

hr "6. builder-ubuntu22-a 重启归队"
"$DIR/scripts/start.sh" builder-ubuntu22-a
sleep 4
curl -s "$BASE/v1/instances" | python3 -c '
import sys, json
for i in json.load(sys.stdin)["items"]:
    if i["instance_id"].startswith("builder"):
        iid = i["instance_id"]; st = i["state"]; age = i["heartbeat_age_s"]
        print(f"{iid:<10} {st:<8} 心跳 {age}s 前")'

hr "7. 最终状态"
tasks_json
echo "--- 队列统计："
curl -s "$BASE/v1/queue/stats"; echo
