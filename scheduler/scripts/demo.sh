#!/usr/bin/env bash
# 端到端演示：创建任务 → 领取 → 启动 → 实例失联 → 租约回收 → 毒消息被拒 → 重领 → 成功
# 用法：BASE=http://127.0.0.1:7801 ./scripts/demo.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:7801}"
PG_CONTAINER="${PG_CONTAINER:-pg-sched}"

jget() { python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("'"$1"'",""))'; }
hr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# 仅测试环境：用可控时钟做“时间旅行”，生产不会这么用
travel() {
  docker exec "$PG_CONTAINER" psql -U postgres -d scheduler -q \
    -c "UPDATE _clock SET offset_ms = offset_ms + $1" >/dev/null
  sleep 1.5   # 等后台扫描跑一轮
}

hr "0. 健康检查"
curl -s "$BASE/healthz"; echo
curl -s "$BASE/readyz"; echo

hr "1. 实例心跳上线"
curl -s -X POST "$BASE/v1/instances/heartbeat" \
  -H 'content-type: application/json' \
  -d '{"instance_id":"worker-a","state":"ONLINE","load":{"cpu":0.1}}'; echo

hr "2. 创建任务（P1）"
TASK=$(curl -s -X POST "$BASE/v1/tasks" -H 'content-type: application/json' \
  -d '{"task_type":"task.build","priority_class":1,"payload_ref":"svn://demo/r1","payload_schema":"1.0"}')
TASK_ID=$(echo "$TASK" | jget task_id)
echo "task_id=$TASK_ID  status=$(echo "$TASK" | jget status)"

hr "3. worker-a 领取"
A=$(curl -s -X POST "$BASE/v1/claim" -H 'content-type: application/json' \
  -d '{"instance_id":"worker-a"}')
ATTEMPT=$(echo "$A" | jget attempt_id)
LEASE=$(echo "$A" | jget lease_token)
FENCE=$(echo "$A" | jget fencing_token)
echo "attempt=$ATTEMPT fencing=$FENCE expires=$(echo "$A" | jget lease_expires_at)"

hr "4. 同一实例重复领取（并发上限 1）→ 期望 204"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/claim" \
  -H 'content-type: application/json' -d '{"instance_id":"worker-a"}')
echo "HTTP $CODE"

hr "5. start-ack → RUNNING"
curl -s -X POST "$BASE/v1/attempts/$ATTEMPT/start-ack" -H 'content-type: application/json' \
  -d "{\"lease_token\":\"$LEASE\",\"fencing_token\":$FENCE,\"instance_id\":\"worker-a\"}"; echo

hr "6. 模拟实例失联：时间 +301s，租约过期"
travel 301000
curl -s "$BASE/v1/tasks/$TASK_ID" | python3 -c \
  'import sys,json;d=json.load(sys.stdin);print("task status:",d["status"],"| attempt_count:",d["attempt_count"])'

hr "7. 退避结束后 worker-b 接手（fencing 应为 2）"
travel 301000
# 时间推进后 worker-b 也会被判成 SUSPECT/OFFLINE，先心跳把它拉回 ONLINE
curl -s -X POST "$BASE/v1/instances/heartbeat" -H 'content-type: application/json' \
  -d '{"instance_id":"worker-b","state":"ONLINE"}' >/dev/null
B=$(curl -s -X POST "$BASE/v1/claim" -H 'content-type: application/json' \
  -d '{"instance_id":"worker-b"}')
ATTEMPT2=$(echo "$B" | jget attempt_id)
LEASE2=$(echo "$B" | jget lease_token)
FENCE2=$(echo "$B" | jget fencing_token)
echo "attempt=$ATTEMPT2 fencing=$FENCE2"

hr "8. 旧 attempt 这时才回写结果（毒消息）→ 期望 FENCING_STALE"
curl -s -X POST "$BASE/v1/attempts/$ATTEMPT/result" -H 'content-type: application/json' \
  -d "{\"lease_token\":\"$LEASE\",\"fencing_token\":$FENCE,\"status\":\"SUCCEEDED\",\"summary\":\"迟到的成功\"}"; echo

hr "9. 新 attempt 正常完成"
curl -s -X POST "$BASE/v1/attempts/$ATTEMPT2/start-ack" -H 'content-type: application/json' \
  -d "{\"lease_token\":\"$LEASE2\",\"fencing_token\":$FENCE2,\"instance_id\":\"worker-b\"}" >/dev/null
curl -s -X POST "$BASE/v1/attempts/$ATTEMPT2/result" -H 'content-type: application/json' \
  -d "{\"lease_token\":\"$LEASE2\",\"fencing_token\":$FENCE2,\"status\":\"SUCCEEDED\",\"summary\":\"ok\"}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("task:",d["task"]["status"],"attempt:",d["attempt_status"])'

hr "10. 事件时间线（只追加）"
curl -s "$BASE/v1/tasks/$TASK_ID/events" | python3 "$(dirname "$0")/timeline.py"

hr "11. 队列统计"
curl -s "$BASE/v1/queue/stats"; echo
