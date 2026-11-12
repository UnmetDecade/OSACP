#!/usr/bin/env bash
# 优雅停止（SIGTERM → drain）；加 --force 直接 kill -9，模拟崩溃
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
force=""
[[ "${1:-}" == "--force" ]] && { force=1; shift; }

for id in "$@"; do
  pidfile="$DIR/run/$id.pid"
  if [[ ! -f "$pidfile" ]]; then echo "$id 没在运行"; continue; fi
  pid="$(cat "$pidfile")"
  if [[ -n "$force" ]]; then
    kill -9 "$pid" 2>/dev/null && echo "$id 已强杀（模拟崩溃）"
  else
    kill "$pid" 2>/dev/null && echo "$id 收到 SIGTERM，drain 中"
  fi
  rm -f "$pidfile"
done
