#!/usr/bin/env bash
# 构建机容器入口：生成实例配置 → 起 sshd → 前台跑 role-agent。
set -euo pipefail

: "${SCHEDULER_URL:?缺少 SCHEDULER_URL}"
: "${INSTANCE_ID:?缺少 INSTANCE_ID}"
ROLE_ID="${ROLE_ID:-builder}"
HOST_ID="${HOST_ID:-docker-host-01}"
AGENT_PROFILE_ID="${AGENT_PROFILE_ID:-agp_builder}"
BUILDER_OS="${BUILDER_OS:-ubuntu22.04}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/opt/platform/workspace}"
SLOTS="${MAX_CONCURRENCY:-1}"

mkdir -p /root/.ssh /var/run/sshd "$WORKSPACE_DIR" /opt/platform/{artifacts,logs,tokens,keys,audit}
chmod 700 /root/.ssh
# keys 通常以只读卷挂入，chmod 会返回 EROFS；权限由宿主机侧决定。
chmod 700 /opt/platform/keys 2>/dev/null || true

# 授权公钥：优先用挂载的 keys 目录，其次用 SSH_AUTHORIZED_KEY 环境变量。
if [[ -n "${SSH_PUBKEY_FILE:-}" && -f "$SSH_PUBKEY_FILE" ]]; then
  cp "$SSH_PUBKEY_FILE" /root/.ssh/authorized_keys
elif [[ -n "${SSH_AUTHORIZED_KEY:-}" ]]; then
  printf '%s\n' "$SSH_AUTHORIZED_KEY" > /root/.ssh/authorized_keys
fi
chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true

ssh-keygen -A >/dev/null
/usr/sbin/sshd -e

# 每个容器只跑一个实例；配置从环境变量生成，不把宿主机配置带进来。
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
  // PCS 导出的运行时视图（agent_profiles + bindings）；没有它就只有确定性执行器。
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
# 领任务的轮询间隔。控制台/对话的体感延迟主要是「任务入队 → 实例来领」；
# 默认 2 秒是为大规模集群省数据库，单机或几台构建机用 0.5 秒更跟手。
export CLAIM_INTERVAL_SECONDS="${CLAIM_INTERVAL_SECONDS:-0.5}"

cd /opt/platform/host-runtime
exec node --import tsx src/main.ts --instance "$INSTANCE_ID"
