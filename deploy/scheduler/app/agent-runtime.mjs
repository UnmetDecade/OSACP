import { createRequire as __platformCreateRequire } from "node:module"; const require = __platformCreateRequire(import.meta.url);

// host-runtime/src/main.ts
import fs9 from "node:fs";
import path9 from "node:path";

// host-runtime/src/agent.ts
import { createHash as createHash3 } from "node:crypto";
import fs7 from "node:fs";
import path7 from "node:path";

// host-runtime/src/admission.ts
var LocalAdmission = class {
  constructor(availableBytes, perSlotBytes) {
    this.availableBytes = availableBytes;
    this.perSlotBytes = perSlotBytes;
  }
  availableBytes;
  perSlotBytes;
  reserved = 0;
  chain = Promise.resolve();
  /** Serialize: at most one call can see and modify `reserved` at any time */
  tryAcquire() {
    const run = this.chain.then(() => {
      const available = this.availableBytes();
      const requested = this.perSlotBytes;
      const observed = {
        mem_available_bytes: available,
        reserved_bytes: this.reserved,
        requested_bytes: requested
      };
      if (available - this.reserved < requested) {
        return { allowed: false, reason: "INSUFFICIENT_MEMORY", observed };
      }
      this.reserved += requested;
      return { allowed: true, observed };
    });
    this.chain = run.catch(() => {
    });
    return run;
  }
  release() {
    this.reserved = Math.max(0, this.reserved - this.perSlotBytes);
  }
  get reservedBytes() {
    return this.reserved;
  }
};

// host-runtime/src/client.ts
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
var SchedulerError = class extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.name = "SchedulerError";
  }
  status;
  code;
  detail;
  /** Write was overridden by a stale attempt: abandon this task immediately, do not retry */
  get isFencingLost() {
    return this.code === "FENCING_STALE" || this.code === "LEASE_EXPIRED" || this.code === "LEASE_MISMATCH";
  }
  get isRetryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
};
var SchedulerClient = class {
  constructor(baseUrl, defaultTimeoutMs = 5e3, token, tlsOptions = {}) {
    this.baseUrl = baseUrl;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.token = token;
    this.tls = {
      ca: tlsOptions.caFile ? fs.readFileSync(tlsOptions.caFile) : void 0,
      cert: tlsOptions.certFile ? fs.readFileSync(tlsOptions.certFile) : void 0,
      key: tlsOptions.keyFile ? fs.readFileSync(tlsOptions.keyFile) : void 0
    };
  }
  baseUrl;
  defaultTimeoutMs;
  token;
  tls;
  /** Read on every request: token file rotation requires no process restart */
  currentToken() {
    return typeof this.token === "function" ? this.token() : this.token;
  }
  headers(body) {
    const h = { "X-Protocol-Version": "1.0" };
    if (body !== void 0) h["content-type"] = "application/json";
    const token = this.currentToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }
  async request(method, path10, body, opts = {}) {
    const retries = opts.retries ?? 2;
    const timeout = opts.timeoutMs ?? this.defaultTimeoutMs;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const url = new URL(`${this.baseUrl}${path10}`);
        const payload = body === void 0 ? void 0 : Buffer.from(JSON.stringify(body));
        const headers = this.headers(body);
        if (payload) headers["content-length"] = payload.length;
        const isHttps = url.protocol === "https:";
        const options = { method, headers, timeout };
        if (isHttps) {
          if (this.tls.ca) options.ca = this.tls.ca;
          if (this.tls.cert) options.cert = this.tls.cert;
          if (this.tls.key) options.key = this.tls.key;
        }
        const { status, text } = await new Promise(
          (resolve, reject) => {
            const req = (isHttps ? https : http).request(url, options, (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
              res.on(
                "end",
                () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") })
              );
            });
            req.on("timeout", () => req.destroy(new Error(`Request timed out (${timeout}ms)`)));
            req.on("error", reject);
            if (payload) req.write(payload);
            req.end();
          }
        );
        if (status === 204 || status === 304) return null;
        const data = text ? JSON.parse(text) : {};
        if (status < 200 || status >= 300) {
          const err = data?.error ?? {};
          throw new SchedulerError(
            status,
            err.code ?? "UNKNOWN",
            err.message ?? `HTTP ${status}`,
            err.detail
          );
        }
        return data;
      } catch (e) {
        if (e instanceof SchedulerError && !e.isRetryable) throw e;
        lastErr = e;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        }
      }
    }
    if (lastErr instanceof SchedulerError) throw lastErr;
    throw new SchedulerError(0, "SCHEDULER_UNREACHABLE", String(lastErr?.message ?? lastErr));
  }
  /** Raw byte request (artifact upload/download): also over HTTPS / mTLS, without JSON parsing. */
  async rawRequest(method, path10, body, timeoutMs = this.defaultTimeoutMs) {
    const url = new URL(`${this.baseUrl}${path10}`);
    const isHttps = url.protocol === "https:";
    const headers = { "X-Protocol-Version": "1.0" };
    const token = this.currentToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) {
      headers["content-type"] = "application/octet-stream";
      headers["content-length"] = body.length;
    }
    const options = { method, headers, timeout: timeoutMs };
    if (isHttps) {
      if (this.tls.ca) options.ca = this.tls.ca;
      if (this.tls.cert) options.cert = this.tls.cert;
      if (this.tls.key) options.key = this.tls.key;
    }
    try {
      return await new Promise((resolve, reject) => {
        const req = (isHttps ? https : http).request(url, options, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on(
            "end",
            () => resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              data: Buffer.concat(chunks)
            })
          );
        });
        req.on("timeout", () => req.destroy(new Error(`Request timed out (${timeoutMs}ms)`)));
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    } catch (e) {
      const msg = e?.message ?? String(e);
      throw new SchedulerError(0, msg.includes("timed out") || msg.includes("\u8D85\u65F6") ? "TIMEOUT" : "SCHEDULER_UNREACHABLE", msg);
    }
  }
  register(input) {
    return this.request("POST", "/v1/instances/register", input);
  }
  heartbeat(input) {
    return this.request("POST", "/v1/instances/heartbeat", input);
  }
  /** Claim. Returns null (204) when there are no candidates. Network failures are not auto-retried; that is left to the caller's loop cadence. */
  claim(instanceId) {
    return this.request("POST", "/v1/claim", { instance_id: instanceId }, { retries: 0 });
  }
  startAck(attemptId, input) {
    return this.request("POST", `/v1/attempts/${attemptId}/start-ack`, input);
  }
  renew(attemptId, input) {
    return this.request("POST", `/v1/attempts/${attemptId}/renew`, input);
  }
  progress(attemptId, input) {
    return this.request("POST", `/v1/attempts/${attemptId}/progress`, input);
  }
  result(attemptId, input) {
    return this.request("POST", `/v1/attempts/${attemptId}/result`, input);
  }
  task(taskId) {
    return this.request(
      "GET",
      `/v1/tasks/${taskId}`
    );
  }
  /** Config sync. When the version is unchanged the scheduler returns 304, normalized to null here. */
  config(instanceId, version) {
    const qs = version === void 0 ? "" : `?version=${encodeURIComponent(version)}`;
    return this.request("GET", `/v1/instances/${instanceId}/config${qs}`);
  }
  /** Deregister. With in-flight tasks and force=false, the scheduler returns 409. */
  deregister(instanceId, input = {}) {
    return this.request(
      "POST",
      `/v1/instances/${instanceId}/deregister`,
      input
    );
  }
  // ---------------- Artifacts (§7.8)
  createArtifact(input) {
    return this.request("POST", "/v1/artifacts", input);
  }
  /** Raw byte upload, not JSON */
  async uploadArtifactContent(artifactId, content) {
    const res = await this.rawRequest(
      "PUT",
      `/v1/artifacts/${encodeURIComponent(artifactId)}/content`,
      content
    );
    if (res.status < 200 || res.status >= 300) {
      const data = res.data.length ? JSON.parse(res.data.toString("utf8")) : {};
      const err = data?.error ?? {};
      throw new SchedulerError(res.status, err.code ?? "UNKNOWN", err.message ?? `HTTP ${res.status}`);
    }
  }
  completeArtifact(artifactId) {
    return this.request(
      "POST",
      `/v1/artifacts/${artifactId}/complete`
    );
  }
  /**
   * Download artifact raw bytes.
   *
   * The scheduler authorizes only two kinds of reads: this instance's own artifacts, or upstream artifacts the scheduler
   * explicitly handed over in the task's `requirements.upstream_artifacts`. The caller must still
   * re-verify against the sha256 in the handoff record; the transport layer cannot be trusted.
   */
  async downloadArtifactContent(artifactId) {
    const res = await this.rawRequest(
      "GET",
      `/v1/artifacts/${encodeURIComponent(artifactId)}/content`,
      void 0
    );
    if (res.status < 200 || res.status >= 300) {
      const data = res.data.length ? JSON.parse(res.data.toString("utf8")) : {};
      const err = data?.error ?? {};
      throw new SchedulerError(
        res.status,
        err.code ?? "UNKNOWN",
        err.message ?? `HTTP ${res.status}`,
        err.detail
      );
    }
    return {
      data: res.data,
      sha256: String(res.headers["x-artifact-sha256"] ?? ""),
      media_type: String(res.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim()
    };
  }
};

// host-runtime/src/roles/builder.ts
import path2 from "node:path";

// host-runtime/src/roles/common.ts
import { createHash } from "node:crypto";
import fs2 from "node:fs";
import path from "node:path";

// host-runtime/src/exec-types.ts
var TaskAborted = class extends Error {
  constructor(reason) {
    super(`task aborted: ${reason}`);
    this.reason = reason;
    this.name = "TaskAborted";
  }
  reason;
};
var TaskFailed = class extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.name = "TaskFailed";
  }
  code;
  detail;
};

// host-runtime/src/roles/common.ts
var MEDIA = {
  build: "application/vnd.platform.build-manifest+json",
  log: "text/plain; charset=utf-8",
  review: "application/vnd.platform.review-report+json",
  commit: "application/vnd.platform.commit-record+json",
  test: "application/vnd.platform.test-report+json",
  ticket: "application/vnd.platform.ticket-intake+json",
  analysis: "application/vnd.platform.ticket-analysis+json",
  response: "text/plain; charset=utf-8"
};
function sleepAbortable(ms, signal) {
  const abortReason = () => {
    const r = signal.reason;
    return r === "cancelled" || r === "shutdown" ? r : "lease_lost";
  };
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new TaskAborted(abortReason()));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(new TaskAborted(abortReason()));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function sha256Of(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}
function safeJoin(root, rel) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new TaskFailed("PAYLOAD_INVALID", `Workdir path escapes the boundary: ${rel}`);
  }
  return abs;
}
function writeWorkspaceFile(root, rel, content) {
  const file = safeJoin(root, rel);
  fs2.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.from(content);
  fs2.writeFileSync(file, buf);
  return { path: rel, sha256: sha256Of(buf), size_bytes: buf.length };
}

// host-runtime/src/roles/shell.ts
import { spawn } from "node:child_process";
var MAX_CAPTURE = 256 * 1024;
function baseEnv(extra = {}) {
  const env = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME ?? "/root",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb"
  };
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === "string") env[k] = v;
  }
  return env;
}
function appendCapped(target, chunk, state) {
  if (state.bytes >= MAX_CAPTURE) return;
  const text = chunk.toString("utf8");
  const room = MAX_CAPTURE - state.bytes;
  target.push(text.length > room ? text.slice(0, room) : text);
  state.bytes += Math.min(Buffer.byteLength(text), room);
}
function runShell(input) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("/bin/sh", ["-lc", input.command], {
      cwd: input.cwd,
      env: input.env ?? baseEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const out = [];
    const err = [];
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
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);
    const onAbort = () => kill();
    input.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (b) => appendCapped(out, b, outState));
    child.stderr?.on("data", (b) => appendCapped(err, b, errState));
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      resolve({
        stdout: out.join(""),
        stderr: err.join(""),
        exitCode,
        durationMs: Date.now() - started,
        timedOut
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
function tail(text, max = 4e3) {
  return text.length <= max ? text : text.slice(-max);
}

// host-runtime/src/roles/builder.ts
var taskBuild = async (task, ctx) => {
  const raw = task.requirements?.build ?? {};
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const workdir = typeof raw.workdir === "string" ? raw.workdir : "";
  const extraEnv = raw.env && typeof raw.env === "object" ? Object.fromEntries(
    Object.entries(raw.env).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, String(v)])
  ) : {};
  const instruction = typeof raw.instruction === "string" ? raw.instruction.trim() : "";
  if (!command && instruction) {
    throw new TaskFailed(
      "AGENT_REQUIRED",
      "This is a natural-language task; bind an Agent that supports task.build to the builder before running it"
    );
  }
  if (!command) return legacyManifest(task, ctx);
  ctx.progress(5, `Executing in the builder: ${command.slice(0, 80)}`);
  const cwd = resolveWorkdir(ctx.workspaceDir, workdir);
  const result = await runShell({
    command,
    cwd,
    env: baseEnv({
      ...extraEnv,
      PLATFORM_INSTANCE_ID: ctx.instanceId,
      PLATFORM_TASK_ID: task.task_id,
      PLATFORM_TASK_TYPE: task.task_type,
      PLATFORM_WORKSPACE: ctx.workspaceDir
    }),
    signal: ctx.signal,
    timeoutMs: 15 * 6e4
  });
  if (ctx.signal.aborted) {
    throw new TaskAborted(taskAbortReason(ctx.signal));
  }
  ctx.progress(85, "Uploading build log");
  const log = [
    `# build log`,
    `task_id: ${task.task_id}`,
    `attempt_id: ${task.attempt_id}`,
    `instance: ${ctx.instanceId}`,
    `command: ${command}`,
    `workdir: ${cwd}`,
    `exit_code: ${result.exitCode}`,
    `duration_ms: ${result.durationMs}`,
    "",
    "## stdout",
    result.stdout,
    "",
    "## stderr",
    result.stderr,
    ""
  ].join("\n");
  const artifact = await ctx.uploadArtifact(log, MEDIA.log);
  if (result.timedOut) {
    throw new TaskFailed("BUILD_TIMEOUT", "Build command exceeded 15 minutes and was terminated", {
      command,
      log_artifact_id: artifact.artifact_id
    });
  }
  if (result.exitCode !== 0) {
    throw new TaskFailed("BUILD_FAILED", `Build command exited with code ${result.exitCode}`, {
      exit_code: result.exitCode,
      command,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
      log_artifact_id: artifact.artifact_id,
      log_sha256: artifact.sha256
    });
  }
  ctx.progress(100, "Build completed");
  return {
    summary: `Build completed: exit 0 \xB7 ${Math.round(result.durationMs / 1e3)}s`,
    outputs: {
      exit_code: 0,
      duration_ms: result.durationMs,
      command,
      workdir,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
      log_artifact_id: artifact.artifact_id,
      log_sha256: artifact.sha256
    }
  };
};
function taskAbortReason(signal) {
  const r = signal.reason;
  return r === "cancelled" || r === "shutdown" ? r : "lease_lost";
}
function resolveWorkdir(root, rel) {
  if (!rel || rel === ".") return root;
  const base = path2.resolve(root);
  const workspaceRoot = path2.dirname(base);
  const requested = path2.isAbsolute(rel) ? path2.resolve(rel) : path2.resolve(base, rel);
  const abs = requested === workspaceRoot ? base : requested.startsWith(workspaceRoot + path2.sep) ? path2.resolve(base, path2.relative(workspaceRoot, requested)) : requested;
  if (abs !== base && !abs.startsWith(base + path2.sep)) {
    throw new TaskFailed("BUILD_WORKDIR_INVALID", `Workdir escapes the boundary: ${rel}`);
  }
  return abs;
}
async function legacyManifest(task, ctx) {
  ctx.progress(10, "Preparing workspace");
  const mainJs = [
    `// generated by builder agent for ${task.task_id}`,
    `export const taskId = ${JSON.stringify(task.task_id)};`,
    `export const payloadRef = ${JSON.stringify(task.payload_ref ?? null)};`,
    ""
  ].join("\n");
  await sleepAbortable(300, ctx.signal);
  ctx.progress(40, "Compiling");
  const workload = task.payload_ref ?? "(none)";
  const files = [
    writeWorkspaceFile(
      ctx.workspaceDir,
      "package.json",
      JSON.stringify({ name: `pkg-${task.task_id}`, version: "0.0.0", private: true }, null, 2) + "\n"
    ),
    writeWorkspaceFile(ctx.workspaceDir, "src/main.js", mainJs),
    writeWorkspaceFile(ctx.workspaceDir, "README.md", `# ${task.task_id}

payload: ${workload}
`)
  ];
  await sleepAbortable(300, ctx.signal);
  ctx.progress(70, "Collecting artifacts");
  const manifest = {
    schema: "build-manifest/1",
    task_id: task.task_id,
    attempt_id: task.attempt_id,
    payload_ref: task.payload_ref,
    built_by: ctx.instanceId,
    files,
    toolchain: {
      runtime: "node",
      version: process.version,
      platform: process.platform,
      arch: process.arch
    }
  };
  const artifact = await ctx.uploadArtifact(JSON.stringify(manifest, null, 2), MEDIA.build);
  return {
    summary: `Build completed ${task.task_id} (${files.length} files)`,
    outputs: {
      artifact_id: artifact.artifact_id,
      sha256: artifact.sha256,
      files: files.map((f) => f.path)
    }
  };
}

// host-runtime/src/roles/chat-console.ts
var ROLE_PERSONA = {
  builder: {
    name: "Tamp",
    duty: "compiling, executing, and in-container forensics",
    line: "Give me a command and I will give you a result that runs."
  },
  scheduler: {
    name: "Relay",
    duty: "queuing, leases, and dispatch",
    line: "No guessing, no grabbing; tasks go to the builder that should run them, by the rules."
  }
};
function chatOf(task) {
  const raw = task.requirements?.chat ?? {};
  const message = typeof raw.message === "string" ? raw.message.slice(0, 4e3) : "";
  const sessionId = typeof raw.session_id === "string" ? raw.session_id.slice(0, 120) : "";
  const history = Array.isArray(raw.history) ? raw.history.filter((h) => !!h && typeof h === "object").slice(-12).map((h) => ({
    role: String(h.role ?? "user").slice(0, 20),
    text: String(h.text ?? "").slice(0, 2e3)
  })) : [];
  return { message, sessionId, history };
}
function chatExecutorFor(role) {
  const persona = ROLE_PERSONA[role] ?? ROLE_PERSONA.builder;
  return async (task, ctx) => {
    const { message, history } = chatOf(task);
    if (!message.trim()) {
      throw new TaskFailed("CHAT_MESSAGE_EMPTY", "Message is empty");
    }
    ctx.progress(30, "Reading role context");
    const lower = message.toLowerCase();
    const agent = task.agent?.profile_id ? `${task.agent.profile_id}${task.agent.version ? `@${task.agent.version}` : ""}` : "no Agent bound";
    let reply;
    if (lower.includes("agent") || message.includes("\u6A21\u578B") || message.includes("\u7ED1\u5B9A")) {
      reply = `I am ${persona.name}. This workstation is bound to ${agent}. I only see this conversation and the history explicitly passed in; I do not read other sessions in the workflow.`;
    } else if (message.includes("\u8FDB\u5EA6") || message.includes("\u72B6\u6001") || message.includes("\u5FD9")) {
      reply = `This message is itself a task.chat.${role} task; check the task center for progress. ${persona.line}`;
    } else if (message.includes("ssh") || message.includes("\u7EC8\u7AEF") || message.includes("shell")) {
      reply = role === "builder" ? "The terminal is full SSH: root login, arbitrary commands, apt and compilation available. The address and port are in the builder details." : "The scheduler does not run builds; it only queues and dispatches. SSH is on the builder.";
    } else if (message.includes("\u78C1\u76D8") || message.includes("\u7A7A\u95F4")) {
      reply = "Run df -h in the terminal to see it; it is recommended to clear the builder artifact directory weekly.";
    } else if (message.includes("\u4F60\u597D") || lower.includes("hello") || lower.includes("hi")) {
      reply = `Hello, I am ${persona.name}, responsible for ${persona.duty}. ${persona.line}`;
    } else {
      reply = `Received. I am ${persona.name}, responsible for ${persona.duty}. No chat-capable model is currently bound, so this is a deterministic reply generated by the platform; once an Agent Profile is configured, the same task will be handed to the designated Agent.`;
    }
    ctx.progress(80, "Generating reply");
    ctx.log(`chat ${task.task_id}: mode=deterministic history=${history.length}`);
    return {
      summary: `${persona.name} reply (deterministic)`,
      outputs: {
        reply,
        mode: "deterministic",
        role,
        task_id: task.task_id,
        agent_profile_id: task.agent?.profile_id ?? null,
        history_turns: history.length
      }
    };
  };
}
function consoleExecutorFor(role) {
  return async (task, ctx) => {
    const raw = task.requirements?.console ?? {};
    const command = typeof raw.command === "string" ? raw.command.slice(0, 4e3) : "";
    const operator = typeof raw.operator === "string" ? raw.operator.slice(0, 80) : "unknown";
    if (!command.trim()) throw new TaskFailed("CONSOLE_COMMAND_EMPTY", "Command is empty");
    const requestedSeconds = Number(raw.timeout_seconds);
    const timeoutMs = Number.isFinite(requestedSeconds) && requestedSeconds > 0 ? Math.min(Math.max(requestedSeconds * 1e3, 5e3), 15 * 6e4) : 6e4;
    ctx.progress(20, "Executing command in the builder");
    const result = await runShell({
      command,
      cwd: ctx.workspaceDir,
      env: baseEnv({
        PLATFORM_INSTANCE_ID: ctx.instanceId,
        PLATFORM_TASK_ID: task.task_id,
        PLATFORM_TASK_TYPE: task.task_type,
        PLATFORM_WORKSPACE: ctx.workspaceDir
      }),
      signal: ctx.signal,
      timeoutMs
    });
    if (ctx.signal.aborted) {
      const reason = ctx.signal.reason;
      throw new TaskAborted(reason === "cancelled" || reason === "shutdown" ? reason : "lease_lost");
    }
    ctx.log(
      `console ${task.task_id}: role=${role} operator=${operator} command=${command.slice(0, 120)} exit=${result.exitCode} duration_ms=${result.durationMs}`
    );
    ctx.progress(100, "Command execution completed");
    return {
      summary: `${command.slice(0, 60)} completed (exit ${result.exitCode})`,
      outputs: {
        stdout: tail(result.stdout, 64 * 1024),
        stderr: tail(result.stderr, 64 * 1024),
        exit_code: result.timedOut ? 124 : result.exitCode,
        duration_ms: result.durationMs,
        command,
        operator,
        role
      }
    };
  };
}

// host-runtime/src/roles/index.ts
var CHAT_ROLES = ["builder", "scheduler"];
var roleExecutors = {
  "task.build": taskBuild,
  // Chat and console are likewise ordinary tasks that are scheduled and audited
  ...Object.fromEntries(CHAT_ROLES.map((role) => [`task.chat.${role}`, chatExecutorFor(role)])),
  ...Object.fromEntries(CHAT_ROLES.map((role) => [`task.console.${role}`, consoleExecutorFor(role)]))
};

// host-runtime/src/executor.ts
var executors = roleExecutors;
var fallback = async (task, ctx) => {
  ctx.progress(50, "generic");
  await sleepAbortable(500, ctx.signal);
  return { summary: `Execution completed ${task.task_id}` };
};
function executorFor(taskType) {
  return executors[taskType] ?? fallback;
}

// host-runtime/src/host-admission-client.ts
import http2 from "node:http";
function call(socketPath, method, path10, body) {
  return new Promise((resolve, reject) => {
    const payload = body === void 0 ? void 0 : Buffer.from(JSON.stringify(body));
    const req = http2.request(
      {
        socketPath,
        method,
        path: path10,
        headers: {
          host: "runtime",
          ...payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}
        },
        timeout: 3e3
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            return reject(new Error(`host admission returned non-JSON: ${text.slice(0, 200)}`));
          }
          if (!res.statusCode || res.statusCode >= 400) {
            const err = data.error ?? {};
            return reject(new Error(`${res.statusCode} ${err.code ?? ""} ${err.message ?? text}`));
          }
          resolve(data);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("host admission timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function checkHostAdmission(socketPath, input) {
  return call(socketPath, "POST", "/admission/check", input);
}
function listHostGrants(socketPath) {
  return call(socketPath, "GET", "/grants");
}
function releaseHostAdmission(socketPath, grantId) {
  return call(socketPath, "POST", "/admission/release", { grant_id: grantId });
}

// host-runtime/src/metrics.ts
import fs3 from "node:fs";
import os from "node:os";
function memAvailableBytes() {
  try {
    const text = fs3.readFileSync("/proc/meminfo", "utf8");
    const line = text.split("\n").find((l) => l.startsWith("MemAvailable:"));
    if (line) return Number(line.replace(/\D+/g, "")) * 1024;
  } catch {
  }
  return os.freemem();
}
function sample() {
  const [load1 = 0] = os.loadavg();
  return {
    cpu_count: os.cpus().length,
    load1: Number(load1.toFixed(2)),
    mem_available_bytes: memAvailableBytes(),
    mem_total_bytes: os.totalmem()
  };
}

// host-runtime/src/agent-runtime/api-adapter.ts
import http3 from "node:http";

// host-runtime/src/agent-runtime/egress.ts
import dns from "node:dns/promises";
import net from "node:net";
var METADATA = /* @__PURE__ */ new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254"
]);
var HOST_SUFFIX_BLOCK = ["metadata.google.internal", "metadata.azure.internal"];
var EgressDenied = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "EgressDenied";
  }
  code;
};
function normalizeHost(host) {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}
function hostAllowed(host, allow) {
  const h = normalizeHost(host);
  return allow.some((rule) => {
    const r = normalizeHost(rule);
    if (r.startsWith("*.")) return h.endsWith(r.slice(1)) && h.length > r.length - 1;
    return h === r;
  });
}
function isBlockedIp(ip, allowLoopback = false) {
  const addr = normalizeHost(ip);
  if (METADATA.has(addr)) return true;
  const family = net.isIP(addr);
  if (family === 4) {
    const [a, b, c] = addr.split(".").map(Number);
    if (a === 0 || a === 127) return !allowLoopback;
    if (a === 169 && b === 254) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    void c;
    return false;
  }
  if (family === 6) {
    if (addr === "::" || addr === "::1") return !allowLoopback;
    if (addr.startsWith("fd") || addr.startsWith("fc")) return true;
    if (/^fe[89ab]/.test(addr)) return true;
    if (addr.startsWith("ff")) return true;
    return false;
  }
  return true;
}
async function assertEgressAllowed(url, policyName, opts) {
  if (!policyName) {
    throw new EgressDenied("EGRESS_POLICY_REQUIRED", "API Profile did not declare an egress policy; denying by default");
  }
  const allow = opts.policies[policyName];
  if (!allow) {
    throw new EgressDenied("EGRESS_POLICY_UNKNOWN", `Unknown egress policy: ${policyName}`);
  }
  const host = normalizeHost(url.hostname);
  if (HOST_SUFFIX_BLOCK.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new EgressDenied("EGRESS_METADATA_BLOCKED", `Access to metadata host is forbidden: ${host}`);
  }
  if (!hostAllowed(host, allow)) {
    throw new EgressDenied("EGRESS_HOST_NOT_ALLOWED", `${host} is not in egress policy ${policyName}`);
  }
  if (url.protocol !== "https:" && !(opts.allowLoopback && url.protocol === "http:")) {
    throw new EgressDenied("EGRESS_SCHEME_DENIED", `Only https egress is allowed: ${url.protocol}`);
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host, opts.allowLoopback)) {
      throw new EgressDenied("EGRESS_IP_BLOCKED", `Target address is not reachable: ${host}`);
    }
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new EgressDenied("EGRESS_DNS_FAILED", `DNS resolution failed: ${host}`);
  }
  if (!addrs.length) throw new EgressDenied("EGRESS_DNS_FAILED", `DNS returned no results: ${host}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address, opts.allowLoopback)) {
      throw new EgressDenied("EGRESS_IP_BLOCKED", `${host} resolves to a blocked address ${a.address}`);
    }
  }
}

// host-runtime/src/agent-runtime/secret-client.ts
var SecretDenied = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SecretDenied";
  }
  code;
};
var SecretClient = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  cache = /* @__PURE__ */ new Map();
  /** The token appears only in the request header; credentials are never echoed in error messages either. */
  authToken() {
    const token = typeof this.opts.token === "function" ? this.opts.token() : this.opts.token;
    if (!token) throw new SecretDenied("SECRET_TOKEN_MISSING", "Instance has no usable identity token");
    return token;
  }
  async resolve(secretRef) {
    const cacheMs = this.opts.cacheMs ?? 0;
    const hit = this.cache.get(secretRef);
    if (cacheMs > 0 && hit && Math.min(hit.expiresAt - 6e4, Date.now() + cacheMs) > Date.now()) {
      return { credential: hit.credential, expiresAt: hit.expiresAt };
    }
    let res;
    try {
      res = await fetch(`${this.opts.url.replace(/\/+$/, "")}/v1/secrets/resolve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.authToken()}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ secret_ref: secretRef }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3e3)
      });
    } catch (e) {
      throw new SecretDenied(
        "SECRET_STORE_UNAVAILABLE",
        `Secret Store is unreachable: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new SecretDenied(
        String(err.code ?? `SECRET_HTTP_${res.status}`),
        String(err.message ?? `Secret Store returned ${res.status}`)
      );
    }
    const credential = String(data.credential ?? "");
    const expiresAt = Date.parse(String(data.expires_at ?? ""));
    if (!credential || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new SecretDenied("SECRET_RESPONSE_INVALID", "Secret Store returned an invalid credential");
    }
    this.cache.set(secretRef, { credential, expiresAt });
    return { credential, expiresAt };
  }
  /** Drop the local cache immediately after revocation/rotation; the next request resolves again. */
  invalidate(secretRef) {
    if (secretRef) this.cache.delete(secretRef);
    else this.cache.clear();
  }
};

// host-runtime/src/agent-runtime/api-adapter.ts
var ApiAdapterError = class extends Error {
  constructor(code, message, status = 502, retryable = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.name = "ApiAdapterError";
  }
  code;
  status;
  retryable;
};
var HOP_HEADERS = /* @__PURE__ */ new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
var ApiAdapter = class {
  constructor(opts) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  opts;
  server;
  quota = /* @__PURE__ */ new Map();
  fetchImpl;
  actualPort = 0;
  get url() {
    return `http://127.0.0.1:${this.actualPort}`;
  }
  get port() {
    return this.actualPort;
  }
  async start() {
    this.server = http3.createServer((req, res) => {
      void this.handleHttp(req, res).catch((e) => {
        const err = e instanceof ApiAdapterError ? e : new ApiAdapterError("API_ADAPTER_INTERNAL", e instanceof Error ? e.message : String(e));
        if (!res.headersSent) {
          res.writeHead(err.status, { "content-type": "application/json", "cache-control": "no-store" });
        }
        res.end(JSON.stringify({ error: { code: err.code, message: err.message } }));
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port ?? 8090, this.opts.host ?? "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    this.actualPort = typeof addr === "object" && addr ? addr.port : 0;
  }
  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = void 0;
  }
  async handleHttp(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = /^\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) {
      throw new ApiAdapterError("API_HANDLE_INVALID", "Path must be /<api_profile>/<path>", 404);
    }
    const profileId = decodeURIComponent(m[1]);
    const rest = m[2] ?? "/";
    const body = await readBody(req, 1024 * 1024);
    const out = await this.call(profileId, req.method ?? "GET", rest, {
      body,
      idempotencyKey: header(req, "idempotency-key"),
      accept: header(req, "accept"),
      contentType: header(req, "content-type"),
      query: url.search
    });
    res.writeHead(out.status, {
      "content-type": out.contentType,
      "cache-control": "no-store",
      ...out.retryAfter ? { "retry-after": out.retryAfter } : {}
    });
    res.end(out.body);
  }
  /**
   * Unified egress entry point. The Agent can only reach external APIs through here; auth headers are injected here,
   * and any authorization / cookie / host supplied by the Agent are discarded.
   */
  async call(profileId, method, path10, init = {}) {
    const primary = this.opts.profiles.get(profileId);
    if (!primary) {
      throw new ApiAdapterError("API_PROFILE_NOT_ALLOWED", `Unbound API Profile: ${profileId}`, 403);
    }
    const chain = [primary, ...(primary.fallback ?? []).map((id) => this.opts.profiles.get(id)).filter((x) => Boolean(x))];
    let last = null;
    for (let i = 0; i < chain.length; i++) {
      const profile = chain[i];
      try {
        const out = await this.once(profile, method, path10, init, i > 0 ? primary.api_profile_id : void 0);
        return out;
      } catch (e) {
        const err = e instanceof ApiAdapterError ? e : new ApiAdapterError("API_ADAPTER_INTERNAL", String(e));
        last = err;
        if (!err.retryable || i === chain.length - 1) break;
        this.audit({
          api_profile_id: profile.api_profile_id,
          method,
          host: safeHost(profile.base_url),
          path: path10,
          status: err.status,
          duration_ms: 0,
          error_code: `FALLBACK:${err.code}`,
          fallback_from: primary.api_profile_id
        });
      }
    }
    throw last ?? new ApiAdapterError("API_ADAPTER_INTERNAL", "No API Profile available");
  }
  async once(profile, method, path10, init, fallbackFrom) {
    const started = Date.now();
    const target = joinUrl(profile.base_url, path10) + (init.query ?? "");
    const url = new URL(target);
    try {
      await assertEgressAllowed(url, profile.egress, this.opts.egress);
    } catch (e) {
      if (e instanceof EgressDenied) {
        throw new ApiAdapterError(e.code, e.message, 403, false);
      }
      throw e;
    }
    const quotaRemaining = this.takeQuota(profile);
    let credential;
    try {
      credential = await this.opts.secretClient.resolve(profile.secret_ref);
    } catch (e) {
      if (e instanceof SecretDenied) {
        throw new ApiAdapterError(e.code, e.message, 502, false);
      }
      throw e;
    }
    const headers = sanitizeHeaders(init.headers ?? {});
    applyAuth(headers, profile, credential.credential);
    if (init.accept) headers.accept = init.accept;
    if (init.contentType) headers["content-type"] = init.contentType;
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
    const idempotent = method === "GET" || method === "HEAD" || Boolean(init.idempotencyKey);
    let attempt = 0;
    while (true) {
      let res;
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? void 0 : init.body,
          redirect: "manual",
          signal: AbortSignal.timeout(profile.timeout_seconds * 1e3)
        });
      } catch (e) {
        if (idempotent && attempt === 0) {
          attempt++;
          continue;
        }
        this.audit({
          api_profile_id: profile.api_profile_id,
          method,
          host: url.hostname,
          path: url.pathname,
          status: 0,
          duration_ms: Date.now() - started,
          quota_remaining: quotaRemaining,
          error_code: "API_NETWORK_ERROR",
          fallback_from: fallbackFrom
        });
        throw new ApiAdapterError("API_NETWORK_ERROR", `External API is unreachable: ${url.hostname}`, 502, true);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (location && method !== "GET" && method !== "HEAD") {
          throw new ApiAdapterError("API_REDIRECT_DENIED", "Redirects are not allowed for non-idempotent requests", 502);
        }
        if (location) {
          const next = new URL(location, url);
          await assertEgressAllowed(next, profile.egress, this.opts.egress);
          this.audit({
            api_profile_id: profile.api_profile_id,
            method,
            host: url.hostname,
            path: url.pathname,
            status: res.status,
            duration_ms: Date.now() - started,
            quota_remaining: quotaRemaining,
            error_code: "API_REDIRECT_REVALIDATED",
            fallback_from: fallbackFrom
          });
          return {
            status: res.status,
            contentType: "application/json",
            body: Buffer.from(
              JSON.stringify({ redirect_to: next.toString(), note: "redirect target validated; re-issue explicitly" })
            )
          };
        }
      }
      if (!res.ok && res.status >= 500 && idempotent && attempt === 0) {
        attempt++;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      this.audit({
        api_profile_id: profile.api_profile_id,
        method,
        host: url.hostname,
        path: url.pathname,
        status: res.status,
        duration_ms: Date.now() - started,
        quota_remaining: quotaRemaining,
        error_code: res.ok ? void 0 : `API_HTTP_${res.status}`,
        fallback_from: fallbackFrom
      });
      if (!res.ok && res.status >= 500) {
        throw new ApiAdapterError(`API_HTTP_${res.status}`, `External API returned ${res.status}`, 502, true);
      }
      return {
        status: res.status,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
        body: buf
      };
    }
  }
  takeQuota(profile) {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    let state = this.quota.get(profile.api_profile_id);
    if (!state || state.day !== day) {
      state = { window: [], day, dayCount: 0 };
      this.quota.set(profile.api_profile_id, state);
    }
    state.window = state.window.filter((t) => now - t < 6e4);
    if (profile.quota.rpm && state.window.length >= profile.quota.rpm) {
      throw new ApiAdapterError("API_QUOTA_EXCEEDED", "Request exceeds the rpm quota", 429, false);
    }
    if (profile.quota.daily_calls && state.dayCount >= profile.quota.daily_calls) {
      throw new ApiAdapterError("API_QUOTA_EXCEEDED", "Request exceeds the daily quota", 429, false);
    }
    state.window.push(now);
    state.dayCount++;
    if (profile.quota.rpm) return Math.max(0, profile.quota.rpm - state.window.length);
    if (profile.quota.daily_calls) return Math.max(0, profile.quota.daily_calls - state.dayCount);
    return void 0;
  }
  audit(r) {
    try {
      this.opts.audit?.({
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        instance_id: this.opts.instanceId,
        ...r
      });
    } catch {
    }
  }
};
function joinUrl(base, path10) {
  return `${base.replace(/\/+$/, "")}/${path10.replace(/^\/+/, "")}`;
}
function sanitizeHeaders(input) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const key = k.toLowerCase();
    if (HOP_HEADERS.has(key) || ["authorization", "cookie", "host", "x-api-key"].includes(key)) continue;
    out[key] = v;
  }
  return out;
}
function applyAuth(headers, profile, credential) {
  if (profile.auth_type === "bearer") headers.authorization = `Bearer ${credential}`;
  else if (profile.auth_type === "api_key") headers["x-api-key"] = credential;
  else {
    throw new ApiAdapterError(
      "API_AUTH_TYPE_UNSUPPORTED",
      `Reference implementation does not support ${profile.auth_type}; failing closed`,
      502
    );
  }
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new ApiAdapterError("API_BODY_TOO_LARGE", "Request body exceeds 1MiB", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return "(invalid)";
  }
}

// host-runtime/src/agent-runtime/agent-executor.ts
import { randomBytes } from "node:crypto";
import fs5 from "node:fs";
import path5 from "node:path";

// host-runtime/src/agent-runtime/stdio-adapter.ts
import { spawn as spawn2 } from "node:child_process";
import path3 from "node:path";
import readline from "node:readline";
var AdapterCrash = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "AdapterCrash";
  }
  code;
};
var StdioAdapter = class {
  constructor(profile, workspace, env, hooks) {
    this.profile = profile;
    this.workspace = workspace;
    this.env = env;
    this.hooks = hooks;
  }
  profile;
  workspace;
  env;
  hooks;
  child;
  seq = 0;
  pending = /* @__PURE__ */ new Map();
  events = [];
  resultNotify = null;
  resultWaiter;
  closed = false;
  lastProgress = -1;
  /**
   * In native mode, Agent Profiles still write /opt/platform/... as container paths;
   * this maps them to the instance directory, so a Profile does not need a separate copy for each execution mode.
   */
  nativePath(value) {
    const root = process.env.PLATFORM_NATIVE_ROOT;
    if (!root || !value.startsWith("/opt/platform/")) return value;
    return path3.join(root, value.slice("/opt/platform/".length));
  }
  async start() {
    const [rawCmd, ...baseArgs] = this.profile.entrypoint;
    if (!rawCmd) throw new AdapterCrash("AGENT_PROFILE_INVALID", "Agent Profile is missing entrypoint");
    const cmd = this.nativePath(rawCmd);
    const args = [...baseArgs.map((a) => this.nativePath(a)), ...(this.profile.args ?? []).map((a) => this.nativePath(a))];
    this.child = spawn2(cmd, args, {
      cwd: this.workspace,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    readline.createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.hooks.onLog(`[adapter] ${redact(line)}`.slice(0, 2e3));
    });
    this.child.on("error", (e) => this.failAll(new AdapterCrash("AGENT_CRASHED", e.message)));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      const msg = `Adapter exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.failAll(new AdapterCrash("AGENT_CRASHED", msg));
    });
    await this.request("agent.health", {}, 5e3);
  }
  onLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.hooks.onLog(`[adapter-stdout] ${redact(text).slice(0, 2e3)}`);
      return;
    }
    if (msg.method === "agent.event") {
      this.handleEvent(msg.params ?? {});
      return;
    }
    if (msg.method === "agent.result") {
      const result = msg.params;
      this.resultNotify = result;
      this.resultWaiter?.(result);
      return;
    }
    if (msg.method === "tool.call" && msg.id !== void 0) {
      void this.handleToolRequest(msg);
      return;
    }
    if (msg.id !== void 0) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(
          new AdapterCrash(
            String(msg.error.code ?? "AGENT_RPC_ERROR"),
            String(msg.error.message ?? "Adapter returned an error")
          )
        );
      } else {
        p.resolve(msg.result);
      }
    }
  }
  handleEvent(params) {
    const type = String(params.type ?? "");
    if (type === "progress") {
      let percent = Number(params.percent);
      if (!Number.isFinite(percent)) percent = 0;
      percent = Math.max(this.lastProgress, Math.min(100, Math.max(0, percent)));
      this.lastProgress = percent;
      this.events.push({ type, percent, phase: params.phase });
      this.hooks.onEvent({ type, percent, phase: params.phase });
      return;
    }
    if (type === "log") {
      this.hooks.onEvent({ type, level: params.level, message: params.message });
      return;
    }
    if (type === "artifact") {
      this.hooks.onEvent({ type, name: params.name, path: params.path });
      return;
    }
    this.hooks.onLog(`Unknown agent.event type: ${type}`);
  }
  async handleToolRequest(msg) {
    try {
      const result = await this.hooks.onToolCall(msg.params);
      this.write({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      this.write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32001,
          message: String(e?.code ?? "TOOL_DENIED"),
          data: { code: e?.code, step: e?.step, message: e?.message }
        }
      });
    }
  }
  request(method, params, timeoutMs) {
    if (this.closed) {
      return Promise.reject(new AdapterCrash("AGENT_CRASHED", "Adapter has exited"));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterCrash("AGENT_TIMEOUT", `${method} timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  async prepare(params, timeoutMs) {
    return this.request("agent.prepare", params, timeoutMs);
  }
  async execute(params, timeoutMs) {
    this.resultNotify = null;
    const waitResult = new Promise((resolve) => {
      this.resultWaiter = resolve;
    });
    const response = this.request("agent.execute", params, timeoutMs).catch((e) => {
      if (this.resultNotify) return null;
      throw e;
    });
    return Promise.race([
      waitResult,
      response.then((r) => r ?? waitResult)
    ]);
  }
  async cancel(reason) {
    if (this.closed) return;
    try {
      await this.request("agent.cancel", { reason }, 1500);
    } catch {
    }
    this.kill();
  }
  kill() {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AdapterCrash("AGENT_CANCELLED", "Adapter has stopped"));
    }
    this.pending.clear();
    if (this.child && !this.child.killed) this.child.kill("SIGKILL");
  }
  failAll(e) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.resultWaiter?.({ status: "FAILED", error: { code: "AGENT_CRASHED", message: e.message } });
  }
  write(msg) {
    if (!this.child || this.closed) return;
    this.child.stdin.write(`${JSON.stringify(msg)}
`);
  }
};
function redact(line) {
  return line.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>").replace(/((?:secret|token|password|passwd|api[_-]?key)\s*[=:]\s*)[^\s,"'}]+/gi, "$1<redacted>").replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>");
}

// host-runtime/src/agent-runtime/http-local-adapter.ts
var HttpLocalAdapter = class {
  constructor(profile, hooks) {
    this.profile = profile;
    this.hooks = hooks;
  }
  profile;
  hooks;
  seq = 0;
  closed = false;
  get base() {
    const u = this.profile.entrypoint[0];
    if (!u || !/^https?:\/\//.test(u)) {
      throw new AdapterCrash("AGENT_PROFILE_INVALID", "http-local requires entrypoint[0] = http://127.0.0.1:<port>");
    }
    return u.replace(/\/+$/, "");
  }
  async start() {
    await this.request("agent.health", {}, 5e3);
  }
  async request(method, params, timeoutMs) {
    if (this.closed) throw new AdapterCrash("AGENT_CRASHED", "Adapter has exited");
    const id = ++this.seq;
    let res;
    try {
      res = await fetch(this.base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      throw new AdapterCrash("AGENT_CRASHED", `Adapter unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new AdapterCrash("AGENT_CRASHED", `Adapter HTTP ${res.status}`);
    for (const ev of data.events ?? []) this.hooks.onEvent(ev);
    if (data.error) {
      throw new AdapterCrash(String(data.error.code ?? "AGENT_RPC_ERROR"), String(data.error.message ?? "Adapter error"));
    }
    return data.result;
  }
  prepare(params, timeoutMs) {
    return this.request("agent.prepare", params, timeoutMs);
  }
  async execute(params, timeoutMs) {
    const out = await this.request("agent.execute", params, timeoutMs);
    return out;
  }
  async cancel(reason) {
    if (this.closed) return;
    try {
      await this.request("agent.cancel", { reason }, 1500);
    } catch {
    }
    this.closed = true;
  }
  kill() {
    this.closed = true;
  }
};

// host-runtime/src/agent-runtime/tool-policy.ts
import { createHash as createHash2, timingSafeEqual } from "node:crypto";
import fs4 from "node:fs";
import path4 from "node:path";

// host-runtime/src/agent-runtime/types.ts
var TOOL_CATALOG = {
  "demo.echo": { tool_id: "demo.echo", phases: [], action_scopes: [], egress: false },
  "workspace.write": { tool_id: "workspace.write", phases: [], action_scopes: [], egress: false },
  "workspace.read": { tool_id: "workspace.read", phases: [], action_scopes: [], egress: false },
  "api.call": { tool_id: "api.call", phases: [], action_scopes: [], egress: true }
};

// host-runtime/src/agent-runtime/tool-policy.ts
var ToolDenied = class extends Error {
  constructor(code, message, step) {
    super(message);
    this.code = code;
    this.step = step;
    this.name = "ToolDenied";
  }
  code;
  step;
};
var ToolGuard = class {
  constructor(opts) {
    this.opts = opts;
    if (!opts.toolToken) throw new Error("ToolGuard requires a tool_token for each attempt");
  }
  opts;
  turns = 0;
  seen = /* @__PURE__ */ new Map();
  get turnsUsed() {
    return this.turns;
  }
  async call(raw) {
    const started = Date.now();
    let input = null;
    const deny = (code, message, step) => {
      const err = new ToolDenied(code, message, step);
      this.record({
        tool_id: input?.tool_id ?? "(invalid)",
        decision: "DENY",
        code,
        step,
        args_sha256: input ? sha256(stable(input.args)) : void 0,
        duration_ms: Date.now() - started
      });
      return err;
    };
    try {
      input = parseCall(raw);
      if (!sameToken(input.tool_token, this.opts.toolToken)) {
        throw deny("TOOL_IDENTITY_MISMATCH", "tool_token does not match the current attempt", 1);
      }
      this.turns++;
      if (this.opts.maxTurns !== void 0 && this.turns > this.opts.maxTurns) {
        throw deny("TOOL_TURN_LIMIT", `Tool calls exceeded max_turns=${this.opts.maxTurns}`, 1);
      }
      const allowed = this.opts.profile.allowed_tools.filter((id) => TOOL_CATALOG[id]);
      if (allowed.length > 0 && !allowed.includes(input.tool_id)) {
        throw deny("TOOL_NOT_ALLOWED", `Agent Profile does not allow tool ${input.tool_id}`, 2);
      }
      const descriptor = TOOL_CATALOG[input.tool_id];
      if (!descriptor) {
        throw deny("TOOL_UNKNOWN", `Tool is not registered in the platform catalog: ${input.tool_id}`, 2);
      }
      if (descriptor.phases.length && !descriptor.phases.includes(this.opts.phase)) {
        throw deny(
          "TOOL_PHASE_DENIED",
          `Phase ${this.opts.phase} does not allow tool ${input.tool_id}`,
          3
        );
      }
      validateArgs(input.tool_id, input.args, this.opts.workspace);
      for (const scope of descriptor.action_scopes) {
        if (!this.opts.approvedActionScope.includes(scope)) {
          throw deny("TOOL_SCOPE_DENIED", `Missing approved action_scope: ${scope}`, 5);
        }
      }
      if (descriptor.egress) {
        const apiId = String(input.args.api_profile_id ?? "");
        if (!this.opts.apiProfiles.has(apiId)) {
          throw deny("API_PROFILE_NOT_ALLOWED", `API ${apiId} is not bound to the instance`, 5);
        }
      }
      const argsHash = sha256(stable(input.args));
      if (input.idempotency_key) {
        const prev = this.seen.get(input.idempotency_key);
        if (prev) {
          if (prev.hash !== argsHash) {
            throw deny("TOOL_IDEMPOTENCY_CONFLICT", "The same idempotency key was used with different arguments", 6);
          }
          this.record({
            tool_id: input.tool_id,
            decision: "ALLOW",
            args_sha256: argsHash,
            result_sha256: sha256(stable(prev.result)),
            duration_ms: Date.now() - started
          });
          return prev.result;
        }
      }
      const result = await this.execute(input);
      if (input.idempotency_key) {
        this.seen.set(input.idempotency_key, { hash: argsHash, result });
      }
      this.record({
        tool_id: input.tool_id,
        decision: "ALLOW",
        args_sha256: argsHash,
        result_sha256: sha256(stable(result)),
        duration_ms: Date.now() - started
      });
      return result;
    } catch (e) {
      if (e instanceof ToolDenied) throw e;
      const rawCode = e?.code;
      const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(rawCode) ? rawCode : "TOOL_EXECUTION_FAILED";
      const message = e instanceof Error ? e.message : String(e);
      this.record({
        tool_id: input?.tool_id ?? "(invalid)",
        decision: "DENY",
        code,
        step: 7,
        duration_ms: Date.now() - started
      });
      throw new ToolDenied(code, message, 7);
    }
  }
  async execute(input) {
    const args = input.args;
    if (input.tool_id === "demo.echo") {
      return { echo: String(args.text ?? ""), tool: "demo.echo" };
    }
    if (input.tool_id === "workspace.write") {
      const rel = normalizeRel(String(args.path ?? ""));
      const file = path4.join(this.opts.workspace, rel);
      fs4.mkdirSync(path4.dirname(file), { recursive: true });
      fs4.writeFileSync(file, String(args.content ?? ""), "utf8");
      return { path: rel, bytes: Buffer.byteLength(String(args.content ?? "")) };
    }
    if (input.tool_id === "workspace.read") {
      const rel = normalizeRel(String(args.path ?? ""));
      const file = path4.join(this.opts.workspace, rel);
      if (!fs4.existsSync(file)) throw new Error(`File does not exist: ${rel}`);
      return { path: rel, content: fs4.readFileSync(file, "utf8") };
    }
    if (input.tool_id === "api.call") {
      if (!this.opts.apiCall) throw new Error("API Adapter is not started");
      return this.opts.apiCall({
        api_profile_id: String(args.api_profile_id),
        method: String(args.method ?? "GET").toUpperCase(),
        path: String(args.path ?? "/"),
        body: args.body === void 0 ? void 0 : String(args.body),
        scope: args.scope === void 0 ? void 0 : String(args.scope)
      });
    }
    throw new Error(`Tool is not implemented: ${input.tool_id}`);
  }
  record(r) {
    try {
      this.opts.audit({
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        instance_id: this.opts.instanceId,
        attempt_id: this.opts.attemptId,
        task_id: this.opts.taskId,
        ...r
      });
    } catch {
    }
  }
};
function parseCall(raw) {
  if (!raw || typeof raw !== "object") throw new ToolDenied("TOOL_INPUT_INVALID", "Tool arguments must be an object", 1);
  const o = raw;
  if (typeof o.tool_id !== "string" || !o.tool_id) {
    throw new ToolDenied("TOOL_INPUT_INVALID", "Missing tool_id", 1);
  }
  if (!o.args || typeof o.args !== "object" || Array.isArray(o.args)) {
    throw new ToolDenied("TOOL_INPUT_INVALID", "args must be an object", 1);
  }
  if (typeof o.tool_token !== "string") {
    throw new ToolDenied("TOOL_IDENTITY_MISMATCH", "Missing tool_token", 1);
  }
  return {
    tool_id: o.tool_id,
    args: o.args,
    tool_token: o.tool_token,
    idempotency_key: typeof o.idempotency_key === "string" ? o.idempotency_key : void 0
  };
}
function validateArgs(toolId, args, workspace) {
  const fail = (m) => {
    throw new ToolDenied("TOOL_INPUT_INVALID", m, 4);
  };
  if (toolId === "demo.echo") {
    if (typeof args.text !== "string" || args.text.length > 2e3) fail("demo.echo.text must be a string of at most 2000 characters");
    return;
  }
  if (toolId === "workspace.write") {
    if (typeof args.path !== "string" || typeof args.content !== "string") fail("workspace.write requires path/content");
    if (args.content.length > 1024 * 1024) fail("Written content exceeds 1MiB");
    assertInsideWorkspace(args.path, workspace);
    return;
  }
  if (toolId === "workspace.read") {
    if (typeof args.path !== "string") fail("workspace.read requires path");
    assertInsideWorkspace(args.path, workspace);
    return;
  }
  if (toolId === "api.call") {
    if (typeof args.api_profile_id !== "string" || !args.api_profile_id) fail("api_profile_id is required");
    const method = String(args.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) fail(`method not allowed: ${method}`);
    if (typeof args.path !== "string" || !args.path.startsWith("/") || args.path.length > 512) {
      fail("path must be a relative path starting with /");
    }
    const p = args.path;
    if (p.includes("..") || p.includes("//") || p.includes("\\") || /[\r\n]/.test(p)) fail("path contains an illegal segment");
    if (args.body !== void 0 && String(args.body).length > 64 * 1024) fail("body exceeds 64KiB");
    if (args.scope !== void 0 && typeof args.scope !== "string") fail("scope must be a string");
    return;
  }
  fail(`No argument validation rule for tool: ${toolId}`);
}
function assertInsideWorkspace(rel, workspace) {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) {
    throw new ToolDenied("WORKSPACE_PATH_DENIED", `Path must be inside the workspace: ${rel}`, 4);
  }
  const root = path4.resolve(workspace);
  const target = path4.resolve(root, rel);
  if (target !== root && !target.startsWith(`${root}${path4.sep}`)) {
    throw new ToolDenied("WORKSPACE_PATH_DENIED", `Path escapes the workspace: ${rel}`, 4);
  }
}
function normalizeRel(rel) {
  return rel.replace(/^\.\/+/, "");
}
function sameToken(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const o = value;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}
function sha256(s) {
  return `sha256:${createHash2("sha256").update(s).digest("hex")}`;
}

// host-runtime/src/agent-runtime/agent-executor.ts
function phaseFor(taskType) {
  if (taskType === "task.build") return "EXECUTE";
  if (taskType === "task.review.snapshot") return "REVIEW";
  if (taskType === "task.commit") return "COMMIT";
  if (taskType === "task.test.run") return "VERIFY";
  if (taskType.startsWith("task.ticket.")) return taskType.split(".")[2].toUpperCase();
  return "EXECUTE";
}
function mediaFor(file) {
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".patch") || file.endsWith(".diff")) return "text/x-patch";
  if (file.endsWith(".md")) return "text/markdown";
  if (file.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}
function sanitizedTask(task) {
  return {
    task_id: task.task_id,
    task_type: task.task_type,
    attempt_id: task.attempt_id,
    payload_ref: task.payload_ref,
    payload_schema: task.payload_schema,
    requirements: task.requirements,
    deadline_at: task.deadline_at
  };
}
var MAX_ATTACHMENT_FILES = 16;
var MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
var MAX_ATTACHMENT_TOTAL_BYTES = 128 * 1024 * 1024;
function attachmentName(raw, index) {
  const source = typeof raw === "string" ? raw.replace(/\\/g, "/") : "";
  const base = path5.basename(source).replace(/[^\p{L}\p{N}._()\- ]/gu, "_").trim().slice(0, 120);
  const name = base && base !== "." && base !== ".." ? base : `attachment-${index + 1}`;
  return name.startsWith(".") ? `_${name}` : name;
}
async function loadAttachment(rec) {
  let data = String(rec.data_base64 ?? "");
  const comma = data.indexOf(",");
  if (data.startsWith("data:") && comma >= 0) data = data.slice(comma + 1);
  if (data) {
    const buf2 = Buffer.from(data, "base64");
    return buf2.length ? buf2 : null;
  }
  const rawUrl = typeof rec.url === "string" ? rec.url.trim() : "";
  if (!rawUrl) return null;
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new TaskFailed("ATTACHMENT_URL_INVALID", "Invalid attachment URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TaskFailed("ATTACHMENT_URL_INVALID", "Attachment URL must use http or https");
  }
  let res;
  try {
    res = await fetch(target, {
      signal: AbortSignal.timeout(12e4),
      redirect: "error"
    });
  } catch (err) {
    throw new TaskFailed(
      "ATTACHMENT_FETCH_FAILED",
      `Failed to fetch attachment: ${String(err?.message ?? err)}`
    );
  }
  if (!res.ok) {
    throw new TaskFailed("ATTACHMENT_FETCH_FAILED", `Failed to fetch attachment: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length ? buf : null;
}
async function materializeAttachments(task, workspaceDir) {
  const requirements = task.requirements ?? {};
  const build = requirements.build;
  if (!build || typeof build !== "object") return task;
  const list = build.attachments;
  if (!Array.isArray(list) || list.length === 0) return task;
  const dir = path5.join(workspaceDir, "attachments");
  fs5.mkdirSync(dir, { recursive: true });
  const materialized = [];
  const used = /* @__PURE__ */ new Set();
  let total = 0;
  for (let i = 0; i < list.length && materialized.length < MAX_ATTACHMENT_FILES; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") continue;
    const rec = item;
    const buf = await loadAttachment(rec);
    if (!buf) continue;
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      throw new TaskFailed("ATTACHMENT_TOO_LARGE", "Attachment exceeds 32MiB");
    }
    total += buf.length;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) break;
    let name = attachmentName(rec.name, i);
    if (used.has(name)) {
      const ext = path5.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n++;
      name = `${stem}-${n}${ext}`;
    }
    const file = path5.join(dir, name);
    if (!file.startsWith(dir + path5.sep)) continue;
    used.add(name);
    fs5.writeFileSync(file, buf, { mode: 384 });
    materialized.push({
      name,
      path: `attachments/${name}`,
      media_type: typeof rec.media_type === "string" ? rec.media_type : "application/octet-stream",
      size_bytes: buf.length
    });
  }
  const nextBuild = { ...build, attachments: materialized };
  return { ...task, requirements: { ...requirements, build: nextBuild } };
}
function agentPassEnv() {
  return (process.env.PLATFORM_AGENT_PASS_ENV ?? "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
}
function apiHandles(profiles, adapter) {
  return [...profiles.api.values()].map((p) => ({
    api_profile_id: p.api_profile_id,
    kind: p.kind,
    // The Agent only gets the local proxy handle, not a base_url, and certainly not a secret
    handle: adapter ? `${adapter.url}/${encodeURIComponent(p.api_profile_id)}` : null,
    scopes: p.scopes
  }));
}
async function runAgentTask(task, ctx, opts) {
  const profile = opts.profiles.agent;
  const toolToken = randomBytes(24).toString("base64url");
  const phase = phaseFor(task.task_type);
  const start = Date.now();
  const maxWall = opts.maxWallSeconds ?? profile.limits?.max_wall_seconds ?? 3600;
  const deadline = task.deadline_at ? Date.parse(task.deadline_at) : Number.NaN;
  const remaining = Number.isFinite(deadline) ? Math.max(1, Math.floor((deadline - Date.now()) / 1e3)) : maxWall;
  const wallSeconds = Math.max(1, Math.min(maxWall, remaining));
  const maxTurns = profile.limits?.max_turns;
  const guard = new ToolGuard({
    instanceId: ctx.instanceId,
    attemptId: task.attempt_id,
    taskId: task.task_id,
    workspace: ctx.workspaceDir,
    profile,
    apiProfiles: opts.profiles.api,
    phase,
    approvedActionScope: Array.isArray(task.requirements?.approved_action_scope) ? task.requirements.approved_action_scope : [],
    toolToken,
    audit: opts.toolAudit,
    maxTurns,
    apiCall: opts.apiAdapter ? async (input) => {
      const out = await opts.apiAdapter.call(input.api_profile_id, input.method, input.path, {
        body: input.body
      });
      return {
        untrusted: true,
        status: out.status,
        content_type: out.contentType,
        body: out.body.toString("utf8").slice(0, 64 * 1024)
      };
    } : void 0
  });
  const events = [];
  const artifactPaths = [];
  let artifactError = null;
  const hooks = {
    onEvent: (e) => {
      events.push(e);
      if (e.type === "progress" && typeof e.percent === "number") {
        ctx.progress(e.percent, e.phase);
      } else if (e.type === "log") {
        ctx.log(`agent: ${redact(String(e.message ?? "")).slice(0, 2e3)}`);
      } else if (e.type === "artifact") {
        const p = String(e.path ?? "");
        try {
          assertInsideWorkspace(p.replace(/^\.\/+/, ""), ctx.workspaceDir);
          artifactPaths.push({ name: String(e.name ?? "artifact"), path: p });
        } catch (err) {
          artifactError = new TaskFailed(
            "ARTIFACT_PATH_DENIED",
            String(err?.message ?? "Artifact path is outside the workspace")
          );
        }
      }
    },
    onLog: (line) => ctx.log(redact(line).slice(0, 2e3)),
    onToolCall: (params) => guard.call(params)
  };
  const env = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: ctx.workspaceDir,
    TMPDIR: ctx.workspaceDir,
    PLATFORM_INSTANCE_ID: ctx.instanceId,
    PLATFORM_ATTEMPT_ID: task.attempt_id,
    PLATFORM_TASK_ID: task.task_id,
    PLATFORM_TASK_TYPE: task.task_type,
    PLATFORM_WORKSPACE: ctx.workspaceDir,
    PLATFORM_TOOL_TOKEN: toolToken,
    PLATFORM_PHASE: phase,
    PLATFORM_DEADLINE: task.deadline_at ?? "",
    PLATFORM_API_PROFILES: JSON.stringify(apiHandles(opts.profiles, opts.apiAdapter)),
    // The Agent's persona config; contains no secrets, for the adapter to assemble into the prompt.
    PLATFORM_AGENT_PROFILE: JSON.stringify({
      name: profile.name,
      role_id: profile.role_id,
      description: profile.description ?? "",
      system_prompt: profile.system_prompt ?? "",
      persona: profile.persona ?? "",
      tone: profile.tone ?? "",
      goals: profile.goals ?? ""
    })
  };
  if (opts.apiAdapter) env.PLATFORM_API_PROXY = opts.apiAdapter.url;
  for (const name of agentPassEnv()) {
    if (name.startsWith("PLATFORM_")) continue;
    if (process.env[name] !== void 0) env[name] = process.env[name];
  }
  const adapter = profile.adapter === "http-local" ? new HttpLocalAdapter(profile, hooks) : new StdioAdapter(profile, ctx.workspaceDir, env, hooks);
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void adapter.cancel(String(ctx.signal.reason ?? "cancelled"));
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const agentTask = await materializeAttachments(task, ctx.workspaceDir);
  if (agentTask !== task) {
    const count = agentTask.requirements.build.attachments;
    ctx.log(`Wrote ${count.length} attachments to workspace attachments/`);
  }
  try {
    await adapter.start();
    const prepared = await adapter.prepare(
      {
        task: sanitizedTask(agentTask),
        workspace: ctx.workspaceDir,
        api_profiles: apiHandles(opts.profiles, opts.apiAdapter),
        deadline: task.deadline_at
      },
      1e4
    );
    if (aborted) throw new TaskAborted(ctx.signal.reason === "lease_lost" ? "lease_lost" : "cancelled");
    if (!prepared || prepared.ready !== true) {
      throw new TaskFailed("AGENT_NOT_READY", "Agent prepare is not ready", prepared);
    }
    const result = await adapter.execute(
      { task: sanitizedTask(agentTask), workspace: ctx.workspaceDir },
      wallSeconds * 1e3
    );
    if (aborted) throw new TaskAborted(ctx.signal.reason === "lease_lost" ? "lease_lost" : "cancelled");
    if (artifactError) throw artifactError;
    if (!result || result.status === "FAILED") {
      throw new TaskFailed(
        String(result?.error?.code ?? "AGENT_FAILED"),
        String(result?.error?.message ?? result?.summary ?? "Agent returned a failure")
      );
    }
    const outputs = [];
    for (const out of result.outputs ?? []) {
      const rel = out.path.replace(/^\.\/+/, "");
      assertInsideWorkspace(rel, ctx.workspaceDir);
      const file = path5.join(ctx.workspaceDir, rel);
      if (!fs5.existsSync(file)) {
        throw new TaskFailed("AGENT_OUTPUT_MISSING", `Artifact declared by the Agent does not exist: ${rel}`);
      }
      const uploaded = await ctx.uploadArtifact(fs5.readFileSync(file), mediaFor(rel));
      outputs.push({ name: out.name, ...uploaded });
    }
    for (const e of artifactPaths) {
      if (!outputs.some((o) => o.name === e.name)) {
        ctx.log(`Agent event declared artifact ${e.name} but it was not returned in the final result; ignored`);
      }
    }
    const outputsPayload = {
      agent_profile_id: profile.agent_profile_id,
      agent_version: profile.version,
      adapter: profile.adapter,
      tool_calls: {
        used: guard.turnsUsed
      },
      artifacts: outputs,
      metrics: result.metrics ?? {},
      duration_ms: Date.now() - start,
      log_events: events.filter((e) => e.type === "log").length
    };
    if (task.task_type.startsWith("task.chat.")) {
      outputsPayload.reply = String(result.reply ?? result.summary ?? "");
      outputsPayload.mode = "agent";
    }
    return {
      summary: String(result.summary ?? `Agent ${profile.agent_profile_id} execution completed`),
      outputs: outputsPayload
    };
  } catch (e) {
    if (e instanceof TaskAborted || e instanceof TaskFailed) throw e;
    if (e instanceof ToolDenied) {
      throw new TaskFailed(e.code, e.message, { step: e.step });
    }
    if (e instanceof AdapterCrash) {
      if (aborted) throw new TaskAborted(ctx.signal.reason === "lease_lost" ? "lease_lost" : "cancelled");
      throw new TaskFailed(e.code, e.message);
    }
    throw new TaskFailed("AGENT_ERROR", e instanceof Error ? e.message : String(e));
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    adapter.kill();
  }
}

// host-runtime/src/agent-runtime/profiles.ts
import fs6 from "node:fs";
import path6 from "node:path";
var ADAPTERS = {
  builder: ["stdio-jsonrpc", "http-local"],
  scheduler: ["stdio-jsonrpc", "http-local"]
};
var ProfileRejected = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ProfileRejected";
  }
  code;
};
function loadProfilesFile(file) {
  const abs = path6.resolve(file);
  if (!fs6.existsSync(abs)) {
    throw new Error(`Profile file not found: ${abs}`);
  }
  const raw = JSON.parse(fs6.readFileSync(abs, "utf8"));
  return raw;
}
function resolveInstanceProfiles(file, instance) {
  const agentId = instance.agent_profile_id;
  if (!agentId) throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", "Instance has no Agent Profile bound");
  const agent = (file.agent_profiles ?? []).find((p) => p.agent_profile_id === agentId);
  if (!agent) {
    throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", `Profile file does not contain ${agentId}`);
  }
  if (agent.enabled === false) {
    throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", `Agent Profile is disabled: ${agentId}`);
  }
  if (agent.role_id !== instance.role_id) {
    throw new ProfileRejected(
      "AGENT_PROFILE_NOT_ALLOWED",
      `Agent Profile belongs to ${agent.role_id}, but the instance role is ${instance.role_id}`
    );
  }
  const allowed = ADAPTERS[instance.role_id];
  if (!allowed || !allowed.includes(agent.adapter)) {
    throw new ProfileRejected(
      "ADAPTER_NOT_ALLOWED",
      `Role ${instance.role_id} does not allow ${agent.adapter}`
    );
  }
  const binding = file.bindings?.[instance.instance_id];
  if (binding) {
    if (binding.agent_profile_id !== agentId) {
      throw new ProfileRejected(
        "AGENT_PROFILE_NOT_ALLOWED",
        `Instance-configured Agent ${agentId} does not match the PCS binding ${binding.agent_profile_id}`
      );
    }
    const configured = new Set(instance.api_profile_ids ?? []);
    for (const id of binding.api_profile_ids ?? []) {
      if (!configured.has(id)) {
        throw new ProfileRejected(
          "API_PROFILE_NOT_ALLOWED",
          `PCS bound ${id}, but the instance startup config did not load it`
        );
      }
    }
    if (configured.size !== new Set(binding.api_profile_ids ?? []).size) {
      throw new ProfileRejected(
        "API_PROFILE_NOT_ALLOWED",
        "Instance loaded an API Profile that PCS has not bound"
      );
    }
  }
  const api = /* @__PURE__ */ new Map();
  for (const id of instance.api_profile_ids ?? []) {
    const p = (file.api_profiles ?? []).find((x) => x.api_profile_id === id);
    if (!p) throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `Profile file does not contain API ${id}`);
    if (p.enabled === false) {
      throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `API Profile is disabled: ${id}`);
    }
    api.set(id, p);
  }
  const declared = [
    ...agent.model_api_profile_id ? [agent.model_api_profile_id] : [],
    ...agent.tool_api_profile_ids ?? []
  ];
  for (const id of declared) {
    if (!api.has(id)) {
      throw new ProfileRejected(
        "API_PROFILE_NOT_ALLOWED",
        `Agent Profile references an unbound API: ${id}`
      );
    }
  }
  return { agent, api, boundApiIds: new Set(api.keys()) };
}
function assertEnvelopeAllowed(profiles, envelope) {
  if (!envelope.agent || envelope.agent.profile_id !== profiles.agent.agent_profile_id) {
    throw new ProfileRejected(
      "AGENT_PROFILE_NOT_ALLOWED",
      `Task specifies Agent ${envelope.agent?.profile_id ?? "(empty)"}, but the instance is bound to ${profiles.agent.agent_profile_id}`
    );
  }
  if (envelope.agent.version !== null && envelope.agent.version !== void 0 && envelope.agent.version !== profiles.agent.version) {
    throw new ProfileRejected(
      "AGENT_PROFILE_NOT_ALLOWED",
      `Task specifies version ${envelope.agent.version}, but the instance loaded ${profiles.agent.version}`
    );
  }
  for (const id of envelope.api_profiles ?? []) {
    if (!profiles.boundApiIds.has(id)) {
      throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `Task references an unbound API ${id}`);
    }
  }
}
function supportsTask(agent, taskType) {
  return agent.task_types.includes(taskType);
}

// host-runtime/src/agent.ts
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var Agent = class {
  constructor(cfg2, client, tuning) {
    this.cfg = cfg2;
    this.client = client;
    this.tuning = tuning;
    this.id = cfg2.instance_id;
    this.slots = cfg2.slots ?? 1;
    this.slotMemoryBytes = cfg2.slot_memory_bytes ?? 1024 ** 3;
    this.admission = new LocalAdmission(memAvailableBytes, this.slotMemoryBytes);
  }
  cfg;
  client;
  tuning;
  id;
  slots;
  slotMemoryBytes;
  admission;
  running = /* @__PURE__ */ new Map();
  draining = false;
  hbTimer;
  configVersion;
  admissionBackoffUntil = 0;
  apiAdapter;
  secretClient;
  /**
   * Startup reconciliation: if the previous process was killed without a chance to release, residual TASK grants
   * under this instance name keep holding memory until the TTL. After a restart, clear them by instance_id first to restore the real headroom.
   */
  async reconcileHostGrants() {
    const socket = this.tuning.hostAdmissionSocket;
    if (!socket) return;
    try {
      const { items } = await listHostGrants(socket);
      const mine = items.filter((g) => g.instance_id === this.id);
      for (const g of mine) await releaseHostAdmission(socket, g.grant_id);
      if (mine.length) this.log(`Startup reconcile: releasing ${mine.length} leftover task grants`);
    } catch (e) {
      this.log(`Startup reconcile skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /** Admission rejected or unavailable: back off by the claim interval, avoiding repeated attempts in place */
  backOffAfterAdmission() {
    this.admissionBackoffUntil = Date.now() + this.tuning.claimIntervalSeconds * 1e3;
  }
  log(msg) {
    const t = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
    console.log(`${t} [${this.id}] ${msg}`);
  }
  /** Tool/API audit: records only a digest, with no secrets, request bodies or full responses. */
  audit(file, record) {
    try {
      const dir = path7.resolve(this.tuning.auditDir ?? "data/audit");
      fs7.mkdirSync(dir, { recursive: true, mode: 448 });
      fs7.appendFileSync(path7.join(dir, file), `${JSON.stringify(record)}
`, { mode: 384 });
    } catch (e) {
      this.log(`Audit write failed (${file}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async startApiRuntime() {
    const profiles = this.tuning.profiles;
    if (!profiles || profiles.api.size === 0) return;
    if (!this.tuning.secretStoreUrl) {
      throw new Error("Instance has an API Profile bound but secret_store_url is not configured (failing closed)");
    }
    this.secretClient = new SecretClient({
      url: this.tuning.secretStoreUrl,
      token: this.tuning.instanceToken ?? ""
    });
    this.apiAdapter = new ApiAdapter({
      instanceId: this.id,
      profiles: profiles.api,
      secretClient: this.secretClient,
      egress: {
        policies: this.tuning.egressPolicies ?? {},
        allowLoopback: this.tuning.allowLoopbackEgress ?? false
      },
      port: this.cfg.api_adapter_port ?? 0,
      audit: (r) => this.audit("api-audit.jsonl", r)
    });
    await this.apiAdapter.start();
    this.log(`API Adapter started: ${this.apiAdapter.url} (${profiles.api.size} bindings)`);
  }
  async start() {
    await this.startApiRuntime();
    await this.reconcileHostGrants();
    await this.registerLoop();
    if (this.draining) return;
    await this.beat();
    this.hbTimer = setInterval(() => void this.beat(), this.tuning.heartbeatSeconds * 1e3);
    void this.configLoop();
    void this.claimLoop();
  }
  /**
   * Configuration sync (§7.11): pull the version periodically; the scheduler returns 304 when it is unchanged.
   * The skeleton only "records a change when it sees one"; running tasks keep using the old local config.
   */
  async configLoop() {
    while (!this.draining) {
      try {
        const cfg2 = await this.client.config(this.cfg.instance_id, this.configVersion);
        if (cfg2) {
          this.configVersion = cfg2.config_version;
          this.log(
            `Config sync v${cfg2.config_version}: task types ${cfg2.allowed_task_types?.join(",") || "-"}${cfg2.drain?.requested ? " (draining)" : ""}`
          );
        }
      } catch (e) {
        if (e instanceof SchedulerError && e.status === 401) {
          this.log("Config sync rejected (401); check that SCHEDULER_TOKEN matches the scheduler's AUTH_TOKEN");
        } else {
          this.log(`Config sync failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await sleep(this.tuning.configSyncSeconds * 1e3);
    }
  }
  /** Keep backing off and retrying when registration fails; if the scheduler is not up, do not exit the process */
  async registerLoop() {
    let attempt = 0;
    while (!this.draining) {
      try {
        await this.client.register({
          instance_id: this.cfg.instance_id,
          role_id: this.cfg.role_id,
          host_id: this.cfg.host_id,
          agent_profile_id: this.cfg.agent_profile_id,
          agent_profile_version: this.tuning.profiles?.agent.version ?? this.cfg.agent_profile_version,
          api_profile_ids: this.tuning.profiles ? [...this.tuning.profiles.boundApiIds] : this.cfg.api_profile_ids ?? [],
          allowed_task_types: this.cfg.task_types,
          capabilities: this.cfg.capabilities,
          config_version: 1,
          ...typeof this.cfg.capability_score === "number" ? { capability_score: this.cfg.capability_score } : {},
          ...this.cfg.capability_detail ? { capability_detail: this.cfg.capability_detail } : {}
        });
        this.log("Registered");
        return;
      } catch (e) {
        attempt++;
        const msg = e instanceof Error ? e.message : String(e);
        this.log(`Registration failed (attempt ${attempt}): ${msg}; retrying in 2s`);
        await sleep(2e3);
      }
    }
  }
  async beat() {
    try {
      await this.client.heartbeat({
        instance_id: this.cfg.instance_id,
        state: this.draining ? "DRAINING" : "ONLINE",
        load: { ...sample(), slots_busy: this.running.size, slots_total: this.slots },
        capabilities: this.cfg.capabilities
      });
    } catch (e) {
      this.log(`Heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async claimLoop() {
    while (!this.draining) {
      if (this.running.size >= this.slots) {
        await sleep(200);
        continue;
      }
      if (Date.now() < this.admissionBackoffUntil) {
        await sleep(Math.min(500, this.admissionBackoffUntil - Date.now()));
        continue;
      }
      let assignment;
      try {
        assignment = await this.client.claim(this.cfg.instance_id);
      } catch (e) {
        if (e instanceof SchedulerError && e.code === "INSTANCE_NOT_ELIGIBLE") {
          await sleep(3e3);
          continue;
        }
        this.log(`Claim failed: ${e instanceof Error ? e.message : String(e)}`);
        await sleep(2e3);
        continue;
      }
      if (!assignment) {
        await sleep(this.tuning.claimIntervalSeconds * 1e3);
        continue;
      }
      void this.run(assignment);
    }
    this.log("Claim loop stopped");
  }
  async run(a) {
    const controller = new AbortController();
    this.running.set(a.attempt_id, { task: a, controller });
    const proof = { lease_token: a.lease_token, fencing_token: a.fencing_token };
    let acquired = false;
    let hostGrant = null;
    let workspaceDir = null;
    const socket = this.tuning.hostAdmissionSocket;
    try {
      if (this.tuning.profiles) {
        try {
          assertEnvelopeAllowed(this.tuning.profiles, a);
        } catch (e) {
          const msg = e instanceof ProfileRejected ? `${e.code}: ${e.message}` : String(e);
          this.log(`${a.task_id} profile mismatch (${msg}); task requeued`);
          await this.client.startAck(a.attempt_id, {
            ...proof,
            instance_id: this.id,
            accepted: false
          });
          this.audit("profile-audit.jsonl", {
            ts: (/* @__PURE__ */ new Date()).toISOString(),
            instance_id: this.id,
            task_id: a.task_id,
            attempt_id: a.attempt_id,
            decision: "REJECT",
            error: msg
          });
          return;
        }
      }
      if (socket) {
        try {
          const ha = await checkHostAdmission(socket, {
            grant_id: a.grant_id,
            kind: "TASK",
            instance_id: this.id,
            task_id: a.task_id,
            attempt_id: a.attempt_id,
            resources: { memory_bytes: this.slotMemoryBytes }
          });
          if (!ha.allowed) {
            this.log(
              `${a.task_id} Host Runtime admission rejected: ${ha.reason ?? "INSUFFICIENT_MEMORY"}, available ${gb(ha.observed.mem_available_bytes)} required ${gb(ha.observed.requested_bytes)}; returned to the queue without consuming a retry`
            );
            await this.client.startAck(a.attempt_id, {
              ...proof,
              instance_id: this.id,
              accepted: false
            });
            this.backOffAfterAdmission();
            return;
          }
          hostGrant = a.grant_id;
        } catch (e) {
          this.log(
            `${a.task_id} Host Runtime admission endpoint unavailable (${e instanceof Error ? e.message : String(e)}), rejecting this assignment by failing closed`
          );
          await this.client.startAck(a.attempt_id, {
            ...proof,
            instance_id: this.id,
            accepted: false
          });
          this.backOffAfterAdmission();
          return;
        }
      }
      const adm = await this.admission.tryAcquire();
      if (!adm.allowed) {
        this.log(
          `${a.task_id} local admission rejected: available ${gb(adm.observed.mem_available_bytes)} < required ${gb(adm.observed.requested_bytes)}, returned to the queue without consuming a retry`
        );
        await this.client.startAck(a.attempt_id, {
          ...proof,
          instance_id: this.id,
          accepted: false
        });
        this.backOffAfterAdmission();
        return;
      }
      acquired = true;
      await this.client.startAck(a.attempt_id, {
        ...proof,
        instance_id: this.id,
        accepted: true
      });
      this.log(`Starting ${a.task_id} (attempt ${a.attempt_number}, fencing ${a.fencing_token})`);
      const renewTimer = setInterval(() => void this.renew(a, proof, controller), this.tuning.leaseRenewSeconds * 1e3);
      const watchTimer = setInterval(() => void this.watch(a, proof, controller), this.tuning.progressSeconds * 1e3);
      workspaceDir = path7.join(this.tuning.workspaceDir, a.attempt_id);
      fs7.mkdirSync(workspaceDir, { recursive: true });
      const profiles = this.tuning.profiles;
      const useAgent = profiles ? supportsTask(profiles.agent, a.task_type) && !a.task_type.startsWith("task.console.") : false;
      if (useAgent) {
        this.log(
          `${a.task_id} executed by Agent ${profiles.agent.agent_profile_id}@${profiles.agent.version} (${profiles.agent.adapter})`
        );
      }
      let outcome;
      try {
        const executor = useAgent ? (t, c) => runAgentTask(t, c, {
          profiles,
          apiAdapter: this.apiAdapter,
          toolAudit: (r2) => this.audit("tool-audit.jsonl", r2)
        }) : executorFor(a.task_type);
        outcome = await executor(a, {
          signal: controller.signal,
          instanceId: this.id,
          workspaceDir,
          log: (m) => this.log(`  ${a.task_id}: ${m}`),
          progress: (percent, note) => {
            void this.client.progress(a.attempt_id, { ...proof, percent, note }).catch(() => {
            });
          },
          downloadArtifact: (artifactId) => this.client.downloadArtifactContent(artifactId),
          uploadArtifact: async (content, mediaType = "application/octet-stream") => {
            const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
            const sha2562 = `sha256:${createHash3("sha256").update(buf).digest("hex")}`;
            const meta = await this.client.createArtifact({
              task_id: a.task_id,
              attempt_id: a.attempt_id,
              sha256: sha2562,
              size_bytes: buf.length,
              media_type: mediaType
            });
            if (!meta) throw new Error("Scheduler did not return an artifact record");
            await this.client.uploadArtifactContent(meta.artifact_id, buf);
            await this.client.completeArtifact(meta.artifact_id);
            this.log(`  ${a.task_id}: artifact ${meta.artifact_id} verified (${sha2562.slice(0, 19)}\u2026)`);
            return { artifact_id: meta.artifact_id, sha256: sha2562, size_bytes: buf.length };
          }
        });
      } catch (e) {
        await this.handleExecError(a, proof, e);
        return;
      } finally {
        clearInterval(renewTimer);
        clearInterval(watchTimer);
      }
      const r = await this.client.result(a.attempt_id, {
        ...proof,
        status: "SUCCEEDED",
        summary: outcome.summary,
        outputs: outcome.outputs
      });
      this.log(`Finished ${a.task_id}: ${outcome.summary}${describeResult(r)}`);
    } catch (e) {
      if (e instanceof SchedulerError && e.isFencingLost) {
        this.log(`${a.task_id} lease expired (${e.code}); abandoning this attempt`);
      } else {
        this.log(`${a.task_id} execution error: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (workspaceDir && !this.tuning.keepWorkspace) {
        try {
          fs7.rmSync(workspaceDir, { recursive: true, force: true });
        } catch (e) {
          this.log(`${a.task_id} workspace cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (acquired) this.admission.release();
      if (hostGrant && socket) {
        void releaseHostAdmission(socket, hostGrant).catch(() => {
        });
      }
      this.running.delete(a.attempt_id);
    }
  }
  async handleExecError(a, proof, e) {
    if (e instanceof TaskAborted) {
      if (e.reason === "cancelled") {
        await this.client.result(a.attempt_id, { ...proof, status: "CANCELLED", summary: "Stopped on cancellation request" }).catch(() => {
        });
        this.log(`${a.task_id} stopped on cancellation request`);
      } else if (e.reason === "lease_lost") {
        this.log(`${a.task_id} lease expired or was reclaimed; stopping without reporting a result`);
      } else {
        this.log(`${a.task_id} did not finish before shutdown; leaving it to the scheduler to reclaim`);
      }
      return;
    }
    const code = e instanceof TaskFailed ? e.code : "EXECUTOR_ERROR";
    const message = e instanceof Error ? e.message : String(e);
    await this.client.result(a.attempt_id, { ...proof, status: "FAILED", error: { code, message } }).catch((err) => this.log(`${a.task_id} failed to report the failure result: ${String(err)}`));
    this.log(`${a.task_id} failed (${code}): ${message}`);
  }
  async renew(a, proof, controller) {
    try {
      const r = await this.client.renew(a.attempt_id, proof);
      this.log(`${a.task_id} lease renewed until ${r?.lease_expires_at ?? "unknown"}`);
    } catch (e) {
      if (e instanceof SchedulerError && e.isFencingLost) {
        controller.abort("lease_lost");
      } else {
        this.log(`${a.task_id} lease renewal failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  async watch(a, proof, controller) {
    try {
      const t = await this.client.task(a.task_id);
      if (t?.cancel_requested_at && !controller.signal.aborted) {
        controller.abort("cancelled");
      }
    } catch {
    }
    void proof;
  }
  /** Graceful stop: stop claiming first and wait for in-flight tasks; on timeout, abandon them for the scheduler to reclaim */
  async stop(waitMs = 15e3) {
    this.draining = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    await this.beat();
    this.log(`Starting drain with ${this.running.size} in flight`);
    const deadline = Date.now() + waitMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await sleep(200);
    }
    if (this.running.size > 0) {
      this.log(`Drain timed out; abandoning ${this.running.size} in-flight tasks (the scheduler reclaims them when leases expire)`);
      for (const { controller } of this.running.values()) controller.abort("shutdown");
    }
    try {
      const out = await this.client.deregister(this.cfg.instance_id, {
        reason: "shutdown",
        force: this.running.size > 0
      });
      this.log(`Deregistered (${out?.state ?? "OFFLINE"})`);
    } catch (e) {
      this.log(`Deregistration failed (exit continues): ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.apiAdapter?.close().catch(() => {
    });
    this.apiAdapter = void 0;
  }
};
function gb(n) {
  return `${(n / 1024 ** 3).toFixed(1)}GB`;
}
function describeResult(r) {
  if (r && typeof r === "object" && "idempotent" in r) return " (idempotent replay)";
  return "";
}

// host-runtime/src/config.ts
import fs8 from "node:fs";
import path8 from "node:path";
var DEFAULTS = {
  scheduler_url: "http://127.0.0.1:7801",
  heartbeat_seconds: 10,
  claim_interval_seconds: 2,
  lease_renew_seconds: 60,
  progress_seconds: 3,
  config_sync_seconds: 30,
  request_timeout_ms: 5e3,
  workspace_dir: "data/workspace",
  keep_workspace: false,
  audit_dir: "data/audit"
};
function applyCapabilityEnv(instances2) {
  const rawScore = process.env.CAPABILITY_SCORE;
  const rawDetail = process.env.CAPABILITY_DETAIL;
  if (!rawScore && !rawDetail) return instances2;
  const score = rawScore !== void 0 ? Number(rawScore) : void 0;
  let detail;
  if (rawDetail) {
    try {
      const parsed = JSON.parse(rawDetail);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed;
    } catch {
    }
  }
  return instances2.map((i) => ({
    ...i,
    capability_score: i.capability_score ?? (Number.isFinite(score) ? Math.max(0, Math.min(1e3, Math.round(score))) : void 0),
    capability_detail: i.capability_detail ?? detail
  }));
}
function secondsEnv(name) {
  const raw = process.env[name];
  if (raw === void 0 || raw.trim() === "") return void 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : void 0;
}
function loadConfig(configPath) {
  const file = configPath ?? process.env.RUNTIME_CONFIG ?? "runtime.config.json";
  const abs = path8.resolve(file);
  if (!fs8.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs} (copy one from runtime.config.example.json)`);
  }
  const raw = JSON.parse(fs8.readFileSync(abs, "utf8"));
  const cfg2 = {
    ...DEFAULTS,
    ...raw,
    // Perceived console latency comes mainly from "task enqueued → instance claims it". The default 2 seconds is a DB-saving
    // conservative value; small deployments (a few builders) can drop it to 0.5 seconds to trade for interactive latency.
    claim_interval_seconds: secondsEnv("CLAIM_INTERVAL_SECONDS") ?? raw.claim_interval_seconds ?? DEFAULTS.claim_interval_seconds,
    progress_seconds: secondsEnv("PROGRESS_SECONDS") ?? raw.progress_seconds ?? DEFAULTS.progress_seconds,
    scheduler_url: process.env.SCHEDULER_URL ?? raw.scheduler_url ?? DEFAULTS.scheduler_url,
    scheduler_ca_file: process.env.SCHEDULER_CA_FILE ?? raw.scheduler_ca_file,
    scheduler_client_cert_file: process.env.SCHEDULER_CLIENT_CERT_FILE ?? raw.scheduler_client_cert_file,
    scheduler_client_key_file: process.env.SCHEDULER_CLIENT_KEY_FILE ?? raw.scheduler_client_key_file,
    host_admission_socket: process.env.HOST_ADMISSION_SOCKET ?? raw.host_admission_socket,
    instances: applyCapabilityEnv(raw.instances ?? [])
  };
  if (Boolean(cfg2.scheduler_client_cert_file) !== Boolean(cfg2.scheduler_client_key_file)) {
    throw new Error("scheduler_client_cert_file and scheduler_client_key_file must be configured together");
  }
  for (const f of [cfg2.scheduler_ca_file, cfg2.scheduler_client_cert_file, cfg2.scheduler_client_key_file]) {
    if (f && !fs8.existsSync(f)) throw new Error(`TLS file not found: ${f}`);
  }
  return cfg2;
}
function selectInstances(cfg2, argv) {
  const idx = argv.indexOf("--instance");
  const wanted = idx >= 0 ? argv[idx + 1] : void 0;
  const list = cfg2.instances.filter((i) => i.enabled !== false);
  if (!wanted) return list;
  const one = list.filter((i) => i.instance_id === wanted);
  if (!one.length) throw new Error(`No instance ${wanted} in the config`);
  return one;
}

// host-runtime/src/main.ts
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : void 0;
}
var cfg = loadConfig(argValue("--config"));
var instances = selectInstances(cfg, process.argv);
if (instances.length === 0) {
  console.error("No instances to start; check runtime.config.json");
  process.exit(1);
}
var tokenDir = process.env.INSTANCE_TOKEN_DIR ?? cfg.token_dir;
function tokenFor(instanceId) {
  if (tokenDir) {
    const file = path9.join(path9.resolve(tokenDir), `${instanceId}.jwt`);
    return () => {
      try {
        const jwt = fs9.readFileSync(file, "utf8").trim();
        if (jwt) return jwt;
      } catch {
      }
      return process.env.SCHEDULER_TOKEN || void 0;
    };
  }
  return process.env.SCHEDULER_TOKEN || void 0;
}
var profilesFile = null;
if (cfg.profiles_file) {
  profilesFile = loadProfilesFile(cfg.profiles_file);
  console.log(`Profile file: ${path9.resolve(cfg.profiles_file)}`);
}
function profilesFor(i) {
  if (!profilesFile) return void 0;
  const bound = profilesFile.bindings?.[i.instance_id];
  const known = (profilesFile.agent_profiles ?? []).some(
    (p) => p.agent_profile_id === i.agent_profile_id
  );
  if (!bound && !known) return void 0;
  return resolveInstanceProfiles(profilesFile, i);
}
var agents = instances.map((i) => {
  const client = new SchedulerClient(
    cfg.scheduler_url,
    cfg.request_timeout_ms,
    tokenFor(i.instance_id),
    {
      caFile: cfg.scheduler_ca_file,
      certFile: cfg.scheduler_client_cert_file,
      keyFile: cfg.scheduler_client_key_file
    }
  );
  const profiles = profilesFor(i);
  if (profiles) {
    console.log(
      `  ${i.instance_id}: ${profiles.agent.agent_profile_id}@${profiles.agent.version} (${profiles.agent.adapter})\uFF0CAPI ${[...profiles.boundApiIds].join(",") || "-"}`
    );
  }
  return new Agent(i, client, {
    heartbeatSeconds: cfg.heartbeat_seconds,
    claimIntervalSeconds: cfg.claim_interval_seconds,
    leaseRenewSeconds: cfg.lease_renew_seconds,
    progressSeconds: cfg.progress_seconds,
    configSyncSeconds: cfg.config_sync_seconds,
    hostAdmissionSocket: cfg.host_admission_socket,
    workspaceDir: path9.resolve(cfg.workspace_dir ?? "data/workspace"),
    keepWorkspace: cfg.keep_workspace ?? false,
    profiles,
    secretStoreUrl: process.env.SECRET_STORE_URL ?? cfg.secret_store_url,
    instanceToken: tokenFor(i.instance_id),
    egressPolicies: cfg.egress_policies ?? {},
    allowLoopbackEgress: cfg.allow_loopback_egress ?? false,
    auditDir: path9.resolve(cfg.audit_dir ?? "data/audit")
  });
});
console.log(`Scheduler ${cfg.scheduler_url}; starting ${agents.length} instances: ${instances.map((i) => i.instance_id).join(", ")}`);
if (!tokenDir && !process.env.SCHEDULER_TOKEN) {
  console.warn("No instance token configured (INSTANCE_TOKEN_DIR / SCHEDULER_TOKEN): registration will be rejected if the scheduler enables auth");
}
await Promise.all(agents.map((a) => a.start()));
var stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`
Received ${signal}; stopping claims and draining\u2026`);
  await Promise.all(agents.map((a) => a.stop()));
  console.log("Exited");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
