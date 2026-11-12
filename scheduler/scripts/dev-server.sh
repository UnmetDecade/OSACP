#!/usr/bin/env bash
# 在本机前台/后台起停调度机（开发用，不是生产部署方式）
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$DIR/server.pid"
LOGFILE="$DIR/server.log"
PATTERN="node --import tsx src/main.ts"
# 兜底匹配必须锚定行尾：主机运行时的进程是 `... src/main.ts --instance worker-a`，
# 不加 $ 会把 agent 当成调度机，stop 时误杀
FIND_PATTERN="node --import tsx src/main.ts\$"

# pidfile 可能丢（比如被 rsync --delete 清掉），所以再按进程名兜底找一次
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
    # 子 shell 自己写 pidfile：exec 之后 pid 不变，停的时候不会误杀
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
