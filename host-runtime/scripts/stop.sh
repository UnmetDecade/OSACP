#!/usr/bin/env bash
# Graceful stop (SIGTERM → drain); add --force to kill -9 directly and simulate a crash
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
