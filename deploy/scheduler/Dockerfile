# platform/scheduler:4.0
#
# The scheduler is also a container: root + full-privilege SSH, so it can be debugged from inside the container.
# The control plane itself is stateless; all state is in PostgreSQL.
#
# The build context is the repository root:
#   docker build -f deploy/scheduler/Dockerfile -t platform/scheduler:4.0 .

FROM ubuntu:24.04

ARG NODE_VERSION=22.20.0
ARG CLAUDE_CODE_VERSION=2.1.322
ARG CODEX_VERSION=0.167.1
# For networks in mainland China, use --build-arg APT_MIRROR=http://mirrors.aliyun.com/ubuntu
ARG APT_MIRROR=
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

RUN if [ -n "$APT_MIRROR" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do \
        [ -f "$f" ] && sed -i "s|http://archive.ubuntu.com/ubuntu|$APT_MIRROR|g; s|http://security.ubuntu.com/ubuntu|$APT_MIRROR|g" "$f"; \
      done; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server ca-certificates curl git xz-utils jq \
      postgresql-client procps less \
 && rm -rf /var/lib/apt/lists/*

RUN arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1

# Agent CLI on the scheduler: when an Agent Profile is bound, task.chat.scheduler
# launches Claude Code / Codex via stdio JSON-RPC through host-runtime.
RUN npm install -g --no-fund --no-audit --registry=https://registry.npmmirror.com \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}"

COPY deploy/scheduler/sshd_config /etc/ssh/sshd_config.d/00-platform.conf

RUN mkdir -p /opt/platform/scheduler /opt/platform/artifacts /opt/platform/keys /root/.ssh \
 && chmod 700 /root/.ssh /opt/platform/keys \
 && ssh-keygen -A

COPY scheduler/package.json scheduler/package-lock.json /opt/platform/scheduler/
RUN cd /opt/platform/scheduler && npm ci

COPY scheduler /opt/platform/scheduler

# The scheduler also runs its own host-runtime instance: it handles task.chat.scheduler / task.console.scheduler,
# allowing the scheduler bot ("Relay") to chat and troubleshoot. It does not touch the Docker Socket and does not manage builder containers.
COPY host-runtime/package.json host-runtime/package-lock.json /opt/platform/host-runtime/
RUN cd /opt/platform/host-runtime && npm ci
COPY host-runtime /opt/platform/host-runtime
COPY agents /opt/platform/agents
COPY deploy/codex/config.toml /opt/platform/codex/config.toml

ENV CODEX_HOME=/opt/platform/codex
ENV ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic

COPY deploy/scheduler/entrypoint.sh /usr/local/bin/platform-scheduler-entrypoint
RUN chmod 0755 /usr/local/bin/platform-scheduler-entrypoint

WORKDIR /opt/platform/scheduler
EXPOSE 8443 22
ENTRYPOINT ["/usr/local/bin/platform-scheduler-entrypoint"]
