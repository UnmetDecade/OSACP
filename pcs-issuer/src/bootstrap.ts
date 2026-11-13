import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * SSH bootstrap / local bootstrap: installs host-runtime on a host and starts it.
 *
 * Bootstrap only writes platform-owned files and never overwrites the user's home directory; each host gets its own
 * directory ($HOME/.platform/host-runtime/<host_id>), and re-bootstrapping only restarts the processes in that directory.
 * The script runs over SSH stdin or a local sh; the token and PEM are embedded as base64 to avoid quote injection.
 */
export type BootstrapPlan = {
  hostId: string;
  nodePath: string;
  pcsUrl: string;
  enrollmentToken: string;
  commandPublicKey: string;
  imageAllowlist: string[];
  networkPolicies: string[];
  /** Map of policy name to Docker network name; when unset, default falls back to bridge. */
  networkPolicyMap: Record<string, string>;
  runtimeBundle: { runtime: string; watchdog: string };
  /**
   * Host-local credential file contents (KEY=VALUE). When present, written to $HOME/.config/platform/agent-env
   * and set to 600; deployment commands reference only variable names, and the host fills in the values.
   */
  agentEnvContent?: string;
  /** Source of the credential file, logged for troubleshooting (without the contents). */
  agentEnvSource?: string;
  /**
   * Whether Docker is required. Container hosts must set this to true; bare-metal builders/schedulers run the role
   * process directly on the host and can start host-runtime without Docker.
   */
  dockerRequired?: boolean;
};

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64");
const readFile = (file: string) => fs.readFileSync(file);

export function buildBootstrapScript(p: BootstrapPlan): string {
  const dir = `$HOME/.platform/host-runtime/${p.hostId}`;
  // Use relative paths in the config: the start script cds into DIR, avoiding writing the literal $HOME into JSON.
  const config = {
    pcs_url: p.pcsUrl,
    identity_dir: "run/identity",
    state_dir: "run/state",
    command_public_key_file: "command-public.pem",
    image_allowlist: p.imageAllowlist,
    network_policies: Object.fromEntries(
      p.networkPolicies.map((name) => [
        name,
        p.networkPolicyMap[name] ?? (name === "default" ? "bridge" : name),
      ]),
    ),
    docker_socket: "/var/run/docker.sock",
    admission_socket: "run/runtime.sock",
  };
  return [
    "set -eu",
    "umask 077",
    `DIR="${dir}"`,
    'mkdir -p "$DIR/run/identity" "$DIR/run/state" "$DIR/logs"',
    `printf %s '${b64(readFile(p.runtimeBundle.runtime))}' | base64 -d > "$DIR/runtime.mjs"`,
    `printf %s '${b64(readFile(p.runtimeBundle.watchdog))}' | base64 -d > "$DIR/watchdog.mjs"`,
    `printf %s '${b64(JSON.stringify(config))}' | base64 -d > "$DIR/runtime.host.json"`,
    `printf %s '${b64(p.commandPublicKey)}' | base64 -d > "$DIR/command-public.pem"`,
    // Model credentials land only on the host locally (600); deployment commands carry only variable names.
    ...(p.agentEnvContent
      ? [
          'mkdir -p "$HOME/.config/platform"',
          `printf %s '${b64(p.agentEnvContent)}' | base64 -d > "$HOME/.config/platform/agent-env"`,
          'chmod 600 "$HOME/.config/platform/agent-env"',
        ]
      : []),
    // Stop the old processes first, so one identity never runs two daemons.
    // The pid files may have been overwritten by a manual restart script, so also sweep by this directory's path.
    'for f in runtime.pid watchdog.pid; do',
    '  if [ -f "$DIR/$f" ]; then kill "$(cat "$DIR/$f")" 2>/dev/null || true; fi',
    "done",
    'for pid in $(pgrep -f "$DIR/(watchdog|runtime)\\.mjs" || true); do kill "$pid" 2>/dev/null || true; done',
    "sleep 0.3",
    `NODE="${p.nodePath}"`,
    'command -v "$NODE" >/dev/null 2>&1 || { echo "BOOTSTRAP_ERROR Node not found on the target host (current: $NODE): install Node 22+ and point PCS_RUNTIME_NODE at its absolute path" >&2; exit 20; }',
    '"$NODE" -e \'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)\' \\',
    '  || { echo "BOOTSTRAP_ERROR the target host has Node older than 22 (current: $("$NODE" -v 2>/dev/null)); point PCS_RUNTIME_NODE at Node 22+" >&2; exit 21; }',
    // Bare-metal roles do not need Docker; container hosts are still checked, to avoid failing only at deploy time.
    ...(p.dockerRequired === false
      ? []
      : [
          'docker info >/dev/null 2>&1 \\',
          '  || { echo "BOOTSTRAP_ERROR Docker is not available on the target host: install Docker Engine and make /var/run/docker.sock accessible to the current user" >&2; exit 22; }',
        ]),
    "cd \"$DIR\"",
    'nohup "$NODE" "$DIR/watchdog.mjs" --config "$DIR/runtime.host.json" \\',
    '  >> "$DIR/logs/watchdog.log" 2>&1 < /dev/null &',
    'echo $! > "$DIR/watchdog.pid"',
    `nohup env PCS_ENROLLMENT_TOKEN='${p.enrollmentToken}' PCS_URL='${p.pcsUrl}' "$NODE" "$DIR/runtime.mjs" \\`,
    '  --config "$DIR/runtime.host.json" >> "$DIR/logs/runtime.log" 2>&1 < /dev/null &',
    'echo $! > "$DIR/runtime.pid"',
    'echo "BOOTSTRAP_OK pid=$(cat "$DIR/runtime.pid")"',
  ].join("\n");
}

const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Remote environment setup: installs Node 22 and Docker as needed, then returns a usable Node path.
 *
 * - Node is installed under `$HOME/opt` (no sudo needed), matching the nodePath convention in the bootstrap script.
 * - Docker comes from the system docker.io package; this step needs root. When the credential is a password, it is
 *   passed to `sudo -S` via stdin so the password never appears on the command line or in scripts; when only a
 *   private key is available and sudo is not passwordless, the script explicitly tells the user what is missing
 *   and why it cannot install.
 * - The script outputs `PCS_STEP=` progress lines and a `PCS_NODE_PATH=` result line, with errors as `PCS_ENV_ERROR=`.
 */
export function buildEnvSetupScript(p: {
  nodePath: string;
  /** Bare-metal roles do not need Docker: skip installation and checks. */
  dockerRequired?: boolean;
}): string {
  return [
    "set -u",
    `NODE_CFG=${shQuote(p.nodePath)}`,
    'PCS_NODE=""',
    'if command -v "$NODE_CFG" >/dev/null 2>&1 && "$NODE_CFG" -e \'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)\' >/dev/null 2>&1; then',
    '  PCS_NODE="$(command -v "$NODE_CFG")"',
    "fi",
    'if [ -z "$PCS_NODE" ]; then',
    '  echo "PCS_STEP=node" >&2',
    '  case "$(uname -m)" in',
    "    aarch64|arm64) NODE_ARCH=arm64 ;;",
    "    x86_64|amd64) NODE_ARCH=x64 ;;",
    '    *) echo "PCS_ENV_ERROR=the remote host is missing Node 22, and CPU architecture $(uname -m) is not supported for automatic installation" >&2; exit 20 ;;',
    "  esac",
    '  NODE_DIR="$HOME/opt/node-v22.20.0-linux-$NODE_ARCH"',
    '  if [ ! -x "$NODE_DIR/bin/node" ]; then',
    '    echo "PCS_STEP=node-download" >&2',
    '    mkdir -p "$HOME/opt" || { echo "PCS_ENV_ERROR=the remote host is missing Node 22, and $HOME/opt is not writable" >&2; exit 21; }',
    '    if ! curl -fsSL --retry 2 --connect-timeout 15 -o /tmp/pcs-node22.tar.xz \\',
    '      "https://npmmirror.com/mirrors/node/v22.20.0/node-v22.20.0-linux-$NODE_ARCH.tar.xz"; then',
    '      echo "PCS_ENV_ERROR=the remote host is missing Node 22, and automatic download failed (check whether this machine can reach npmmirror.com)" >&2; exit 22',
    "    fi",
    '    tar -xJf /tmp/pcs-node22.tar.xz -C "$HOME/opt" || { echo "PCS_ENV_ERROR=the remote host is missing Node 22, and extraction failed after download" >&2; exit 23; }',
    "    rm -f /tmp/pcs-node22.tar.xz",
    "  fi",
    '  PCS_NODE="$NODE_DIR/bin/node"',
    '  [ -x "$PCS_NODE" ] || { echo "PCS_ENV_ERROR=the remote host is missing Node 22, and it is still not executable after automatic installation: $PCS_NODE" >&2; exit 24; }',
    "fi",
    ...(p.dockerRequired === false
      ? []
      : [
          'if ! { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }; then',
          '  echo "PCS_STEP=docker" >&2',
    '  HAVE_DOCKER=0',
    '  command -v docker >/dev/null 2>&1 && HAVE_DOCKER=1',
    '  USER_NAME="$(id -un)"',
    '  SUDO_PASS=""',
    '  if [ "$(id -u)" -eq 0 ]; then',
    "    ROOT_HOW=direct",
    '  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then',
    "    ROOT_HOW=nopasswd",
    "  else",
    '    IFS= read -r SUDO_PASS || true',
    '    if [ -z "$SUDO_PASS" ]; then',
    '      if [ "$HAVE_DOCKER" -eq 0 ]; then',
    '        echo "PCS_ENV_ERROR=the remote host is missing Docker, the current SSH credential has no password, and sudo is not passwordless; automatic installation is not possible" >&2',
    "      else",
    '        echo "PCS_ENV_ERROR=Docker on the remote host is unavailable, the current SSH credential has no password, and sudo is not passwordless; automatic repair is not possible" >&2',
    "      fi",
    "      exit 30",
    "    fi",
    "    ROOT_HOW=password",
    "    printf '%s\\n' \"$SUDO_PASS\" | sudo -S -p '' true >/dev/null 2>&1 \\",
    '      || { echo "PCS_ENV_ERROR=the sudo password on the remote host does not match the SSH password; cannot install Docker automatically" >&2; exit 34; }',
    "  fi",
    "  as_root() {",
    '    case "$ROOT_HOW" in',
    '      direct) bash -c "$1" ;;',
    '      nopasswd) sudo -n bash -c "$1" ;;',
    '      password) printf \'%s\\n\' "$SUDO_PASS" | sudo -S -p \'\' bash -c "$1" ;;',
    "    esac",
    "  }",
    '  if [ "$HAVE_DOCKER" -eq 0 ]; then',
    '    echo "PCS_STEP=docker-install" >&2',
    '    as_root "apt-get update -qq" >/dev/null 2>&1 \\',
    '      || { echo "PCS_ENV_ERROR=the remote host is missing Docker, and automatic installation failed (apt-get update did not succeed)" >&2; exit 31; }',
    '    as_root "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io" >/dev/null 2>&1 \\',
    '      || { echo "PCS_ENV_ERROR=the remote host is missing Docker, and automatic installation failed (apt-get install docker.io did not succeed)" >&2; exit 32; }',
    "  fi",
    '  as_root "systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true" >/dev/null 2>&1 || true',
    "  as_root \"usermod -aG docker '$USER_NAME' >/dev/null 2>&1 || true\" || true",
    "  i=0",
    "  while [ $i -lt 15 ]; do",
    '    as_root "docker info >/dev/null 2>&1" && break',
    "    i=$((i+1)); sleep 1",
    "  done",
    '  as_root "docker info >/dev/null 2>&1" \\',
    '    || { echo "PCS_ENV_ERROR=the remote host is missing Docker, and the daemon did not start after installation (check systemctl status docker)" >&2; exit 33; }',
    "fi",
        ]),
    'echo "PCS_NODE_PATH=$PCS_NODE"',
  ].join("\n");
}

/** Local host: no SSH needed; run the same script directly on this machine. */
export async function runLocalBootstrap(
  script: string,
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // The script may embed the runtime bundle and exceed the argv length limit; pass it to sh via stdin.
    const child = spawn("sh", [], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(script);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: `${stderr}\nbootstrap timed out` });
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
