#!/usr/bin/env bash
# 后台启动 N 个角色实例（每个实例一个进程，方便单独 kill 掉模拟崩溃）
# 用法：./scripts/start.sh builder-ubuntu22-a builder-ubuntu24-a
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DIR/run"

for id in "$@"; do
  pidfile="$DIR/run/$id.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$id 已在运行（pid $(cat "$pidfile")）"
    continue
  fi
  setsid bash -c "cd '$DIR'; echo \$\$ > '$pidfile'; exec node --import tsx src/main.ts --instance $id" \
    > "$DIR/run/$id.log" 2>&1 < /dev/null &
  sleep 0.4
  echo "$id 启动，pid $(cat "$pidfile")，日志 run/$id.log"
done
