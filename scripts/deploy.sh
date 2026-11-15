#!/usr/bin/env bash
# The single deployment path: one machine runs PostgreSQL, PCS and the admin UI.
#
#   scripts/deploy.sh
#
# What it does (idempotent):
#   1. starts a local PostgreSQL container (unless PCS_DATABASE_URL is set);
#   2. generates the PCS signing keys and the SSH credential key;
#   3. installs dependencies, builds the admin app and the deployment payload;
#   4. prepares the host cache (Linux Node + openssh debs) used by containers;
#   5. migrates the database and starts PCS, which serves the UI itself.
#
# Then open http://127.0.0.1:7901, register the first account (administrator),
# add this machine as a host and deploy schedulers/builders from the UI.
#
# Requirements: Node 22+, npm, Docker (for PostgreSQL and the host cache).
# For remote hosts, set PCS_HOST=0.0.0.0 and PCS_RUNTIME_URL=http://<lan-ip>:7901.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PCS_HOST="${PCS_HOST:-127.0.0.1}"
PCS_PORT="${PCS_PORT:-7901}"
PCS_RUNTIME_URL="${PCS_RUNTIME_URL:-http://127.0.0.1:${PCS_PORT}}"
PG_CONTAINER="${PCS_POSTGRES_CONTAINER:-osacp-postgres}"
PG_VOLUME="${PCS_POSTGRES_VOLUME:-osacp-postgres}"
PG_PORT="${PCS_POSTGRES_PORT:-55432}"
PG_PASSWORD_FILE="$ROOT/deploy/.pcs-db-password"
CRED_KEY="$HOME/.config/platform/pcs-credential.key"
NODE_CACHE="$HOME/.platform/cache/node"
NODE_VERSION="${NODE_VERSION:-22.20.0}"
# A pinned Ubuntu is enough for both roles: the app and runtime arrive as payload files.
UBUNTU_DIGEST="${PCS_SCHEDULER_IMAGE:-docker.m.daocloud.io/library/ubuntu@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852}"
IMAGE_ALLOWLIST="${PCS_IMAGE_ALLOWLIST:-docker.m.daocloud.io/library/}"

say() { printf '\n[deploy] %s\n' "$1"; }
die() { printf '\n[deploy] %s\n' "$1" >&2; exit 1; }

# shellcheck source=scripts/lib-env.sh
. "$ROOT/scripts/lib-env.sh"
ensure_node22 || die "Node 22+ is required (set PLATFORM_AUTO_INSTALL=1 on Debian/Ubuntu to install it automatically)"
command -v npm >/dev/null 2>&1 || die "npm is required"
ensure_docker || die "Docker is required for PostgreSQL and containers"
reexec_with_docker_group "$0" "$@"
docker info >/dev/null 2>&1 || die "Docker is installed but not accessible; log out and back in, then rerun"
say "environment ready; deploying to http://${PCS_HOST}:${PCS_PORT}"

# Docker Desktop/colima keep the socket outside /var/run; host-runtime needs the real path.
if [ -z "${PCS_DOCKER_SOCKET:-}" ]; then
  docker_host="$(docker context inspect -f '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
  case "$docker_host" in
    unix://*) PCS_DOCKER_SOCKET="${docker_host#unix://}" ;;
  esac
fi
PCS_DOCKER_SOCKET="${PCS_DOCKER_SOCKET:-/var/run/docker.sock}"
export PCS_DOCKER_SOCKET

# ---------------------------------------------------------------- image registry
# Docker Hub is frequently unreachable from mainland networks; use a mirror for
# the few base images this script pulls directly.
ensure_curl >/dev/null 2>&1 || true
hub_code="$(curl -s -m 6 -o /dev/null -w '%{http_code}' https://registry-1.docker.io/v2/ 2>/dev/null || true)"
if [ "$hub_code" = "000" ]; then
  REGISTRY_PREFIX="docker.m.daocloud.io/library/"
  say "Docker Hub unreachable; pulling base images through docker.m.daocloud.io"
else
  REGISTRY_PREFIX=""
fi
PCS_POSTGRES_IMAGE="${PCS_POSTGRES_IMAGE:-${REGISTRY_PREFIX}postgres:16-alpine}"

# ---------------------------------------------------------------- PostgreSQL
if [ -z "${PCS_DATABASE_URL:-}" ]; then
  command -v docker >/dev/null 2>&1 || die "Docker is required for PostgreSQL, or set PCS_DATABASE_URL"
  if [ ! -f "$PG_PASSWORD_FILE" ]; then
    umask 077
    node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$PG_PASSWORD_FILE"
  fi
  PG_PASSWORD="$(cat "$PG_PASSWORD_FILE")"
  if ! docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    say "starting PostgreSQL ($PG_CONTAINER on 127.0.0.1:$PG_PORT)"
    docker run -d --name "$PG_CONTAINER" --restart unless-stopped \
      -e POSTGRES_DB=platform_control \
      -e POSTGRES_USER=postgres \
      -e POSTGRES_PASSWORD="$PG_PASSWORD" \
      -p "$PG_PORT:5432" \
      -v "$PG_VOLUME:/var/lib/postgresql/data" \
      "$PCS_POSTGRES_IMAGE" >/dev/null
  elif [ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER")" != "true" ]; then
    say "starting the existing PostgreSQL container"
    docker start "$PG_CONTAINER" >/dev/null
  fi
  for _ in $(seq 1 60); do
    if docker exec "$PG_CONTAINER" pg_isready -U postgres -d platform_control >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  docker exec "$PG_CONTAINER" pg_isready -U postgres -d platform_control >/dev/null 2>&1 \
    || die "PostgreSQL did not become ready"
  PCS_DATABASE_URL="postgres://postgres:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/platform_control"
  # Scheduler containers are created by host-runtime on the host's Docker bridge;
  # they reach PostgreSQL through the host's LAN address, not 127.0.0.1.
  LAN_IP="$(node -e 'const os=require("node:os");for(const l of Object.values(os.networkInterfaces()))for(const i of l||[])if(i.family==="IPv4"&&!i.internal){console.log(i.address);process.exit(0)}')"
  LAN_IP="${LAN_IP:-127.0.0.1}"
  # Scheduler containers reach host-published ports through a container-visible
  # address; on macOS that is the Docker bridge gateway, not the host LAN IP.
  if [ "$(uname -s)" = "Darwin" ]; then
    CONTAINER_HOST_IP="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
    CONTAINER_HOST_IP="${CONTAINER_HOST_IP:-172.17.0.1}"
  else
    CONTAINER_HOST_IP="$LAN_IP"
  fi
  PCS_SCHEDULER_DATABASE_URL="postgres://postgres:${PG_PASSWORD}@${CONTAINER_HOST_IP}:${PG_PORT}/scheduler"
  export PCS_SCHEDULER_DATABASE_URL
fi
export PCS_DATABASE_URL

if [ -z "${PCS_SCHEDULER_DATABASE_URL:-}" ]; then
  say "set PCS_SCHEDULER_DATABASE_URL so scheduler containers can reach PostgreSQL"
fi

# ---------------------------------------------------------------- keys
mkdir -p "$ROOT/pcs-issuer/keys" "$(dirname "$CRED_KEY")"
if [ ! -f "$ROOT/pcs-issuer/keys/private.pem" ] || [ ! -f "$ROOT/pcs-issuer/keys/command-private.pem" ]; then
  say "generating PCS signing keys"
  (cd pcs-issuer && npm run --silent keygen)
fi
if [ ! -f "$CRED_KEY" ]; then
  say "generating the SSH credential key"
  umask 077
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -out "$CRED_KEY" 32
  else
    node -e 'require("node:fs").writeFileSync(process.argv[1], require("node:crypto").randomBytes(32), { mode: 0o600 })' "$CRED_KEY"
  fi
fi
chmod 600 "$CRED_KEY"

# ---------------------------------------------------------------- build
if [ ! -d "$ROOT/pcs-issuer/node_modules" ]; then
  say "installing PCS dependencies"
  (cd pcs-issuer && npm ci --no-audit --no-fund)
fi
if [ ! -d "$ROOT/admin-app/node_modules" ]; then
  say "installing admin app dependencies"
  (cd admin-app && npm ci --no-audit --no-fund)
fi
# The payload bundles the scheduler and host-runtime sources; `pg` and the other
# scheduler dependencies must be present for esbuild to resolve them.
if [ ! -d "$ROOT/scheduler/node_modules" ]; then
  say "installing scheduler dependencies (needed to bundle the payload)"
  (cd scheduler && npm ci --no-audit --no-fund)
fi
if [ ! -d "$ROOT/host-runtime/node_modules" ]; then
  say "installing host-runtime dependencies"
  (cd host-runtime && npm ci --no-audit --no-fund)
fi
say "building the admin app"
(cd admin-app && npm run --silent build)
say "building the deployment payload"
node scripts/build-app-payload.mjs

# ---------------------------------------------------------------- host cache
mkdir -p "$HOME/.platform/cache/agents" "$HOME/.platform/cache/openssh"
if [ ! -x "$NODE_CACHE/bin/node" ]; then
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) node_arch=x64 ;;
    arm64|aarch64) node_arch=arm64 ;;
    *) die "unsupported host architecture for the Node cache: $arch" ;;
  esac
  tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  tmp="$(mktemp -d)"
  say "downloading Node ${NODE_VERSION} for the host cache"
  if ! curl -fL --progress-bar "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}" -o "$tmp/$tarball"; then
    curl -fL --progress-bar "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${tarball}" -o "$tmp/$tarball" \
      || die "could not download $tarball"
  fi
  tar -xJf "$tmp/$tarball" -C "$tmp"
  mkdir -p "$NODE_CACHE"
  cp -a "$tmp/node-v${NODE_VERSION}-linux-${node_arch}/." "$NODE_CACHE/"
  rm -rf "$tmp"
fi
if ! compgen -G "$HOME/.platform/cache/openssh/*.deb" >/dev/null; then
  say "downloading openssh packages for the host cache"
  docker run --rm -v "$HOME/.platform/cache/openssh:/out" "${REGISTRY_PREFIX}ubuntu:24.04" bash -c \
    'apt-get update -qq && apt-get install -y -qq --download-only --no-install-recommends openssh-server >/dev/null && cp /var/cache/apt/archives/*.deb /out/' \
    || die "could not download the openssh packages"
fi
if [ "$(uname -s)" = "Linux" ]; then
  # On Linux the host CLI binary runs unchanged inside the containers.
  for cli in claude codex; do
    if command -v "$cli" >/dev/null 2>&1 && [ ! -x "$HOME/.platform/cache/agents/$cli" ]; then
      cp "$(command -v "$cli")" "$HOME/.platform/cache/agents/$cli"
      chmod 755 "$HOME/.platform/cache/agents/$cli"
    fi
  done
else
  # macOS host CLIs are Mach-O binaries and cannot run in the Linux builders.
  # Install a Linux Claude Code build into the cache once.
  AGENT_CLI_VERSION="${AGENT_CLI_VERSION:-2.1.322}"
  if [ ! -x "$HOME/.platform/cache/agents/claude" ] || file "$HOME/.platform/cache/agents/claude" 2>/dev/null | grep -q 'Mach-O'; then
    say "installing a Linux Claude Code ${AGENT_CLI_VERSION} build into the host cache"
    docker run --rm -v "$HOME/.platform/cache:/cache" node:22-bookworm-slim sh -c "
      set -e
      rm -f /cache/agents/claude
      npm i -g --no-fund --no-audit --registry=https://registry.npmmirror.com --prefix /cache/agents @anthropic-ai/claude-code@${AGENT_CLI_VERSION} >/dev/null
      printf '#!/bin/sh\nexec /opt/platform/cache/agents/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe \"\$@\"\n' > /cache/agents/claude
      chmod 755 /cache/agents/claude" \
      || die "could not install the Linux Claude Code build into the host cache"
  fi
fi

# ---------------------------------------------------------------- migrate and start
say "migrating the database"
(cd pcs-issuer && node --import tsx src/migrate.ts)

export PCS_HOST PCS_PORT PCS_RUNTIME_URL
export PCS_CREDENTIAL_KEY_FILE="$CRED_KEY"
export PCS_WEB_DIR="$ROOT/admin-app/dist"
export PCS_SCHEDULER_APP_DIR="$ROOT/deploy/scheduler/app"
export PCS_BUILDER_APP_DIR="$ROOT/deploy/builder/app"
export PCS_IMAGE_ALLOWLIST="$IMAGE_ALLOWLIST"
export PCS_SCHEDULER_IMAGE="$UBUNTU_DIGEST"

cat <<EOF

[deploy] ready

  Admin app / API   http://${PCS_HOST}:${PCS_PORT}
  Database          PostgreSQL on 127.0.0.1:${PG_PORT} (container ${PG_CONTAINER})
  Host cache        ~/.platform/cache

Next steps:
  1. Open the URL and register the first account — it becomes the administrator.
  2. Add this machine as a local host, start its runtime.
  3. Deploy a scheduler, then builders, from the UI.

PCS runs in the foreground; Ctrl+C stops it. The PostgreSQL container keeps
running: stop it with "docker stop ${PG_CONTAINER}" (add "docker rm ${PG_CONTAINER}" to remove it).
For remote hosts, run with PCS_HOST=0.0.0.0 and PCS_RUNTIME_URL=http://<lan-ip>:${PCS_PORT}.
EOF

exec npm --prefix pcs-issuer run start
