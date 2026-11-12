#!/usr/bin/env bash
# 调度机容器入口（纯 OS 镜像版）。
#
# 镜像是官方 ubuntu，部署时只带这些文件：应用 bundle（/opt/platform/app）、
# Agent Profile（/opt/platform/profiles.json）。Node、Agent CLI、openssh deb
# 都在主机缓存里（只读挂到 /opt/platform/cache），容器里不烘焙运行时。
set -euo pipefail

CACHE="${PLATFORM_CACHE_DIR:-/opt/platform/cache}"
APP="${SCHEDULER_APP_DIR:-/opt/platform/app}"

NODE="$CACHE/node/bin/node"
if [[ ! -x "$NODE" ]]; then
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" ]]; then
  echo "主机缓存里没有 Node：$CACHE/node/bin/node；请在主机 ~/.platform/cache/node 放一份 Node 22" >&2
  exit 1
fi
# Agent CLI（claude / codex）按需放在缓存目录，调度机里的 cli-agent 从 PATH 找它们。
export PATH="$CACHE/node/bin:$CACHE/agents:${PATH}"
# 让 docker exec / ssh 进来的 shell 也能直接用 node、claude，不用记缓存路径。
for b in node npm npx; do
  [[ -x "$CACHE/node/bin/$b" ]] && ln -sf "$CACHE/node/bin/$b" /usr/local/bin/$b
done
for b in claude codex; do
  [[ -x "$CACHE/agents/$b" ]] && ln -sf "$CACHE/agents/$b" /usr/local/bin/$b
done

: "${DATABASE_URL:?缺少 DATABASE_URL}"

SCHEDULER_INSTANCE_ID="${SCHEDULER_INSTANCE_ID:-scheduler}"
SCHEDULER_AGENT_PROFILE_ID="${SCHEDULER_AGENT_PROFILE_ID:-agp_scheduler}"
SCHEDULER_HOST_ID="${SCHEDULER_HOST_ID:-docker-host-01}"
PORT="${PORT:-8443}"

# 调度机 Agent 的构建机工具（MCP stdio）：工具通过本机调度 API 下发任务，
# 端口按实际监听写进配置，不写死。
cat > "$APP/mcp.json" <<JSON
{"mcpServers":{"builders":{"command":"$NODE","args":["$APP/tools.mjs"],"env":{"SCHEDULER_URL":"http://127.0.0.1:${PORT}"}}}}
JSON
# 单个工具调用可能要跑几分钟（apt 安装 / 编译），默认给 10 分钟。
export MCP_TIMEOUT="${MCP_TIMEOUT:-30000}"
export MCP_TOOL_TIMEOUT="${MCP_TOOL_TIMEOUT:-600000}"

mkdir -p /root/.ssh /run/sshd \
  /opt/platform/{artifacts,keys,logs,audit,tokens,workspace/scheduler}
chmod 700 /root/.ssh
# keys 通常以只读卷挂入，chmod 会返回 EROFS；权限由宿主机侧决定。
chmod 700 /opt/platform/keys 2>/dev/null || true

# 纯 ubuntu 镜像没有 ssh/sshd：从主机缓存的 deb 离线安装，只装一次。
if ! command -v sshd >/dev/null || ! command -v ssh >/dev/null; then
  if compgen -G "$CACHE/openssh/*.deb" >/dev/null; then
    DEBIAN_FRONTEND=noninteractive dpkg -i "$CACHE"/openssh/*.deb
  else
    echo "缺少 ssh/sshd，且主机缓存里没有 $CACHE/openssh/*.deb" >&2
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
    echo "数据库迁移失败：60 秒内无法连接或迁移未通过" >&2
    exit 1
  fi
  echo "等待数据库就绪（$i/60）..."
  sleep 2
done

if [[ "${SEED:-0}" == "1" ]]; then
  "$NODE" migrate.mjs --seed
fi

# 调度机服务在后台运行；同时起一个 host-runtime 实例跑
# task.chat.scheduler / task.console.scheduler，让「派令」能对话和排障。
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
    echo "调度机进程提前退出" >&2
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
# 同构建机：小规模平台用更短的领任务轮询，换取交互时延。
export CLAIM_INTERVAL_SECONDS="${CLAIM_INTERVAL_SECONDS:-0.5}"

start_agent() {
  ( exec "$NODE" "$APP/agent-runtime.mjs" --instance "$SCHEDULER_INSTANCE_ID" )
}
start_agent &
AGENT_PID=$!

while kill -0 "$SCHED_PID" 2>/dev/null; do
  if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    wait "$AGENT_PID" 2>/dev/null || true
    echo "[scheduler-agent] 退出，2 秒后重启" >&2
    sleep 2
    start_agent &
    AGENT_PID=$!
  fi
  sleep 2
done

wait "$SCHED_PID"
exit $?
