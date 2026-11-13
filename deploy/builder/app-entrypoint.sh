#!/usr/bin/env bash
# Builder container entrypoint (pure OS image version).
#
# The image is official ubuntu, and deployment ships only these files: the instance runtime (/opt/platform/app),
# the Agent adapters (/opt/platform/agents), and the sshd config. Node, the Agent CLI and the openssh deb
# all live in the host cache (mounted read-only at /opt/platform/cache); the runtime and toolchain are not baked into the container.
set -euo pipefail

CACHE="${PLATFORM_CACHE_DIR:-/opt/platform/cache}"
APP="${BUILDER_APP_DIR:-/opt/platform/app}"

NODE="$CACHE/node/bin/node"
if [[ ! -x "$NODE" ]]; then
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" ]]; then
  echo "Node is not in the host cache: $CACHE/node/bin/node; place a Node 22 build in ~/.platform/cache/node on the host" >&2
  exit 1
fi
# The Agent CLI (claude / codex) is placed in the cache directory as needed; the instance runtime finds them via PATH.
export PATH="$CACHE/node/bin:$CACHE/agents:${PATH}"
# Let shells entered via docker exec / ssh use node and claude directly, without remembering cache paths.
for b in node npm npx; do
  [[ -x "$CACHE/node/bin/$b" ]] && ln -sf "$CACHE/node/bin/$b" /usr/local/bin/$b
done
for b in claude codex; do
  [[ -x "$CACHE/agents/$b" ]] && ln -sf "$CACHE/agents/$b" /usr/local/bin/$b
done

: "${SCHEDULER_URL:?SCHEDULER_URL is required}"
: "${INSTANCE_ID:?INSTANCE_ID is required}"
ROLE_ID="${ROLE_ID:-builder}"
HOST_ID="${HOST_ID:-docker-host-01}"
AGENT_PROFILE_ID="${AGENT_PROFILE_ID:-agp_builder}"
BUILDER_OS="${BUILDER_OS:-ubuntu24.04}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/opt/platform/workspace}"

mkdir -p /root/.ssh /run/sshd "$WORKSPACE_DIR" \
  /opt/platform/{artifacts,logs,tokens,keys,audit,codex}
chmod 700 /root/.ssh
# keys is usually mounted as a read-only volume, so chmod returns EROFS; the permissions are decided on the host side.
chmod 700 /opt/platform/keys 2>/dev/null || true

# The pure ubuntu image has no ssh/sshd: install offline from host-cached debs (the cache must match the image version).
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
# Authorized public keys: prefer the mounted keys directory, then SSH_PUBKEY_FILE / SSH_AUTHORIZED_KEY.
if [[ -n "${SSH_PUBKEY_FILE:-}" && -f "$SSH_PUBKEY_FILE" ]]; then
  cp "$SSH_PUBKEY_FILE" /root/.ssh/authorized_keys
elif [[ -n "${SSH_AUTHORIZED_KEY:-}" ]]; then
  printf '%s\n' "$SSH_AUTHORIZED_KEY" > /root/.ssh/authorized_keys
fi
chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true

ssh-keygen -A >/dev/null
/usr/sbin/sshd -e

# ---- Installed package persistence ----
# The builder is a one-off container, but installed environments should not disappear on every redeploy:
#   * the state volume is isolated per instance (platform-<instance>-state) and records only this instance's package list;
#   * /var/cache/apt/archives is mounted on a host-shared volume (shared-apt-cache),
#     reusing only downloaded debs, never pulling another builder's packages into the current environment.
STATE_DIR="${STATE_DIR:-/opt/platform/state}"
mkdir -p "$STATE_DIR"
APT_SNAPSHOT="$STATE_DIR/dpkg-packages.txt"

# The official image deletes debs after install by default (docker-clean); put the download directory on the shared volume and keep the debs,
# so other builders on the same host can reuse them directly without re-downloading (the volume holds only package files, not the environment).
APT_SHARE="${APT_SHARE_DIR:-/opt/platform/apt-cache}"
mkdir -p "$APT_SHARE/archives/partial"
if [[ -d /etc/apt/apt.conf.d ]]; then
  printf 'Dir::Cache::archives "%s/archives";\nAPT::Keep-Downloaded-Packages "true";\nBinary::apt::APT::Keep-Downloaded-Packages "true";\n' \
    "$APT_SHARE" > /etc/apt/apt.conf.d/99-platform-apt-share
  rm -f /etc/apt/apt.conf.d/docker-clean
fi

apt_snapshot() {
  dpkg-query -W -f='${binary:Package}=${Version}\n' 2>/dev/null \
    | LC_ALL=C sort >"$APT_SNAPSHOT.tmp" && mv -f "$APT_SNAPSHOT.tmp" "$APT_SNAPSHOT"
}

apt_restore() {
  [[ -s "$APT_SNAPSHOT" ]] || return 0
  local current missing names
  current="$(mktemp)"
  dpkg-query -W -f='${binary:Package}=${Version}\n' 2>/dev/null | LC_ALL=C sort >"$current"
  missing="$(LC_ALL=C comm -13 "$current" "$APT_SNAPSHOT" || true)"
  rm -f "$current"
  [[ -n "${missing//[$'\n']/}" ]] || return 0
  names="$(printf '%s\n' "$missing" | sed 's/=.*//' | tr '\n' ' ')"
  export DEBIAN_FRONTEND=noninteractive
  echo "[builder] Restoring installed packages: $(printf '%s\n' "$names" | wc -w)" >&2
  # Install from the shared cache at the original versions first; if the cache is incomplete, fetch from the network, and only fall back to installing the latest version by package name.
  if ! apt-get install -y -o Dpkg::Options::=--force-confold --no-download $missing >/dev/null 2>&1; then
    if getent hosts archive.ubuntu.com >/dev/null 2>&1; then
      apt-get update -qq >/dev/null 2>&1 || true
      apt-get install -y -o Dpkg::Options::=--force-confold $missing >/dev/null 2>&1 \
        || apt-get install -y -o Dpkg::Options::=--force-confold $names >/dev/null 2>&1 \
        || echo "[builder] Some packages failed to restore; the builder can reinstall them later" >&2
    fi
  fi
  echo "[builder] Package restore complete" >&2
}

apt_watch() {
  # Installs usually take seconds to minutes; a package-list snapshot every 30 seconds gives enough coverage, with one more on shutdown.
  trap 'apt_snapshot; exit 0' TERM INT
  while true; do
    sleep 30
    apt_snapshot || true
  done
}

apt_restore || true
apt_snapshot || true
apt_watch &

# Each container runs only one instance; the config is generated from environment variables, without bringing in host config.
"$NODE" -e '
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
    capabilities: { healthy: ["code.build", "shell", "llm"], os: process.env.BUILDER_OS || "ubuntu24.04" },
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
# The Codex config is delivered with the deployment payload to /opt/platform/codex; the key is still injected only at runtime.
export CODEX_HOME="${CODEX_HOME:-/opt/platform/codex}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.deepseek.com/anthropic}"
# Task-claim polling interval: small platforms use 0.5s; with many machines, set it back to 1–2s to save the database.
export CLAIM_INTERVAL_SECONDS="${CLAIM_INTERVAL_SECONDS:-0.5}"

cd "$APP"
exec "$NODE" "$APP/agent-runtime.mjs" --instance "$INSTANCE_ID"
