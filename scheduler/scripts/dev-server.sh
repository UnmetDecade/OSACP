#!/usr/bin/env bash
# Start/stop the scheduler in the foreground/background on this machine (for development, not production deployment)
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$DIR/server.pid"
LOGFILE="$DIR/server.log"
PATTERN="node --import tsx src/main.ts"
# The fallback match must anchor at end of line: the host runtime process is `... src/main.ts --instance worker-a`,
# Without $ it treats agent as the scheduler and kills the wrong process on stop
FIND_PATTERN="node --import tsx src/main.ts\$"

# The pidfile may be lost (e.g. removed by rsync --delete), so fall back to finding by process name
find_pid() {
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    cat "$PIDFILE"
    return
  fi
  pgrep -f -- "$FIND_PATTERN" | head -1
}

case "${1:-}" in
  start)
    running="$(find_pid || true)"
    if [[ -n "$running" ]]; then echo "already running: $running"; exit 0; fi
    cd "$DIR"
    # The subshell writes the pidfile itself: the pid stays the same after exec, so stop won't kill the wrong process
    setsid bash -c "echo \$\$ > '$PIDFILE'; exec $PATTERN" \
      > "$LOGFILE" 2>&1 < /dev/null &
    sleep 2
    echo "started pid $(cat "$PIDFILE")"
    ;;
  stop)
    running="$(find_pid || true)"
    if [[ -n "$running" ]]; then
      kill "$running" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo "stopped $running"
    else
      echo "not running"
    fi
    ;;
  restart)
    "$0" stop || true
    "$0" start
    ;;
  status)
    running="$(find_pid || true)"
    if [[ -n "$running" ]]; then echo "running pid $running"; else echo "stopped"; fi
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status}"; exit 1;;
esac
