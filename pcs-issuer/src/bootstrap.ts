import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * SSH 引导 / 本地引导：把 host-runtime 装到主机上并启动。
 *
 * 引导只写平台自己的文件，不覆盖用户目录；每台主机一个独立目录
 * （$HOME/.platform/host-runtime/<host_id>），重复引导只重启该目录下的进程。
 * 脚本通过 SSH stdin 或本机 sh 执行，令牌与 PEM 用 base64 内嵌，避免引号注入。
 */
export type BootstrapPlan = {
  hostId: string;
  nodePath: string;
  pcsUrl: string;
  enrollmentToken: string;
  commandPublicKey: string;
  imageAllowlist: string[];
  networkPolicies: string[];
  /** 策略名到 Docker 网络名的映射；未配置时 default 落 bridge。 */
  networkPolicyMap: Record<string, string>;
  runtimeBundle: { runtime: string; watchdog: string };
  /**
   * 主机本地凭据文件内容（KEY=VALUE）。有值时写到 $HOME/.config/platform/agent-env
   * 并设为 600；部署命令只引用变量名，值由主机自己补。
   */
  agentEnvContent?: string;
  /** 凭据文件来源，写进日志方便排查（不含内容）。 */
  agentEnvSource?: string;
  /**
   * 是否需要 Docker。容器宿主必须为 true；裸机构建机/调度机直接在主机上
   * 跑角色进程，没有 Docker 也能启动 host-runtime。
   */
  dockerRequired?: boolean;
};

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64");
const readFile = (file: string) => fs.readFileSync(file);

export function buildBootstrapScript(p: BootstrapPlan): string {
  const dir = `$HOME/.platform/host-runtime/${p.hostId}`;
  // 配置里用相对路径：启动脚本会 cd 到 DIR，避免把 $HOME 字面量写进 JSON。
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
    // 模型凭据只落在主机本地（600），部署命令里只有变量名。
    ...(p.agentEnvContent
      ? [
          'mkdir -p "$HOME/.config/platform"',
          `printf %s '${b64(p.agentEnvContent)}' | base64 -d > "$HOME/.config/platform/agent-env"`,
          'chmod 600 "$HOME/.config/platform/agent-env"',
        ]
      : []),
    // 先停旧进程，避免同一身份起两个守护进程。
    // pid 文件可能被手动重启脚本覆盖，再按本目录路径兜底清一遍。
    'for f in runtime.pid watchdog.pid; do',
    '  if [ -f "$DIR/$f" ]; then kill "$(cat "$DIR/$f")" 2>/dev/null || true; fi',
    "done",
    'for pid in $(pgrep -f "$DIR/(watchdog|runtime)\\.mjs" || true); do kill "$pid" 2>/dev/null || true; done',
    "sleep 0.3",
    `NODE="${p.nodePath}"`,
    'command -v "$NODE" >/dev/null 2>&1 || { echo "BOOTSTRAP_ERROR 目标主机找不到 Node（当前：$NODE）：请安装 Node 22+，并用 PCS_RUNTIME_NODE 指定绝对路径" >&2; exit 20; }',
    '"$NODE" -e \'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)\' \\',
    '  || { echo "BOOTSTRAP_ERROR 目标主机的 Node 版本低于 22（当前：$("$NODE" -v 2>/dev/null)），请用 PCS_RUNTIME_NODE 指向 Node 22+" >&2; exit 21; }',
    // 裸机角色不需要 Docker；容器宿主仍然强制检查，避免部署时才失败。
    ...(p.dockerRequired === false
      ? []
      : [
          'docker info >/dev/null 2>&1 \\',
          '  || { echo "BOOTSTRAP_ERROR 目标主机没有可用的 Docker：先安装 Docker Engine，并让当前用户能访问 /var/run/docker.sock" >&2; exit 22; }',
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
 * 远程环境准备：Node 22 与 Docker 缺什么装什么，然后返回可用的 Node 路径。
 *
 * - Node 装到 `$HOME/opt`（不需要 sudo），与引导脚本的 nodePath 约定一致。
 * - Docker 用系统的 docker.io 包；这一步要 root，凭据是密码时通过 stdin 交给
 *   `sudo -S`，密码不进命令行/脚本；只有私钥且 sudo 不免密时明确告诉用户
 *   缺什么、为什么装不了。
 * - 脚本输出 `PCS_STEP=` 进度行与 `PCS_NODE_PATH=` 结果行，错误用 `PCS_ENV_ERROR=`。
 */
export function buildEnvSetupScript(p: {
  nodePath: string;
  /** 裸机角色不需要 Docker：跳过安装与检查。 */
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
    '    *) echo "PCS_ENV_ERROR=远程主机缺少 Node 22，且 CPU 架构 $(uname -m) 不在自动安装支持范围内" >&2; exit 20 ;;',
    "  esac",
    '  NODE_DIR="$HOME/opt/node-v22.20.0-linux-$NODE_ARCH"',
    '  if [ ! -x "$NODE_DIR/bin/node" ]; then',
    '    echo "PCS_STEP=node-download" >&2',
    '    mkdir -p "$HOME/opt" || { echo "PCS_ENV_ERROR=远程主机缺少 Node 22，且无法写入 $HOME/opt" >&2; exit 21; }',
    '    if ! curl -fsSL --retry 2 --connect-timeout 15 -o /tmp/pcs-node22.tar.xz \\',
    '      "https://npmmirror.com/mirrors/node/v22.20.0/node-v22.20.0-linux-$NODE_ARCH.tar.xz"; then',
    '      echo "PCS_ENV_ERROR=远程主机缺少 Node 22，自动下载失败（检查这台机器能否访问 npmmirror.com）" >&2; exit 22',
    "    fi",
    '    tar -xJf /tmp/pcs-node22.tar.xz -C "$HOME/opt" || { echo "PCS_ENV_ERROR=远程主机缺少 Node 22，下载后解压失败" >&2; exit 23; }',
    "    rm -f /tmp/pcs-node22.tar.xz",
    "  fi",
    '  PCS_NODE="$NODE_DIR/bin/node"',
    '  [ -x "$PCS_NODE" ] || { echo "PCS_ENV_ERROR=远程主机缺少 Node 22，自动安装后仍不可执行：$PCS_NODE" >&2; exit 24; }',
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
    '        echo "PCS_ENV_ERROR=远程主机缺少 Docker，且当前 SSH 凭据没有密码、sudo 不能免密，无法自动安装" >&2',
    "      else",
    '        echo "PCS_ENV_ERROR=远程主机上的 Docker 不可用，且当前 SSH 凭据没有密码、sudo 不能免密，无法自动修复" >&2',
    "      fi",
    "      exit 30",
    "    fi",
    "    ROOT_HOW=password",
    "    printf '%s\\n' \"$SUDO_PASS\" | sudo -S -p '' true >/dev/null 2>&1 \\",
    '      || { echo "PCS_ENV_ERROR=远程主机的 sudo 密码与 SSH 密码不一致，无法自动安装 Docker" >&2; exit 34; }',
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
    '      || { echo "PCS_ENV_ERROR=远程主机缺少 Docker，自动安装失败（apt-get update 没有成功）" >&2; exit 31; }',
    '    as_root "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io" >/dev/null 2>&1 \\',
    '      || { echo "PCS_ENV_ERROR=远程主机缺少 Docker，自动安装失败（apt-get install docker.io 没有成功）" >&2; exit 32; }',
    "  fi",
    '  as_root "systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true" >/dev/null 2>&1 || true',
    "  as_root \"usermod -aG docker '$USER_NAME' >/dev/null 2>&1 || true\" || true",
    "  i=0",
    "  while [ $i -lt 15 ]; do",
    '    as_root "docker info >/dev/null 2>&1" && break',
    "    i=$((i+1)); sleep 1",
    "  done",
    '  as_root "docker info >/dev/null 2>&1" \\',
    '    || { echo "PCS_ENV_ERROR=远程主机缺少 Docker，安装后守护进程没有起来（检查 systemctl status docker）" >&2; exit 33; }',
    "fi",
        ]),
    'echo "PCS_NODE_PATH=$PCS_NODE"',
  ].join("\n");
}

/** 本地主机：不需要 SSH，直接在本机执行同一段脚本。 */
export async function runLocalBootstrap(
  script: string,
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // 脚本可能内嵌 runtime bundle，超过 argv 长度上限；用 stdin 传给 sh。
    const child = spawn("sh", [], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(script);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: `${stderr}\n引导超时` });
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
