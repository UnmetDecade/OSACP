import { spawn } from "node:child_process";

/**
 * 构建机内执行命令的唯一入口。
 *
 * v4 的构建机是专用研发容器，SSH 和 task.console.builder 都是完整权限：
 * 不设白名单，命令通过 `/bin/sh -lc` 执行。安全边界是容器本身
 * （独立 rootfs、不挂 Docker Socket、资源限额、网络策略），不是命令过滤。
 */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

const MAX_CAPTURE = 256 * 1024;

/** 只继承运行所需的最小环境；平台令牌不进入构建进程。 */
export function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME ?? "/root",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

function appendCapped(target: string[], chunk: Buffer, state: { bytes: number }): void {
  if (state.bytes >= MAX_CAPTURE) return;
  const text = chunk.toString("utf8");
  const room = MAX_CAPTURE - state.bytes;
  target.push(text.length > room ? text.slice(0, room) : text);
  state.bytes += Math.min(Buffer.byteLength(text), room);
}

/**
 * 执行一条 shell 命令。
 *
 * - `cwd` 由调用方保证在 workspace 内；
 * - 超时或 abort 时杀掉整个进程组，避免子进程继续跑；
 * - stdout/stderr 各截断到 256 KiB，完整日志由调用方决定是否落制品。
 */
export function runShell(input: {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<ShellResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("/bin/sh", ["-lc", input.command], {
      cwd: input.cwd,
      env: input.env ?? baseEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out: string[] = [];
    const err: string[] = [];
    const outState = { bytes: 0 };
    const errState = { bytes: 0 };
    let timedOut = false;
    let settled = false;

    const kill = () => {
      if (child.killed) return;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // 进程可能已经退出
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);

    const onAbort = () => kill();
    input.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (b: Buffer) => appendCapped(out, b, outState));
    child.stderr?.on("data", (b: Buffer) => appendCapped(err, b, errState));

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: out.join(""),
        stderr: err.join(""),
        exitCode,
        durationMs: Date.now() - started,
        timedOut,
      });
    };

    child.on("error", (e) => {
      err.push(String(e.message ?? e));
      finish(127);
    });
    child.on("close", (code, signal) => {
      finish(timedOut ? 124 : typeof code === "number" ? code : signal ? 128 : 1);
    });
  });
}

export function tail(text: string, max = 4000): string {
  return text.length <= max ? text : text.slice(-max);
}
