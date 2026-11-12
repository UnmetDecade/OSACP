# platform/builder:<ubuntu version>
#
# Builder = an SSH-accessible Ubuntu container. Root inside the container, writable rootfs, full Capabilities;
# the isolation boundary is the container itself + resource limits + network policy, not privilege reduction inside the container.
#
# The build context is the repository root:
#   docker build -f deploy/builder/Dockerfile --build-arg UBUNTU_VERSION=22.04 -t platform/builder:ubuntu22.04 .

ARG UBUNTU_VERSION=22.04
FROM ubuntu:${UBUNTU_VERSION}

ARG NODE_VERSION=22.20.0
# Agent CLI versions are pinned; the image digest provides traceability; the CLI is only installed in the image and does not inherit host credentials.
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

# Node.js uses the official binary, avoiding dependence on each Ubuntu version's apt source/nodesource support.
RUN arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1

# Claude Code / Codex: the in-container CLI Agents, launched by host-runtime via stdio JSON-RPC.
# Uses npmmirror for speed; versions are pinned in build arguments.
RUN npm install -g --no-fund --no-audit --registry=https://registry.npmmirror.com \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}"

# Full-privilege SSH: root login, public-key authentication only.
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

# By default, point Claude Code at DeepSeek's Anthropic-compatible endpoint; to switch back to the official Anthropic
# endpoint, override ANTHROPIC_BASE_URL in the deployment environment. Keys are not baked into the image.
ENV CODEX_HOME=/opt/platform/codex
ENV ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic

COPY deploy/builder/entrypoint.sh /usr/local/bin/platform-builder-entrypoint

RUN chmod 0755 /usr/local/bin/platform-builder-entrypoint

WORKDIR /opt/platform/host-runtime
EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/platform-builder-entrypoint"]
