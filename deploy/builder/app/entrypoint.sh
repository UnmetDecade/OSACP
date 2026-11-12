#!/usr/bin/env bash
# 构建机容器入口（纯 OS 镜像版）。
#
# 镜像是官方 ubuntu，部署时只带这些文件：实例运行时（/opt/platform/app）、
# Agent 适配器（/opt/platform/agents）、sshd 配置。Node、Agent CLI、openssh deb
# 都在主机缓存里（只读挂到 /opt/platform/cache），容器里不烘焙运行时和工具链。
set -euo pipefail

CACHE="${PLATFORM_CACHE_DIR:-/opt/platform/cache}"
APP="${BUILDER_APP_DIR:-/opt/platform/app}"

NODE="$CACHE/node/bin/node"
if [[ ! -x "$NODE" ]]; then
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" ]]; then
  echo "主机缓存里没有 Node：$CACHE/node/bin/node；请在主机 ~/.platform/cache/node 放一份 Node 22" >&2
  exit 1
fi
# Agent CLI（claude / codex）按需放在缓存目录，实例运行时从 PATH 找它们。
export PATH="$CACHE/node/bin:$CACHE/agents:${PATH}"
# 让 docker exec / ssh 进来的 shell 也能直接用 node、claude，不用记缓存路径。
for b in node npm npx; do
  [[ -x "$CACHE/node/bin/$b" ]] && ln -sf "$CACHE/node/bin/$b" /usr/local/bin/$b
done
for b in claude codex; do
  [[ -x "$CACHE/agents/$b" ]] && ln -sf "$CACHE/agents/$b" /usr/local/bin/$b
done

: "${SCHEDULER_URL:?缺少 SCHEDULER_URL}"
: "${INSTANCE_ID:?缺少 INSTANCE_ID}"
ROLE_ID="${ROLE_ID:-builder}"
HOST_ID="${HOST_ID:-docker-host-01}"
AGENT_PROFILE_ID="${AGENT_PROFILE_ID:-agp_builder}"
BUILDER_OS="${BUILDER_OS:-ubuntu24.04}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/opt/platform/workspace}"

mkdir -p /root/.ssh /run/sshd "$WORKSPACE_DIR" \
  /opt/platform/{artifacts,logs,tokens,keys,audit,codex}
chmod 700 /root/.ssh
# keys 通常以只读卷挂入，chmod 会返回 EROFS；权限由宿主机侧决定。
chmod 700 /opt/platform/keys 2>/dev/null || true

# 纯 ubuntu 镜像没有 ssh/sshd：从主机缓存的 deb 离线安装（缓存需与镜像同版本）。
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
# 授权公钥：优先用挂载的 keys 目录，其次用 SSH_PUBKEY_FILE / SSH_AUTHORIZED_KEY。
if [[ -n "${SSH_PUBKEY_FILE:-}" && -f "$SSH_PUBKEY_FILE" ]]; then
  cp "$SSH_PUBKEY_FILE" /root/.ssh/authorized_keys
elif [[ -n "${SSH_AUTHORIZED_KEY:-}" ]]; then
  printf '%s\n' "$SSH_AUTHORIZED_KEY" > /root/.ssh/authorized_keys
fi
chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true

ssh-keygen -A >/dev/null
/usr/sbin/sshd -e

# ---- 已装软件包持久化 ----
# 构建机是一次性容器，但装过的环境不该每次重新部署就消失：
#   * state 卷按实例隔离（platform-<实例>-state），只记录本实例的包清单；
#   * /var/cache/apt/archives 挂同一主机的共享卷（shared-apt-cache），
#     只复用下载过的 deb，不会把别的构建机的包装进当前环境。
STATE_DIR="${STATE_DIR:-/opt/platform/state}"
mkdir -p "$STATE_DIR"
APT_SNAPSHOT="$STATE_DIR/dpkg-packages.txt"

# 官方镜像默认装完就删 deb（docker-clean）；把下载目录放到共享卷并保留 deb，
# 同主机的其他构建机可直接复用，不会重复下载（卷只放包文件，不进环境）。
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
  echo "[builder] 恢复已装软件包：$(printf '%s\n' "$names" | wc -w) 个" >&2
  # 先按原版本从共享缓存装；缓存不全再联网补，最后才退化成按包名装最新版。
  if ! apt-get install -y -o Dpkg::Options::=--force-confold --no-download $missing >/dev/null 2>&1; then
    if getent hosts archive.ubuntu.com >/dev/null 2>&1; then
      apt-get update -qq >/dev/null 2>&1 || true
      apt-get install -y -o Dpkg::Options::=--force-confold $missing >/dev/null 2>&1 \
        || apt-get install -y -o Dpkg::Options::=--force-confold $names >/dev/null 2>&1 \
        || echo "[builder] 部分软件包恢复失败，构建机可稍后自行补装" >&2
    fi
  fi
  echo "[builder] 软件包恢复完成" >&2
}

apt_watch() {
  # 安装通常几秒到几分钟；30 秒一次的清单快照足以覆盖，停机时再补一次。
  trap 'apt_snapshot; exit 0' TERM INT
  while true; do
    sleep 30
    apt_snapshot || true
  done
}

apt_restore || true
apt_snapshot || true
apt_watch &

# 每个容器只跑一个实例；配置从环境变量生成，不把宿主机配置带进来。
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
  // PCS 导出的运行时视图（agent_profiles + bindings）；没有它就只有确定性执行器。
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
# Codex 配置随部署载荷下发到 /opt/platform/codex；密钥仍只在运行时注入。
export CODEX_HOME="${CODEX_HOME:-/opt/platform/codex}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.deepseek.com/anthropic}"
# 领任务的轮询间隔：小平台用 0.5 秒，机器多时调回 1–2 秒省数据库。
export CLAIM_INTERVAL_SECONDS="${CLAIM_INTERVAL_SECONDS:-0.5}"

cd "$APP"
exec "$NODE" "$APP/agent-runtime.mjs" --instance "$INSTANCE_ID"
