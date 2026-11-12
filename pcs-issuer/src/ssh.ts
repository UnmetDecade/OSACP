import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 通过系统 ssh 客户端探测远程主机。
 *
 * 用系统 ssh 而不是引入 Node SSH 库：PCS 本来就跑在 Linux/macOS 管理机上，
 * ssh 一定存在；私钥只写进 0700 临时目录里的 0600 文件，探测结束立即删除，
 * 不进入命令行参数、日志或返回值。
 */
export type SshProbe = {
  ok: boolean;
  checked_at: string;
  error?: string;
  hostname?: string;
  os?: string;
  arch?: string;
  docker?: boolean;
  docker_version?: string;
  docker_ok?: boolean;
};

export type SshTarget = {
  address: string;
  port: number;
  user: string;
  /** 私钥认证；与 password 二选一。 */
  privateKey?: string;
  /** 密码认证；通过 SSH_ASKPASS 传递，不进入命令行参数。 */
  password?: string;
};

export type SshResult = { code: number; stdout: string; stderr: string };

/**
 * 在远程主机执行一段 shell。脚本通过 stdin 传入时不会出现在进程列表里；
 * 引导脚本里的私钥/令牌都用单引号包裹，调用方负责保证内容来自平台而非用户输入。
 */
export async function execSsh(
  target: SshTarget,
  command: string,
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<SshResult> {
  const { dir, args, env } = prepareSsh(target);
  try {
    return await run(
      "ssh",
      [...args, command],
      opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      opts.input,
      env,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 把一段字节流送到远程命令的 stdin（用于 `docker save | docker load`）。
 * 与 execSsh 共用凭据处理；stdout/stderr 只收摘要，不回传镜像数据。
 */
export async function pipeToSsh(
  target: SshTarget,
  command: string,
  source: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<SshResult> {
  const { dir, args, env } = prepareSsh(target);
  try {
    return await new Promise<SshResult>((resolve, reject) => {
      const child = spawn("ssh", [...args, command], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        source.unpipe?.(child.stdin);
        resolve({ code: 124, stdout, stderr: `${stderr}\nSSH 传输超时` });
      }, timeoutMs);
      source.pipe(child.stdin);
      child.stdin.on("error", () => {
        /* 远端提前退出时忽略 EPIPE，由 close 事件给出结果 */
      });
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 交互式登录：`ssh -tt` 申请远端 PTY，stdin/stdout 直接连容器里的 shell。
 * 临时目录（私钥、askpass）在会话结束时由 cleanup 删除，因此不能像
 * execSsh 那样在函数返回前清掉。
 */
export function spawnSshPty(
  target: SshTarget,
  command: string,
  env: Record<string, string | undefined> = {},
): { child: ChildProcess; cleanup: () => void } {
  const prepared = prepareSsh(target);
  // LogLevel=ERROR：交互式会话里不要把 known_hosts 提示写进终端。
  const child = spawn("ssh", ["-tt", "-o", "LogLevel=ERROR", ...prepared.args, command], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, ...prepared.env },
  });
  return {
    child,
    cleanup: () => fs.rmSync(prepared.dir, { recursive: true, force: true }),
  };
}

function prepareSsh(target: SshTarget): {
  dir: string;
  args: string[];
  env: Record<string, string>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcs-ssh-"));
  const knownHosts = path.join(dir, "known_hosts");
  fs.writeFileSync(knownHosts, "", { mode: 0o600 });
  const args = [
    "-p",
    String(target.port),
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  const env: Record<string, string> = {};

  if (target.privateKey) {
    const keyFile = path.join(dir, "id_key");
    fs.writeFileSync(keyFile, target.privateKey, { mode: 0o600 });
    args.push("-i", keyFile, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes");
  } else {
    // 密码不写进命令行与脚本：askpass 从 0600 文件里读。标准输入不是终端时
    // ssh 才会走 askpass，我们的 spawn 用管道，正好没有 tty。
    const passwordFile = path.join(dir, "askpass.txt");
    const askpass = path.join(dir, "askpass.sh");
    fs.writeFileSync(passwordFile, target.password ?? "", { mode: 0o600 });
    fs.writeFileSync(askpass, `#!/bin/sh\nexec cat '${passwordFile}'\n`, { mode: 0o700 });
    args.push(
      "-o",
      "BatchMode=no",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
    );
    env.SSH_ASKPASS = askpass;
    env.SSH_ASKPASS_REQUIRE = "force";
    env.DISPLAY = env.DISPLAY || ":0";
  }

  args.push(`${target.user}@${target.address}`);
  return { dir, args, env };
}

const PROBE_TIMEOUT_MS = 20_000;

const REMOTE_SCRIPT = [
  'printf "PCS_OS=%s\\n" "$(uname -s 2>/dev/null)"',
  'printf "PCS_ARCH=%s\\n" "$(uname -m 2>/dev/null)"',
  'printf "PCS_HOSTNAME=%s\\n" "$(hostname 2>/dev/null)"',
  "if command -v docker >/dev/null 2>&1; then",
  '  printf "PCS_DOCKER=1\\n"',
  '  printf "PCS_DOCKER_VERSION=%s\\n" "$(docker --version 2>/dev/null | head -n 1)"',
  "  if docker info >/dev/null 2>&1; then",
  '    printf "PCS_DOCKER_OK=1\\n"',
  "  else",
  '    printf "PCS_DOCKER_OK=0\\n"',
  "  fi",
  "else",
  '  printf "PCS_DOCKER=0\\n"',
  "fi",
].join("\n");

export async function probeSsh(target: SshTarget, timeoutMs = PROBE_TIMEOUT_MS): Promise<SshProbe> {
  const checkedAt = new Date().toISOString();
  const { dir, args, env } = prepareSsh(target);
  try {
    const out = await run("ssh", [...args, REMOTE_SCRIPT], timeoutMs, undefined, env);
    if (out.code !== 0) {
      return {
        ok: false,
        checked_at: checkedAt,
        error: conciseError(out.stderr) || `ssh 退出码 ${out.code}`,
      };
    }
    const values = parseKeyValues(out.stdout);
    return {
      ok: true,
      checked_at: checkedAt,
      hostname: values.PCS_HOSTNAME || undefined,
      os: values.PCS_OS || undefined,
      arch: values.PCS_ARCH || undefined,
      docker: values.PCS_DOCKER === "1",
      docker_version: values.PCS_DOCKER_VERSION || undefined,
      docker_ok: values.PCS_DOCKER_OK === "1",
    };
  } catch (e) {
    return { ok: false, checked_at: checkedAt, error: describe(e) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 本地主机（PCS 所在机器）不需要 SSH，直接跑同一条探测脚本。 */
export async function probeLocal(timeoutMs = PROBE_TIMEOUT_MS): Promise<SshProbe> {
  const checkedAt = new Date().toISOString();
  try {
    const out = await run("sh", ["-c", REMOTE_SCRIPT], timeoutMs);
    if (out.code !== 0) {
      return { ok: false, checked_at: checkedAt, error: conciseError(out.stderr) || `退出码 ${out.code}` };
    }
    const values = parseKeyValues(out.stdout);
    return {
      ok: true,
      checked_at: checkedAt,
      hostname: values.PCS_HOSTNAME || undefined,
      os: values.PCS_OS || undefined,
      arch: values.PCS_ARCH || undefined,
      docker: values.PCS_DOCKER === "1",
      docker_version: values.PCS_DOCKER_VERSION || undefined,
      docker_ok: values.PCS_DOCKER_OK === "1",
    };
  } catch (e) {
    return { ok: false, checked_at: checkedAt, error: describe(e) };
  }
}

function parseKeyValues(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx > 0 && line.startsWith("PCS_")) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

/** 只保留最后一行有意义的错误，避免把整段 known_hosts 提示带回界面。 */
function conciseError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^Warning: Permanently added/.test(l));
  return lines[lines.length - 1]?.slice(0, 300) ?? "";
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "本机找不到 ssh 客户端";
    if (code === "ETIMEDOUT") return "SSH 连接超时";
    return e.message;
  }
  return String(e);
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
  input?: string,
  extraEnv?: Record<string, string>,
): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"] as const,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: `${stderr}\nSSH 超时` });
    }, timeoutMs);
    child.stdin.end(input ?? "");
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
