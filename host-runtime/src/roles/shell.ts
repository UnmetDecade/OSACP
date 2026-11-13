import { spawn } from "node:child_process";
import path from "node:path";

/**
 * The only entry point for running commands inside the builder.
 *
 * In v4 the builder is a dedicated development container; SSH and task.console.builder both have full permissions:
 * no allowlist, commands run via `/bin/sh -lc`. The security boundary is the container itself
 * (isolated rootfs, no Docker Socket mount, resource limits, network policy), not command filtering.
 */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

const MAX_CAPTURE = 256 * 1024;

/**
 * The runtime itself runs under node, so its directory always has a working interpreter. Putting it first keeps
 * `node` resolvable on native hosts, where the system PATH may not include it at all.
 */
const NODE_BIN_DIR = path.dirname(process.execPath);

/** Inherit only the minimal environment needed to run; platform tokens do not enter the build process. */
export function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: [NODE_BIN_DIR, process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"].join(":"),
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
 * Run a shell command.
 *
 * - `cwd` is guaranteed by the caller to be inside the workspace;
 * - on timeout or abort, kill the whole process group so child processes do not keep running;
 * - stdout/stderr are each truncated to 256 KiB; whether to persist the full log as an artifact is up to the caller.
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
        // The process may have already exited
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
