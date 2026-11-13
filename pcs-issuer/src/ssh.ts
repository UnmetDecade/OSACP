import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Probe remote hosts through the system ssh client.
 *
 * Use the system ssh instead of pulling in a Node SSH library: the PCS already runs on a Linux/macOS management
 * machine, where ssh is always present; the private key is written only to a 0600 file in a 0700 temp directory and
 * deleted as soon as probing finishes, never entering command-line arguments, logs, or return values.
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
  /** Private-key auth; choose one of this and password. */
  privateKey?: string;
  /** Password auth; passed via SSH_ASKPASS and never enters command-line arguments. */
  password?: string;
};

export type SshResult = { code: number; stdout: string; stderr: string };

/**
 * Run a shell snippet on a remote host. When the script is passed via stdin it does not appear in the process list;
 * private keys/tokens in bootstrap scripts are wrapped in single quotes, and the caller is responsible for ensuring
 * the content comes from the platform rather than user input.
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
 * Send a byte stream to a remote command's stdin (for `docker save | docker load`).
 * Shares credential handling with execSsh; stdout/stderr only collect a summary, and image data is never sent back.
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
        resolve({ code: 124, stdout, stderr: `${stderr}\nSSH transfer timed out` });
      }, timeoutMs);
      source.pipe(child.stdin);
      child.stdin.on("error", () => {
        /* Ignore EPIPE when the remote end exits early; the close event provides the result */
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
 * Interactive login: `ssh -tt` requests a remote PTY, and stdin/stdout connect directly to the shell in the container.
 * The temp directory (private key, askpass) is deleted by cleanup when the session ends, so it cannot be cleaned up
 * before the function returns the way execSsh does.
 */
export function spawnSshPty(
  target: SshTarget,
  command: string,
  env: Record<string, string | undefined> = {},
): { child: ChildProcess; cleanup: () => void } {
  const prepared = prepareSsh(target);
  // LogLevel=ERROR: do not write known_hosts notices into the terminal during an interactive session.
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
    // The password never goes into the command line or scripts: askpass reads it from a 0600 file. ssh only uses
    // askpass when stdin is not a terminal, and our spawn uses pipes, so there is no tty.
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
        error: conciseError(out.stderr) || `ssh exited with code ${out.code}`,
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

/** The local host (the machine running the PCS) needs no SSH; run the same probe script directly. */
export async function probeLocal(timeoutMs = PROBE_TIMEOUT_MS): Promise<SshProbe> {
  const checkedAt = new Date().toISOString();
  try {
    const out = await run("sh", ["-c", REMOTE_SCRIPT], timeoutMs);
    if (out.code !== 0) {
      return { ok: false, checked_at: checkedAt, error: conciseError(out.stderr) || `exit code ${out.code}` };
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

/** Keep only the last meaningful error line, to avoid bringing the whole known_hosts notice back into the UI. */
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
    if (code === "ENOENT") return "ssh client not found on this machine";
    if (code === "ETIMEDOUT") return "SSH connection timed out";
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
      resolve({ code: 124, stdout, stderr: `${stderr}\nSSH timed out` });
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
