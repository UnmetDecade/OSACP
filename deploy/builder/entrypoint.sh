#!/usr/bin/env bash
# Builder container entrypoint: generate instance config → start sshd → run role-agent in the foreground.
set -euo pipefail

: "${SCHEDULER_URL:?SCHEDULER_URL is required}"
: "${INSTANCE_ID:?INSTANCE_ID is required}"
ROLE_ID="${ROLE_ID:-builder}"
HOST_ID="${HOST_ID:-docker-host-01}"
AGENT_PROFILE_ID="${AGENT_PROFILE_ID:-agp_builder}"
BUILDER_OS="${BUILDER_OS:-ubuntu22.04}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/opt/platform/workspace}"
SLOTS="${MAX_CONCURRENCY:-1}"

mkdir -p /root/.ssh /var/run/sshd "$WORKSPACE_DIR" /opt/platform/{artifacts,logs,tokens,keys,audit}
chmod 700 /root/.ssh
# keys is usually mounted as a read-only volume, so chmod returns EROFS; the permissions are decided on the host side.
chmod 700 /opt/platform/keys 2>/dev/null || true

# Authorized public keys: prefer the mounted keys directory, then the SSH_AUTHORIZED_KEY environment variable.
if [[ -n "${SSH_PUBKEY_FILE:-}" && -f "$SSH_PUBKEY_FILE" ]]; then
  cp "$SSH_PUBKEY_FILE" /root/.ssh/authorized_keys
elif [[ -n "${SSH_AUTHORIZED_KEY:-}" ]]; then
  printf '%s\n' "$SSH_AUTHORIZED_KEY" > /root/.ssh/authorized_keys
fi
chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true

ssh-keygen -A >/dev/null
/usr/sbin/sshd -e

# Each container runs only one instance; the config is generated from environment variables, without bringing in host config.
node -e '
const fs = require("node:fs");
let capabilityDetail;
try {
  capabilityDetail = process.env.CAPABILITY_DETAIL ? JSON.parse(process.env.CAPABILITY_DETAIL) : undefined;
} catch { capabilityDetail = undefined; }
const cfg = {
  scheduler_url: process.env.SCHEDULER_URL,
  heartbeat_seconds: 10,
  claim_interval_seconds: 2,
  lease_renew_seconds: 60,
  progress_seconds: 3,
  config_sync_seconds: 30,
  request_timeout_ms: 5000,
  token_dir: process.env.INSTANCE_TOKEN_DIR || "/opt/platform/tokens",
  workspace_dir: process.env.WORKSPACE_DIR || "/opt/platform/workspace",
  keep_workspace: process.env.KEEP_WORKSPACE === "1",
  audit_dir: "/opt/platform/audit",
  // PCS-exported runtime view (agent_profiles + bindings); without it, only the deterministic executor is available.
  ...(process.env.PROFILES_FILE ? { profiles_file: process.env.PROFILES_FILE } : {}),
  instances: [{
    instance_id: process.env.INSTANCE_ID,
    role_id: process.env.ROLE_ID || "builder",
    host_id: process.env.HOST_ID || "docker-host-01",
    agent_profile_id: process.env.AGENT_PROFILE_ID || "agp_builder",
    task_types: ["task.build", "task.chat.builder", "task.console.builder"],
    capabilities: { healthy: ["code.build", "shell", "llm"], os: process.env.BUILDER_OS || "ubuntu22.04" },
    ...(process.env.CAPABILITY_SCORE ? { capability_score: Number(process.env.CAPABILITY_SCORE) } : {}),
    ...(capabilityDetail ? { capability_detail: capabilityDetail } : {}),
    slots: Number(process.env.MAX_CONCURRENCY || 1),
    slot_memory_bytes: Number(process.env.SLOT_MEMORY_BYTES || 2147483648),
  }],
};
fs.writeFileSync("/opt/platform/runtime.config.json", JSON.stringify(cfg, null, 2));
'
export RUNTIME_CONFIG=/opt/platform/runtime.config.json
export BUILDER_OS
# Task-claim polling interval. The perceived latency of console/chat is mainly "task enqueued → instance claims it";
# the default 2s saves the database for large clusters, while a single machine or a few builders is more responsive with 0.5s.
export CLAIM_INTERVAL_SECONDS="${CLAIM_INTERVAL_SECONDS:-0.5}"

cd /opt/platform/host-runtime
exec node --import tsx src/main.ts --instance "$INSTANCE_ID"
