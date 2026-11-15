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

# shellcheck source=scripts/lib-env.sh
. "$ROOT/scripts/lib-env.sh"
ensure_curl || { echo "[demo] curl is required" >&2; exit 1; }
ensure_docker 1 || { echo "[demo] Docker is required (set PLATFORM_AUTO_INSTALL=1 on Debian/Ubuntu to install it)" >&2; exit 1; }
reexec_with_docker_group "$0" "$@"
docker info >/dev/null 2>&1 || { echo "[demo] Docker is installed but not accessible; log out and back in" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "[demo] Docker Compose v2 is required" >&2; exit 1; }

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
    cat <<'USAGE'
Usage: scripts/demo.sh [--down [--volumes] | --logs]

  (no arguments)  build and start the demo, then print the URL and credentials
  --down          stop the demo containers (data volumes are kept)
  --down --volumes  stop the demo and delete its data volumes
  --logs          follow the container logs
  --help          show this help

The demo runs at http://127.0.0.1:18080 (override with DEMO_PORT)
and signs in with admin / admin (demo-only credentials).

Stop it at any time with:  scripts/demo.sh --down
USAGE
    exit 0
    ;;
esac

# Docker Hub is frequently unreachable from mainland networks; fall back to a mirror.
if [ -z "${DEMO_REGISTRY:-}" ]; then
  hub_code="$(curl -s -m 6 -o /dev/null -w '%{http_code}' https://registry-1.docker.io/v2/ || true)"
  if [ "$hub_code" = "000" ]; then
    DEMO_REGISTRY="docker.m.daocloud.io/library/"
    echo "[demo] Docker Hub unreachable; pulling images through docker.m.daocloud.io"
  fi
fi
export DEMO_REGISTRY
[ -n "${DEMO_REGISTRY:-}" ] && echo "[demo] image registry: ${DEMO_REGISTRY}"

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'POSTGRES_PASSWORD=%s\n' "$password" > "$ENV_FILE"
  echo "[demo] created $ENV_FILE with a random PostgreSQL password"
fi
chmod 600 "$ENV_FILE"

echo "[demo] starting the demo at $URL (sign in admin / admin)"
echo "[demo] stop it at any time with: $0 --down   (add --volumes to delete the demo data)"
echo "[demo] the first run builds four images and can take 10+ minutes on a slow network;"
echo "[demo] npm fetch lines and BuildKit step timings below show that it is making progress."
# A previous interrupted run can leave containers or a network with the same
# names; clear them (volumes are kept) so the start is idempotent.
compose down --remove-orphans >/dev/null 2>&1 || true
# Build only when an image is missing (or explicitly requested): a plain start
# should not pay the multi-minute build again.
need_build="${DEMO_REBUILD:-0}"
for image in platform/pcs:demo platform/web:demo platform/scheduler:demo platform/builder:demo-ubuntu22.04; do
  docker image inspect "$image" >/dev/null 2>&1 || need_build=1
done
if [ "$need_build" = "1" ]; then
  echo "[demo] building images (set DEMO_REBUILD=0 to reuse existing images)"
  compose build
else
  echo "[demo] images already exist; skipping the build (set DEMO_REBUILD=1 to force one)"
fi
compose up -d --remove-orphans

seed_tasks() {
  local base="http://127.0.0.1:${DEMO_SCHEDULER_PORT}"
  submit() {
    local instance="$1" title="$2" command="$3"
    curl -fsS -X POST "$base/v1/tasks" -H 'content-type: application/json' \
      -d "{\"task_type\":\"task.console.builder\",\"priority_class\":1,\"max_attempts\":1,\"payload_ref\":\"admin://demo/${instance}\",\"requirements\":{\"target_instance_id\":\"${instance}\",\"build\":{\"title\":\"${title}\"},\"console\":{\"command\":\"${command}\"}}}" \
      >/dev/null || echo "[demo] could not submit: $title" >&2
  }
  # Two legs finish immediately and leave a green trail.
  submit dev-middle "Middle layer: unit tests pass" "echo middle-layer-tests-passed"
  submit dev-driver "Driver: build check passes" "echo driver-build-check-passed"
  sleep 3
  # Two long-running legs keep the studio animated; two more queue behind dev-ui.
  submit dev-ui "UI: login page styling" "sleep 3600"
  submit kernel-dev "Kernel: interrupt latency stress test" "sleep 3600"
  submit dev-ui "UI: settings component refactor" "sleep 3600"
  submit dev-ui "UI: theme switching regression" "sleep 3600"
}

echo "[demo] waiting for the admin app..."
waited=0
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
  Sign in        admin / admin
  Scheduler API  http://127.0.0.1:${DEMO_SCHEDULER_PORT}

Demo credentials only: the UI is bound to loopback. Never expose it to a network.

Scenario: a development host (UI / middle-layer / driver builders) with a root
scheduler, plus a folded kernel host running the kernel workstream; development,
test and after-sales clients connect through sideload tokens.
No model key is needed for the Shell tasks. Host onboarding is disabled in this
demo: adding a host is rejected with a demo-mode message.

  Logs  scripts/demo.sh --logs
  Stop  scripts/demo.sh --down
EOF
    exit 0
  fi
  waited=$((waited + 2))
  if [ $((waited % 10)) -eq 0 ]; then
    echo "[demo] still starting... ${waited}s (build/health-check in progress; logs: scripts/demo.sh --logs)"
  fi
  sleep 2
done

echo "[demo] the admin app did not become ready within 6 minutes" >&2
echo "[demo] recent logs:" >&2
compose logs --tail=80 >&2 || true
exit 1
