#!/usr/bin/env bash
# Start N role instances in the background (one process per instance, so each can be killed individually to simulate a crash)
# Usage: ./scripts/start.sh builder-ubuntu22-a builder-ubuntu24-a
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DIR/run"

for id in "$@"; do
  pidfile="$DIR/run/$id.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$id is already running (pid $(cat "$pidfile"))"
    continue
  fi
  setsid bash -c "cd '$DIR'; echo \$\$ > '$pidfile'; exec node --import tsx src/main.ts --instance $id" \
    > "$DIR/run/$id.log" 2>&1 < /dev/null &
  sleep 0.4
  echo "$id started, pid $(cat "$pidfile"), log run/$id.log"
done
