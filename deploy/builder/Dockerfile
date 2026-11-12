# platform/builder:<ubuntu version>
#
# 构建机 = 可 SSH 的 Ubuntu 容器。容器内 root、可写根、完整 Capability，
# 隔离边界是容器本身 + 资源限额 + 网络策略，而不是容器内的权限收缩。
#
# 构建上下文是仓库根目录：
#   docker build -f deploy/builder/Dockerfile --build-arg UBUNTU_VERSION=22.04 -t platform/builder:ubuntu22.04 .

ARG UBUNTU_VERSION=22.04
FROM ubuntu:${UBUNTU_VERSION}

ARG NODE_VERSION=22.20.0
# Agent CLI 版本固定，镜像 digest 负责可追溯；CLI 只装在镜像里，不继承宿主凭据。
ARG CLAUDE_CODE_VERSION=2.1.322
ARG CODEX_VERSION=0.167.1
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server sudo ca-certificates curl git xz-utils jq \
      bash build-essential cmake ninja-build pkg-config \
      python3 python3-pip python3-venv \
      procps less vim-tiny \
 && rm -rf /var/lib/apt/lists/*

# Node.js 用官方二进制，避免依赖各 Ubuntu 版本的 apt 源/nodesource 支持情况。
RUN arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1

# Claude Code / Codex：容器内的 CLI Agent，由 host-runtime 通过 stdio JSON-RPC 拉起。
# 使用 npmmirror 加速；版本在构建参数里固定。
RUN npm install -g --no-fund --no-audit --registry=https://registry.npmmirror.com \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}"

# 完整权限 SSH：root 登录，仅公钥认证。
COPY deploy/builder/sshd_config /etc/ssh/sshd_config.d/00-platform.conf

RUN mkdir -p /opt/platform/host-runtime /opt/platform/workspace /opt/platform/artifacts \
             /opt/platform/logs /opt/platform/tokens /opt/platform/keys /root/.ssh \
 && chmod 700 /root/.ssh /opt/platform/keys \
 && ssh-keygen -A

COPY host-runtime/package.json host-runtime/package-lock.json /opt/platform/host-runtime/
RUN cd /opt/platform/host-runtime && npm ci

COPY host-runtime /opt/platform/host-runtime
COPY agents /opt/platform/agents
COPY deploy/codex/config.toml /opt/platform/codex/config.toml

# 默认把 Claude Code 指向 DeepSeek 的 Anthropic 兼容端点；换回官方 Anthropic
# 时在部署环境里覆盖 ANTHROPIC_BASE_URL 即可。密钥不烘焙进镜像。
ENV CODEX_HOME=/opt/platform/codex
ENV ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic

COPY deploy/builder/entrypoint.sh /usr/local/bin/platform-builder-entrypoint

RUN chmod 0755 /usr/local/bin/platform-builder-entrypoint

WORKDIR /opt/platform/host-runtime
EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/platform-builder-entrypoint"]
