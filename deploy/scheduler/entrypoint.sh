#!/usr/bin/env bash
# Scheduler container entrypoint: authorize SSH → wait for DB → migrate → optional seed → run the scheduler in the foreground.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

SCHEDULER_INSTANCE_ID="${SCHEDULER_INSTANCE_ID:-scheduler}"
SCHEDULER_AGENT_PROFILE_ID="${SCHEDULER_AGENT_PROFILE_ID:-agp_scheduler}"
SCHEDULER_HOST_ID="${SCHEDULER_HOST_ID:-docker-host-01}"

mkdir -p /root/.ssh /var/run/sshd /opt/platform/{artifacts,keys,logs,audit,workspace/scheduler}
chmod 700 /root/.ssh
# keys is usually mounted as a read-only volume, so chmod returns EROFS; the permissions are decided on the host side.
chmod 700 /opt/platform/keys 2>/dev/null || true

if [[ -n "${SSH_PUBKEY_FILE:-}" && -f "$SSH_PUBKEY_FILE" ]]; then
  cp "$SSH_PUBKEY_FILE" /root/.ssh/authorized_keys
elif [[ -n "${SSH_AUTHORIZED_KEY:-}" ]]; then
  printf '%s\n' "$SSH_AUTHORIZED_KEY" > /root/.ssh/authorized_keys
fi
chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true

ssh-keygen -A >/dev/null
/usr/sbin/sshd -e

cd /opt/platform/scheduler

for i in $(seq 1 60); do
  if npm run migrate; then
    break
  fi
  if [[ "$i" == "60" ]]; then
    echo "Database migration failed: not connected or not applied within 60 seconds" >&2
    exit 1
  fi
  echo "Waiting for the database ($i/60)..."
  sleep 2
done

if [[ "${SEED:-0}" == "1" ]]; then
  npm run seed
fi

# The scheduler service runs in the background; a host-runtime instance is started alongside to run
# task.chat.scheduler / task.console.scheduler, so the scheduler bot ("Relay") can chat and troubleshoot.
npm start &
SCHED_PID=$!

cleanup() {
  kill "$SCHED_PID" "${AGENT_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup TERM INT

for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT:-8443}/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SCHED_PID" 2>/dev/null; then
    echo "The scheduler process exited early" >&2
    exit 1
  fi
  sleep 1
done

node -e '
const fs = require("node:fs");
const cfg = {
  scheduler_url: "http://127.0.0.1:" + (process.env.PORT || "8443"),
  heartbeat_seconds: 10,
  claim_interval_seconds: 2,
  lease_renew_seconds: 60,
  progress_seconds: 3,
  config_sync_seconds: 30,
  request_timeout_ms: 5000,
  token_dir: process.env.INSTANCE_TOKEN_DIR || "/opt/platform/tokens",
  workspace_dir: "/opt/platform/workspace/scheduler",
  keep_workspace: false,
  audit_dir: "/opt/platform/audit",
  ...(process.env.PROFILES_FILE ? { profiles_file: process.env.PROFILES_FILE } : {}),
  instances: [{
    instance_id: process.env.SCHEDULER_INSTANCE_ID || "scheduler",
    role_id: "scheduler",
    host_id: process.env.SCHEDULER_HOST_ID || "docker-host-01",
    agent_profile_id: process.env.SCHEDULER_AGENT_PROFILE_ID || "agp_scheduler",
    task_types: ["task.chat.scheduler", "task.console.scheduler"],
    capabilities: { healthy: ["queue", "lease", "shell", "llm"] },
    slots: 1,
    slot_memory_bytes: 536870912,
  }],
};
fs.writeFileSync("/opt/platform/runtime.config.json", JSON.stringify(cfg, null, 2));
'
export RUNTIME_CONFIG=/opt/platform/runtime.config.json
export SCHEDULER_TOKEN="${AUTH_TOKEN:-}"
# Same as the builder: small platforms use a shorter task-claim poll to trade for interaction latency.
export CLAIM_INTERVAL_SECONDS="${CLAIM_INTERVAL_SECONDS:-0.5}"

start_agent() {
  ( cd /opt/platform/host-runtime && exec node --import tsx src/main.ts --instance "$SCHEDULER_INSTANCE_ID" )
}
start_agent &
AGENT_PID=$!

while kill -0 "$SCHED_PID" 2>/dev/null; do
  if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    wait "$AGENT_PID" 2>/dev/null || true
    echo "[scheduler-agent] Exited; restarting in 2 seconds" >&2
    sleep 2
    start_agent &
    AGENT_PID=$!
  fi
  sleep 2
done

wait "$SCHED_PID"
exit $?
