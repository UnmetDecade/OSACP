#!/usr/bin/env bash
# Start/stop the local Host Runtime daemon + standalone watchdog (for development; use two systemd units in production)
# Usage: ./scripts/runtime.sh start|stop|status|logs
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
CFG="${RUNTIME_HOST_CONFIG:-$DIR/runtime.host.json}"
mkdir -p "$DIR/run"
RT_PID="$DIR/run/host-runtime.pid"
WD_PID="$DIR/run/watchdog.pid"

find_pid() {
  local pidfile="$1" pattern="$2"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    cat "$pidfile"; return
  fi
  pgrep -f -- "$pattern" | head -1 || true
}

start_one() {
  local name="$1" script="$2" pidfile="$3" logfile="$4"
  local running
  running="$(find_pid "$pidfile" "node --import tsx src/$script")"
  if [[ -n "$running" ]]; then echo "$name 已在运行（pid $running）"; return; fi
  setsid bash -c "cd '$DIR'; echo \$\$ > '$pidfile'; exec node --import tsx src/$script --config '$CFG'" \
    > "$logfile" 2>&1 < /dev/null &
  sleep 0.5
  echo "$name 启动，pid $(cat "$pidfile" 2>/dev/null || echo '?')，日志 $logfile"
}

case "${1:-}" in
  start)
    if [[ ! -f "$CFG" ]]; then
      echo "找不到配置 $CFG（可从 runtime.host.example.json 复制）" >&2
      exit 1
    fi
    start_one "watchdog" "watchdog.ts" "$WD_PID" "$DIR/run/watchdog.log"
    start_one "host-runtime" "runtime.ts" "$RT_PID" "$DIR/run/host-runtime.log"
    ;;
  stop)
    for pair in "host-runtime:$RT_PID:src/runtime.ts" "watchdog:$WD_PID:src/watchdog.ts"; do
      IFS=: read -r name pidfile pattern <<< "$pair"
      pid="$(find_pid "$pidfile" "node --import tsx $pattern")"
      if [[ -n "$pid" ]]; then
        kill "$pid" 2>/dev/null || true
        rm -f "$pidfile"
        echo "$name 已停止（pid $pid）"
      else
        echo "$name 未运行"
      fi
    done
    rm -f "$DIR/run/runtime.sock"
    ;;
  status)
    for pair in "host-runtime:$RT_PID:src/runtime.ts" "watchdog:$WD_PID:src/watchdog.ts"; do
      IFS=: read -r name pidfile pattern <<< "$pair"
      pid="$(find_pid "$pidfile" "node --import tsx $pattern")"
      if [[ -n "$pid" ]]; then echo "$name  running pid $pid"; else echo "$name  stopped"; fi
    done
    idfile="$DIR/run/identity/host.json"
    if [[ -f "$idfile" ]]; then
      node -e "const j=require('$idfile'); console.log('host_id', j.host_id, 'token_expires', j.expires_at)" 2>/dev/null || true
    fi
    ;;
  logs)
    tail -n 80 "$DIR/run/host-runtime.log" "$DIR/run/watchdog.log" 2>/dev/null || true
    ;;
  *)
    echo "usage: $0 {start|stop|status|logs}"; exit 1;;
esac
