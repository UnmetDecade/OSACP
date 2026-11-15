#!/usr/bin/env bash
# One-command demo: PostgreSQL + PCS + scheduler + one builder + the admin UI.
#
#   scripts/demo.sh           build and start, then print the URL
#   scripts/demo.sh --down    stop the stack (pass --volumes to also drop data)
#   scripts/demo.sh --logs    follow container logs
#
# Requires Docker with the Compose v2 plugin. The first run builds three images
# (scheduler, builder, web) and takes several minutes; later runs are cached.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="deploy/compose.demo.yaml"
ENV_FILE="deploy/.env.demo"
DEMO_PORT="${DEMO_PORT:-18080}"
DEMO_SCHEDULER_PORT="${DEMO_SCHEDULER_PORT:-18443}"
URL="http://127.0.0.1:${DEMO_PORT}"
export DEMO_PORT DEMO_SCHEDULER_PORT

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "[demo] docker is required" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "[demo] Docker Compose v2 is required (docker compose)" >&2
  exit 1
fi

case "${1:-}" in
  --down)
    shift
    compose down "$@"
    exit 0
    ;;
  --logs)
    compose logs -f
    exit 0
    ;;
  --help|-h)
    sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  admin_password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'POSTGRES_PASSWORD=%s\nDEMO_ADMIN_PASSWORD=%s\n' "$password" "$admin_password" > "$ENV_FILE"
  echo "[demo] created $ENV_FILE with random database and admin passwords"
fi
# Older demo env files predate accounts; add the admin password in place.
if ! grep -q '^DEMO_ADMIN_PASSWORD=' "$ENV_FILE"; then
  printf 'DEMO_ADMIN_PASSWORD=%s\n' "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
ADMIN_PASSWORD="$(grep -m1 '^DEMO_ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"

echo "[demo] building and starting the stack (first run takes a few minutes)..."
compose up -d --build

seed_tasks() {
  local base="http://127.0.0.1:${DEMO_SCHEDULER_PORT}"
  submit() {
    local instance="$1" title="$2" command="$3"
    curl -fsS -X POST "$base/v1/tasks" -H 'content-type: application/json' \
      -d "{\"task_type\":\"task.console.builder\",\"priority_class\":1,\"max_attempts\":1,\"payload_ref\":\"admin://demo/${instance}\",\"requirements\":{\"target_instance_id\":\"${instance}\",\"build\":{\"title\":\"${title}\"},\"console\":{\"command\":\"${command}\"}}}" \
      >/dev/null || echo "[demo] could not submit: $title" >&2
  }
  # Two legs finish immediately and leave a green trail.
  submit dev-middle "中间层开发：单元测试通过" "echo middle-layer-tests-passed"
  submit dev-driver "驱动开发：编译检查通过" "echo driver-build-check-passed"
  sleep 3
  # Two long-running legs keep the studio animated; two more queue behind dev-ui.
  submit dev-ui "界面开发：登录页样式联调" "sleep 3600"
  submit kernel-dev "内核开发：中断延迟压测" "sleep 3600"
  submit dev-ui "界面开发：设置页组件重构" "sleep 3600"
  submit dev-ui "界面开发：主题切换回归" "sleep 3600"
}

echo "[demo] waiting for the admin app..."
for _ in $(seq 1 180); do
  if curl -fsS "$URL/" >/dev/null 2>&1; then
    # Seed the storyline once: hosts/deployments/sideloads come from PCS, tasks from the scheduler.
    if ! curl -fsS "http://127.0.0.1:${DEMO_SCHEDULER_PORT}/v1/tasks?limit=1" 2>/dev/null | grep -q 'task_id'; then
      echo "[demo] seeding the example-project tasks..."
      seed_tasks
    fi
    cat <<EOF

[demo] ready

  Admin app      $URL
  Sign in        admin / $ADMIN_PASSWORD
  Scheduler API  http://127.0.0.1:${DEMO_SCHEDULER_PORT}

The admin password is also stored in deploy/.env.demo (0600).

Scenario: 开发机 (界面 / 中间层 / 驱动开发) with a root scheduler, plus a folded
调度机 running the kernel workstream; 开发 / 测试 / 售后 are sideload clients.
No model key is needed for the Shell tasks. Host onboarding is disabled in this
demo: adding a host is rejected with a demo-mode message.

  Logs  scripts/demo.sh --logs
  Stop  scripts/demo.sh --down
EOF
    exit 0
  fi
  sleep 2
done

echo "[demo] the admin app did not become ready within 6 minutes" >&2
echo "[demo] recent logs:" >&2
compose logs --tail=80 >&2 || true
exit 1
