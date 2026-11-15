#!/usr/bin/env bash
# Shared environment bootstrap for scripts/deploy.sh and scripts/demo.sh.
#
# Installs missing prerequisites when possible:
#   - Debian/Ubuntu: apt (Node 22, Docker, Compose v2)
#   - Fedora/RHEL:   dnf (Docker); Node comes from the official tarball
#   - macOS:         Homebrew (Node; colima + docker when no Docker Desktop)
#   - other Linux:   Node 22 from the official tarball; Docker must be preinstalled
#
# Set PLATFORM_AUTO_INSTALL=0 to disable all system package installation.

AUTO_INSTALL="${PLATFORM_AUTO_INSTALL:-1}"
DOCKER_GROUP_ADDED=0
PLATFORM_OS="$(uname -s)"

_sudo() {
  if [ "$(id -u)" = "0" ]; then "$@"; else sudo "$@"; fi
}

# apt | dnf | brew | none
pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v brew >/dev/null 2>&1; then echo brew
  else echo none
  fi
}

_pkg_install() {
  echo "[env] installing: $* (this can take a few minutes)" >&2
  case "$(pkg_manager)" in
    apt)
      _sudo apt-get update -qq
      _sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
      ;;
    dnf)
      _sudo dnf install -y "$@"
      ;;
    brew)
      brew install "$@"
      ;;
    *)
      echo "[env] no supported package manager (apt/dnf/brew); install manually: $*" >&2
      return 1
      ;;
  esac
}

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    echo "[env] curl found: $(curl --version | head -1)" >&2
    return 0
  fi
  [ "$AUTO_INSTALL" = "1" ] || return 1
  case "$(pkg_manager)" in
    apt) _pkg_install curl ca-certificates ;;
    dnf|brew) _pkg_install curl ;;
    *) return 1 ;;
  esac
  echo "[env] curl installed" >&2
}

# Install a Node build from the official tarball (any Linux distribution).
_install_node_tarball() {
  local version="${NODE_INSTALL_VERSION:-22.20.0}"
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "[env] unsupported architecture for Node: $(uname -m)" >&2; return 1 ;;
  esac
  local tarball="node-v${version}-linux-${arch}.tar.xz"
  local tmp
  tmp="$(mktemp -d)"
  echo "[env] downloading Node ${version} (linux-${arch})" >&2
  # npmmirror first: it is reachable from mainland networks where NodeSource often is not.
  echo "[env]   https://npmmirror.com/mirrors/node/v${version}/${tarball}" >&2
  if ! curl -fL --progress-bar "https://npmmirror.com/mirrors/node/v${version}/${tarball}" -o "$tmp/$tarball"; then
    echo "[env]   mirror failed; trying https://nodejs.org" >&2
    curl -fL --progress-bar "https://nodejs.org/dist/v${version}/${tarball}" -o "$tmp/$tarball" || {
      rm -rf "$tmp"
      echo "[env] could not download ${tarball}" >&2
      return 1
    }
  fi
  echo "[env] extracting Node into /usr/local (sudo)" >&2
  _sudo tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 || {
    rm -rf "$tmp"
    return 1
  }
  rm -rf "$tmp"
  hash -r 2>/dev/null || true
  command -v node >/dev/null 2>&1
}

ensure_node22() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge 22 ]; then
      echo "[env] Node $(node -v) found; nothing to install" >&2
      return 0
    fi
    echo "[env] Node $(node -v) is too old (need 22+)" >&2
  else
    echo "[env] Node not found" >&2
  fi
  if [ "$AUTO_INSTALL" != "1" ]; then
    echo "[env] Node 22+ is required; install it manually" >&2
    return 1
  fi
  ensure_curl || return 1
  if [ "$PLATFORM_OS" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      echo "[env] installing Node with Homebrew" >&2
      brew install node || return 1
      hash -r 2>/dev/null || true
    else
      echo "[env] Node 22+ is required; install Homebrew (https://brew.sh) or Node manually" >&2
      return 1
    fi
  else
    _install_node_tarball || return 1
  fi
  echo "[env] Node installed: $(node -v 2>/dev/null || echo 'not found')" >&2
  command -v node >/dev/null 2>&1
}

_install_docker_linux() {
  local want_compose="$1"
  case "$(pkg_manager)" in
    apt)
      local packages=(docker.io)
      [ "$want_compose" = "1" ] && packages+=(docker-compose-v2)
      _pkg_install "${packages[@]}"
      ;;
    dnf)
      # Fedora ships Docker in the main repositories; the Compose v2 plugin may
      # come from the Docker CE repository instead.
      local packages=(docker)
      [ "$want_compose" = "1" ] && packages+=(docker-compose)
      _pkg_install "${packages[@]}" || {
        echo "[env] could not install Docker from dnf; install Docker CE and the compose plugin manually" >&2
        return 1
      }
      if [ "$want_compose" = "1" ] && ! docker compose version >/dev/null 2>&1; then
        _pkg_install docker-compose-plugin >/dev/null 2>&1 || true
      fi
      ;;
    *)
      echo "[env] Docker is required; install it manually for this distribution" >&2
      return 1
      ;;
  esac
  command -v systemctl >/dev/null 2>&1 && _sudo systemctl enable --now docker >/dev/null 2>&1 || true
}

_install_docker_macos() {
  echo "[env] Docker not found on macOS" >&2
  if [ -d "/Applications/Docker.app" ]; then
    echo "[env] starting Docker Desktop" >&2
    open -a Docker >/dev/null 2>&1 || true
    local _
    for _ in $(seq 1 60); do
      docker info >/dev/null 2>&1 && return 0
      sleep 1
    done
  fi
  if command -v brew >/dev/null 2>&1; then
    echo "[env] installing colima + docker with Homebrew (first start downloads a VM image)" >&2
    brew install colima docker docker-compose || return 1
    colima start || return 1
    return 0
  fi
  echo "[env] install Docker Desktop or colima (brew install colima docker) manually" >&2
  return 1
}

# ensure_docker [1] — the optional argument also ensures the Compose v2 plugin.
ensure_docker() {
  local want_compose="${1:-0}"
  if command -v docker >/dev/null 2>&1; then
    echo "[env] Docker found: $(docker --version 2>/dev/null || echo unknown)" >&2
  else
    if [ "$AUTO_INSTALL" != "1" ]; then
      echo "[env] Docker is required; install it manually" >&2
      return 1
    fi
    if [ "$PLATFORM_OS" = "Darwin" ]; then
      _install_docker_macos || return 1
    else
      _install_docker_linux "$want_compose" || return 1
    fi
    echo "[env] Docker installed: $(docker --version 2>/dev/null || echo unknown)" >&2
  fi
  if [ "$want_compose" = "1" ] && ! docker compose version >/dev/null 2>&1; then
    if [ "$AUTO_INSTALL" = "1" ]; then
      echo "[env] Docker Compose plugin not found; trying to install it" >&2
      case "$(pkg_manager)" in
        apt) _pkg_install docker-compose-v2 || true ;;
        dnf) _pkg_install docker-compose-plugin >/dev/null 2>&1 || _pkg_install docker-compose >/dev/null 2>&1 || true ;;
        brew) brew install docker-compose >/dev/null 2>&1 || true ;;
        *) : ;;
      esac
    fi
  fi
  command -v docker >/dev/null 2>&1 || return 1
  if ! docker info >/dev/null 2>&1; then
    echo "[env] Docker daemon is not reachable yet; trying to start it" >&2
    if [ "$PLATFORM_OS" = "Darwin" ]; then
      if [ -d "/Applications/Docker.app" ]; then
        open -a Docker >/dev/null 2>&1 || true
      elif command -v colima >/dev/null 2>&1; then
        colima start >/dev/null 2>&1 || true
      fi
    else
      command -v systemctl >/dev/null 2>&1 && _sudo systemctl enable --now docker >/dev/null 2>&1 || true
    fi
    # Give a just-started daemon a moment before assuming this is a permission issue.
    local _
    for _ in $(seq 1 30); do
      docker info >/dev/null 2>&1 && break
      sleep 1
    done
    # The docker group only exists on Linux; macOS uses a VM socket instead.
    if [ "$PLATFORM_OS" != "Darwin" ] && ! docker info >/dev/null 2>&1; then
      echo "[env] current user is not in the docker group; adding it now" >&2
      _sudo groupadd -f docker 2>/dev/null || true
      _sudo usermod -aG docker "${USER:-$(id -un)}" 2>/dev/null || true
      DOCKER_GROUP_ADDED=1
    fi
  fi
  echo "[env] Docker is ready" >&2
  return 0
}

# Re-run the current script inside a shell that already has the new docker group.
reexec_with_docker_group() {
  local script="$1"
  shift
  [ "$PLATFORM_OS" = "Linux" ] || return 0
  [ "${PLATFORM_IN_DOCKER_GROUP:-0}" = "1" ] && return 0
  [ "${DOCKER_GROUP_ADDED:-0}" = "1" ] || return 0
  command -v sg >/dev/null 2>&1 || return 0
  local quoted
  quoted="$(printf '%q ' "$script" "$@")"
  echo "[env] re-running with the docker group" >&2
  exec sg docker -c "PLATFORM_IN_DOCKER_GROUP=1 $quoted"
}
