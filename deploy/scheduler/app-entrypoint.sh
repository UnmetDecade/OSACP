#!/usr/bin/env bash
# Scheduler container entrypoint (pure OS image version).
#
# The image is official ubuntu, and deployment ships only these files: the application bundle (/opt/platform/app),
# the Agent Profile (/opt/platform/profiles.json). Node, the Agent CLI and the openssh deb
# all live in the host cache (mounted read-only at /opt/platform/cache); the runtime is not baked into the container.
set -euo pipefail

CACHE="${PLATFORM_CACHE_DIR:-/opt/platform/cache}"
APP="${SCHEDULER_APP_DIR:-/opt/platform/app}"

NODE="$CACHE/node/bin/node"
if [[ ! -x "$NODE" ]]; then
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" ]]; then
  echo "Node is not in the host cache: $CACHE/node/bin/node; place a Node 22 build in ~/.platform/cache/node on the host" >&2
  exit 1
fi
# The Agent CLI (claude / codex) is placed in the cache directory as needed; cli-agent in the scheduler finds them via PATH.
export PATH="$CACHE/node/bin:$CACHE/agents:${PATH}"
# Let shells entered via docker exec / ssh use node and claude directly, without remembering cache paths.
for b in node npm npx; do
  [[ -x "$CACHE/node/bin/$b" ]] && ln -sf "$CACHE/node/bin/$b" /usr/local/bin/$b
done
for b in claude codex; do
  [[ -x "$CACHE/agents/$b" ]] && ln -sf "$CACHE/agents/$b" /usr/local/bin/$b
done

: "${DATABASE_URL:?DATABASE_URL is required}"

SCHEDULER_INSTANCE_ID="${SCHEDULER_INSTANCE_ID:-scheduler}"
SCHEDULER_AGENT_PROFILE_ID="${SCHEDULER_AGENT_PROFILE_ID:-agp_scheduler}"
SCHEDULER_HOST_ID="${SCHEDULER_HOST_ID:-docker-host-01}"
PORT="${PORT:-8443}"

# Builder tools for the scheduler Agent (MCP stdio): the tools dispatch tasks through the local scheduler API,
# with the port written into the config based on the actual listener rather than hardcoded.
cat > "$APP/mcp.json" <<JSON
{"mcpServers":{"builders":{"command":"$NODE","args":["$APP/tools.mjs"],"env":{"SCHEDULER_URL":"http://127.0.0.1:${PORT}"}}}}
JSON
# A single tool call may take several minutes (apt install / compilation); default to 10 minutes.
export MCP_TIMEOUT="${MCP_TIMEOUT:-30000}"
export MCP_TOOL_TIMEOUT="${MCP_TOOL_TIMEOUT:-600000}"

mkdir -p /root/.ssh /run/sshd \
  /opt/platform/{artifacts,keys,logs,audit,tokens,workspace/scheduler}
chmod 700 /root/.ssh
# keys is usually mounted as a read-only volume, so chmod returns EROFS; the permissions are decided on the host side.
chmod 700 /opt/platform/keys 2>/dev/null || true

# The pure ubuntu image has no ssh/sshd: install offline from host-cached debs, only once.
if ! command -v sshd >/dev/null || ! command -v ssh >/dev/null; then
  if compgen -G "$CACHE/openssh/*.deb" >/dev/null; then
    DEBIAN_FRONTEND=noninteractive dpkg -i "$CACHE"/openssh/*.deb
  else
    echo "ssh/sshd is missing and the host cache has no $CACHE/openssh/*.deb" >&2
    exit 1
  fi
fi

if [[ -f "$APP/sshd_config" ]]; then
  cp "$APP/sshd_config" /etc/ssh/sshd_config.d/00-platform.conf
fi
if [[ -n "${SSH_PUBKEY_FILE:-}" && -f "$SSH_PUBKEY_FILE" ]]; then
  cp "$SSH_PUBKEY_FILE" /root/.ssh/authorized_keys
elif [[ -n "${SSH_AUTHORIZED_KEY:-}" ]]; then
  printf '%s\n' "$SSH_AUTHORIZED_KEY" > /root/.ssh/authorized_keys
fi
chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true

ssh-keygen -A >/dev/null
/usr/sbin/sshd -e

cd "$APP"

for i in $(seq 1 60); do
  if "$NODE" migrate.mjs; then
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
  "$NODE" migrate.mjs --seed
fi

# The scheduler service runs in the background; a host-runtime instance is started alongside to run
# task.chat.scheduler / task.console.scheduler, so the scheduler bot ("Relay") can chat and troubleshoot.
"$NODE" main.mjs &
SCHED_PID=$!

cleanup() {
  kill "$SCHED_PID" "${AGENT_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup TERM INT

for i in $(seq 1 60); do
  if "$NODE" -e "fetch('http://127.0.0.1:${PORT}/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    break
  fi
  if ! kill -0 "$SCHED_PID" 2>/dev/null; then
    echo "The scheduler process exited early" >&2
    exit 1
  fi
  sleep 1
done

"$NODE" -e '
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
  ( exec "$NODE" "$APP/agent-runtime.mjs" --instance "$SCHEDULER_INSTANCE_ID" )
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
