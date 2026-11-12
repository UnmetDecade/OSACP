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
            req.on("timeout", () => req.destroy(new Error(`\u8BF7\u6C42\u8D85\u65F6\uFF08${timeout}ms\uFF09`)));
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
        req.on("timeout", () => req.destroy(new Error(`\u8BF7\u6C42\u8D85\u65F6\uFF08${timeoutMs}ms\uFF09`)));
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
    throw new TaskFailed("PAYLOAD_INVALID", `\u5DE5\u4F5C\u76EE\u5F55\u8DEF\u5F84\u8D8A\u754C: ${rel}`);
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
      "\u8FD9\u662F\u81EA\u7136\u8BED\u8A00\u4EFB\u52A1\uFF0C\u9700\u8981\u6784\u5EFA\u673A\u7ED1\u5B9A\u652F\u6301 task.build \u7684 Agent \u540E\u6267\u884C"
    );
  }
  if (!command) return legacyManifest(task, ctx);
  ctx.progress(5, `\u5728\u6784\u5EFA\u673A\u6267\u884C\uFF1A${command.slice(0, 80)}`);
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
  ctx.progress(85, "\u4E0A\u4F20\u6784\u5EFA\u65E5\u5FD7");
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
    throw new TaskFailed("BUILD_TIMEOUT", "\u6784\u5EFA\u547D\u4EE4\u8D85\u8FC7 15 \u5206\u949F\uFF0C\u5DF2\u7EC8\u6B62", {
      command,
      log_artifact_id: artifact.artifact_id
    });
  }
  if (result.exitCode !== 0) {
    throw new TaskFailed("BUILD_FAILED", `\u6784\u5EFA\u547D\u4EE4\u9000\u51FA\u7801 ${result.exitCode}`, {
      exit_code: result.exitCode,
      command,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
      log_artifact_id: artifact.artifact_id,
      log_sha256: artifact.sha256
    });
  }
  ctx.progress(100, "\u6784\u5EFA\u5B8C\u6210");
  return {
    summary: `\u6784\u5EFA\u5B8C\u6210\uFF1Aexit 0 \xB7 ${Math.round(result.durationMs / 1e3)}s`,
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
    throw new TaskFailed("BUILD_WORKDIR_INVALID", `\u5DE5\u4F5C\u76EE\u5F55\u8D8A\u754C\uFF1A${rel}`);
  }
  return abs;
}
async function legacyManifest(task, ctx) {
  ctx.progress(10, "\u51C6\u5907 workspace");
  const mainJs = [
    `// generated by builder agent for ${task.task_id}`,
    `export const taskId = ${JSON.stringify(task.task_id)};`,
    `export const payloadRef = ${JSON.stringify(task.payload_ref ?? null)};`,
    ""
  ].join("\n");
  await sleepAbortable(300, ctx.signal);
  ctx.progress(40, "\u7F16\u8BD1");
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
  ctx.progress(70, "\u6536\u96C6\u4EA7\u7269");
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
    summary: `\u6784\u5EFA\u5B8C\u6210 ${task.task_id}\uFF08${files.length} \u4E2A\u6587\u4EF6\uFF09`,
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
    name: "\u592F\u53F0",
    duty: "\u7F16\u8BD1\u3001\u6267\u884C\u4E0E\u5BB9\u5668\u5185\u53D6\u8BC1",
    line: "\u7ED9\u6211\u4E00\u6761\u547D\u4EE4\uFF0C\u6211\u7ED9\u4F60\u4E00\u4E2A\u80FD\u8DD1\u7684\u7ED3\u679C\u3002"
  },
  scheduler: {
    name: "\u6D3E\u4EE4",
    duty: "\u6392\u961F\u3001\u79DF\u7EA6\u4E0E\u6D3E\u53D1",
    line: "\u4E0D\u731C\u3001\u4E0D\u62A2\uFF1B\u6309\u89C4\u5219\u628A\u4EFB\u52A1\u653E\u5230\u8BE5\u53BB\u7684\u6784\u5EFA\u673A\u3002"
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
      throw new TaskFailed("CHAT_MESSAGE_EMPTY", "\u6D88\u606F\u4E3A\u7A7A");
    }
    ctx.progress(30, "\u8BFB\u53D6\u89D2\u8272\u4E0A\u4E0B\u6587");
    const lower = message.toLowerCase();
    const agent = task.agent?.profile_id ? `${task.agent.profile_id}${task.agent.version ? `@${task.agent.version}` : ""}` : "\u672A\u7ED1\u5B9A Agent";
    let reply;
    if (lower.includes("agent") || message.includes("\u6A21\u578B") || message.includes("\u7ED1\u5B9A")) {
      reply = `\u6211\u662F${persona.name}\uFF0C\u5F53\u524D\u5DE5\u4F4D\u7ED1\u5B9A\u7684\u662F ${agent}\u3002\u6211\u53EA\u4F1A\u770B\u5230\u8FD9\u6761\u5BF9\u8BDD\u548C\u663E\u5F0F\u643A\u5E26\u7684\u5386\u53F2\uFF0C\u4E0D\u4F1A\u8BFB\u53D6\u5DE5\u4F5C\u6D41\u7684\u5176\u4ED6\u4F1A\u8BDD\u3002`;
    } else if (message.includes("\u8FDB\u5EA6") || message.includes("\u72B6\u6001") || message.includes("\u5FD9")) {
      reply = `\u8FD9\u6761\u6D88\u606F\u672C\u8EAB\u662F\u4E00\u6B21 task.chat.${role} \u4EFB\u52A1\uFF1B\u8FDB\u5EA6\u4EE5\u4EFB\u52A1\u4E2D\u5FC3\u4E3A\u51C6\u3002${persona.line}`;
    } else if (message.includes("ssh") || message.includes("\u7EC8\u7AEF") || message.includes("shell")) {
      reply = role === "builder" ? "\u7EC8\u7AEF\u5C31\u662F\u5B8C\u6574 SSH\uFF1Aroot \u767B\u5F55\u3001\u4EFB\u610F\u547D\u4EE4\u3001\u53EF apt\u3001\u53EF\u7F16\u8BD1\u3002\u5730\u5740\u548C\u7AEF\u53E3\u5728\u6784\u5EFA\u673A\u8BE6\u60C5\u91CC\u3002" : "\u8C03\u5EA6\u673A\u4E0D\u6267\u884C\u6784\u5EFA\uFF0C\u53EA\u6392\u961F\u548C\u6D3E\u53D1\uFF1BSSH \u5728\u6784\u5EFA\u673A\u4E0A\u3002";
    } else if (message.includes("\u78C1\u76D8") || message.includes("\u7A7A\u95F4")) {
      reply = "\u5728\u7EC8\u7AEF\u6267\u884C df -h \u5C31\u80FD\u770B\u5230\uFF1B\u6784\u5EFA\u673A\u4EA7\u7269\u76EE\u5F55\u5EFA\u8BAE\u6BCF\u5468\u6E05\u4E00\u6B21\u3002";
    } else if (message.includes("\u4F60\u597D") || lower.includes("hello") || lower.includes("hi")) {
      reply = `\u4F60\u597D\uFF0C\u6211\u662F${persona.name}\uFF0C\u8D1F\u8D23${persona.duty}\u3002${persona.line}`;
    } else {
      reply = `\u6536\u5230\u3002\u6211\u662F${persona.name}\uFF0C\u8D1F\u8D23${persona.duty}\u3002\u5F53\u524D\u6CA1\u6709\u7ED1\u5B9A\u53EF\u5BF9\u8BDD\u7684\u6A21\u578B\uFF0C\u6240\u4EE5\u8FD9\u6761\u662F\u5E73\u53F0\u751F\u6210\u7684\u786E\u5B9A\u6027\u56DE\u590D\uFF1B\u914D\u7F6E Agent Profile \u540E\uFF0C\u540C\u6837\u7684\u4EFB\u52A1\u4F1A\u4EA4\u7ED9\u6307\u5B9A Agent \u6267\u884C\u3002`;
    }
    ctx.progress(80, "\u751F\u6210\u56DE\u590D");
    ctx.log(`chat ${task.task_id}: mode=deterministic history=${history.length}`);
    return {
      summary: `${persona.name} \u56DE\u590D\uFF08\u786E\u5B9A\u6027\uFF09`,
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
    if (!command.trim()) throw new TaskFailed("CONSOLE_COMMAND_EMPTY", "\u547D\u4EE4\u4E3A\u7A7A");
    const requestedSeconds = Number(raw.timeout_seconds);
    const timeoutMs = Number.isFinite(requestedSeconds) && requestedSeconds > 0 ? Math.min(Math.max(requestedSeconds * 1e3, 5e3), 15 * 6e4) : 6e4;
    ctx.progress(20, "\u5728\u6784\u5EFA\u673A\u5185\u6267\u884C\u547D\u4EE4");
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
    ctx.progress(100, "\u547D\u4EE4\u6267\u884C\u5B8C\u6210");
    return {
      summary: `${command.slice(0, 60)} \u6267\u884C\u5B8C\u6210\uFF08exit ${result.exitCode}\uFF09`,
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
  return { summary: `\u6267\u884C\u5B8C\u6210 ${task.task_id}` };
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
            return reject(new Error(`host admission \u8FD4\u56DE\u975E JSON\uFF1A${text.slice(0, 200)}`));
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
    throw new EgressDenied("EGRESS_POLICY_REQUIRED", "API Profile \u672A\u58F0\u660E egress \u7B56\u7565\uFF0C\u9ED8\u8BA4\u62D2\u7EDD");
  }
  const allow = opts.policies[policyName];
  if (!allow) {
    throw new EgressDenied("EGRESS_POLICY_UNKNOWN", `\u672A\u77E5\u51FA\u7AD9\u7B56\u7565\uFF1A${policyName}`);
  }
  const host = normalizeHost(url.hostname);
  if (HOST_SUFFIX_BLOCK.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new EgressDenied("EGRESS_METADATA_BLOCKED", `\u7981\u6B62\u8BBF\u95EE\u5143\u6570\u636E\u57DF\u540D\uFF1A${host}`);
  }
  if (!hostAllowed(host, allow)) {
    throw new EgressDenied("EGRESS_HOST_NOT_ALLOWED", `${host} \u4E0D\u5728\u51FA\u7AD9\u7B56\u7565 ${policyName} \u5185`);
  }
  if (url.protocol !== "https:" && !(opts.allowLoopback && url.protocol === "http:")) {
    throw new EgressDenied("EGRESS_SCHEME_DENIED", `\u53EA\u5141\u8BB8 https \u51FA\u7AD9\uFF1A${url.protocol}`);
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host, opts.allowLoopback)) {
      throw new EgressDenied("EGRESS_IP_BLOCKED", `\u76EE\u6807\u5730\u5740\u4E0D\u53EF\u8BBF\u95EE\uFF1A${host}`);
    }
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new EgressDenied("EGRESS_DNS_FAILED", `\u65E0\u6CD5\u89E3\u6790\uFF1A${host}`);
  }
  if (!addrs.length) throw new EgressDenied("EGRESS_DNS_FAILED", `DNS \u65E0\u7ED3\u679C\uFF1A${host}`);
  for (const a of addrs) {
    if (isBlockedIp(a.address, opts.allowLoopback)) {
      throw new EgressDenied("EGRESS_IP_BLOCKED", `${host} \u89E3\u6790\u5230\u4E0D\u53EF\u8BBF\u95EE\u5730\u5740 ${a.address}`);
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
    if (!token) throw new SecretDenied("SECRET_TOKEN_MISSING", "\u5B9E\u4F8B\u6CA1\u6709\u53EF\u7528\u7684\u8EAB\u4EFD\u4EE4\u724C");
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
        `Secret Store \u4E0D\u53EF\u8FBE\uFF1A${e instanceof Error ? e.message : String(e)}`
      );
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new SecretDenied(
        String(err.code ?? `SECRET_HTTP_${res.status}`),
        String(err.message ?? `Secret Store \u8FD4\u56DE ${res.status}`)
      );
    }
    const credential = String(data.credential ?? "");
    const expiresAt = Date.parse(String(data.expires_at ?? ""));
    if (!credential || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new SecretDenied("SECRET_RESPONSE_INVALID", "Secret Store \u8FD4\u56DE\u7684\u51ED\u636E\u65E0\u6548");
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
      throw new ApiAdapterError("API_HANDLE_INVALID", "\u8DEF\u5F84\u5FC5\u987B\u662F /<api_profile>/<path>", 404);
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
      throw new ApiAdapterError("API_PROFILE_NOT_ALLOWED", `\u672A\u7ED1\u5B9A\u7684 API Profile\uFF1A${profileId}`, 403);
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
    throw last ?? new ApiAdapterError("API_ADAPTER_INTERNAL", "\u6CA1\u6709\u53EF\u7528\u7684 API Profile");
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
        throw new ApiAdapterError("API_NETWORK_ERROR", `\u5916\u90E8 API \u4E0D\u53EF\u8FBE\uFF1A${url.hostname}`, 502, true);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (location && method !== "GET" && method !== "HEAD") {
          throw new ApiAdapterError("API_REDIRECT_DENIED", "\u975E\u5E42\u7B49\u8BF7\u6C42\u4E0D\u5141\u8BB8\u91CD\u5B9A\u5411", 502);
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
        throw new ApiAdapterError(`API_HTTP_${res.status}`, `\u5916\u90E8 API \u8FD4\u56DE ${res.status}`, 502, true);
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
      throw new ApiAdapterError("API_QUOTA_EXCEEDED", "\u8BF7\u6C42\u8D85\u8FC7 rpm \u914D\u989D", 429, false);
    }
    if (profile.quota.daily_calls && state.dayCount >= profile.quota.daily_calls) {
      throw new ApiAdapterError("API_QUOTA_EXCEEDED", "\u8BF7\u6C42\u8D85\u8FC7\u65E5\u914D\u989D", 429, false);
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
      `\u53C2\u8003\u5B9E\u73B0\u672A\u5B9E\u73B0 ${profile.auth_type}\uFF0C\u5931\u8D25\u5173\u95ED`,
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
        reject(new ApiAdapterError("API_BODY_TOO_LARGE", "\u8BF7\u6C42\u4F53\u8D85\u8FC7 1MiB", 413));
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
    if (!rawCmd) throw new AdapterCrash("AGENT_PROFILE_INVALID", "Agent Profile \u7F3A\u5C11 entrypoint");
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
      const msg = `Adapter \u9000\u51FA\uFF08code=${code ?? "null"}, signal=${signal ?? "null"}\uFF09`;
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
            String(msg.error.message ?? "Adapter \u8FD4\u56DE\u9519\u8BEF")
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
    this.hooks.onLog(`\u672A\u77E5 agent.event \u7C7B\u578B\uFF1A${type}`);
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
      return Promise.reject(new AdapterCrash("AGENT_CRASHED", "Adapter \u5DF2\u9000\u51FA"));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterCrash("AGENT_TIMEOUT", `${method} \u8D85\u65F6\uFF08${timeoutMs}ms\uFF09`));
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
      p.reject(new AdapterCrash("AGENT_CANCELLED", "Adapter \u5DF2\u505C\u6B62"));
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
      throw new AdapterCrash("AGENT_PROFILE_INVALID", "http-local \u9700\u8981 entrypoint[0] = http://127.0.0.1:<port>");
    }
    return u.replace(/\/+$/, "");
  }
  async start() {
    await this.request("agent.health", {}, 5e3);
  }
  async request(method, params, timeoutMs) {
    if (this.closed) throw new AdapterCrash("AGENT_CRASHED", "Adapter \u5DF2\u9000\u51FA");
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
      throw new AdapterCrash("AGENT_CRASHED", `Adapter \u4E0D\u53EF\u8FBE\uFF1A${e instanceof Error ? e.message : String(e)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new AdapterCrash("AGENT_CRASHED", `Adapter HTTP ${res.status}`);
    for (const ev of data.events ?? []) this.hooks.onEvent(ev);
    if (data.error) {
      throw new AdapterCrash(String(data.error.code ?? "AGENT_RPC_ERROR"), String(data.error.message ?? "Adapter \u9519\u8BEF"));
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
    if (!opts.toolToken) throw new Error("ToolGuard \u9700\u8981\u6BCF\u6B21 attempt \u7684 tool_token");
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
        throw deny("TOOL_IDENTITY_MISMATCH", "tool_token \u4E0E\u5F53\u524D attempt \u4E0D\u5339\u914D", 1);
      }
      this.turns++;
      if (this.opts.maxTurns !== void 0 && this.turns > this.opts.maxTurns) {
        throw deny("TOOL_TURN_LIMIT", `\u5DE5\u5177\u8C03\u7528\u8D85\u8FC7 max_turns=${this.opts.maxTurns}`, 1);
      }
      const allowed = this.opts.profile.allowed_tools.filter((id) => TOOL_CATALOG[id]);
      if (allowed.length > 0 && !allowed.includes(input.tool_id)) {
        throw deny("TOOL_NOT_ALLOWED", `Agent Profile \u672A\u5141\u8BB8\u5DE5\u5177 ${input.tool_id}`, 2);
      }
      const descriptor = TOOL_CATALOG[input.tool_id];
      if (!descriptor) {
        throw deny("TOOL_UNKNOWN", `\u5DE5\u5177\u672A\u5728\u5E73\u53F0\u76EE\u5F55\u6CE8\u518C\uFF1A${input.tool_id}`, 2);
      }
      if (descriptor.phases.length && !descriptor.phases.includes(this.opts.phase)) {
        throw deny(
          "TOOL_PHASE_DENIED",
          `\u9636\u6BB5 ${this.opts.phase} \u4E0D\u5141\u8BB8\u5DE5\u5177 ${input.tool_id}`,
          3
        );
      }
      validateArgs(input.tool_id, input.args, this.opts.workspace);
      for (const scope of descriptor.action_scopes) {
        if (!this.opts.approvedActionScope.includes(scope)) {
          throw deny("TOOL_SCOPE_DENIED", `\u7F3A\u5C11\u5BA1\u6279 action_scope\uFF1A${scope}`, 5);
        }
      }
      if (descriptor.egress) {
        const apiId = String(input.args.api_profile_id ?? "");
        if (!this.opts.apiProfiles.has(apiId)) {
          throw deny("API_PROFILE_NOT_ALLOWED", `API ${apiId} \u4E0D\u5728\u5B9E\u4F8B\u7ED1\u5B9A\u5185`, 5);
        }
      }
      const argsHash = sha256(stable(input.args));
      if (input.idempotency_key) {
        const prev = this.seen.get(input.idempotency_key);
        if (prev) {
          if (prev.hash !== argsHash) {
            throw deny("TOOL_IDEMPOTENCY_CONFLICT", "\u540C\u4E00\u5E42\u7B49\u952E\u5BF9\u5E94\u4E86\u4E0D\u540C\u53C2\u6570", 6);
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
      if (!fs4.existsSync(file)) throw new Error(`\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${rel}`);
      return { path: rel, content: fs4.readFileSync(file, "utf8") };
    }
    if (input.tool_id === "api.call") {
      if (!this.opts.apiCall) throw new Error("API Adapter \u672A\u542F\u52A8");
      return this.opts.apiCall({
        api_profile_id: String(args.api_profile_id),
        method: String(args.method ?? "GET").toUpperCase(),
        path: String(args.path ?? "/"),
        body: args.body === void 0 ? void 0 : String(args.body),
        scope: args.scope === void 0 ? void 0 : String(args.scope)
      });
    }
    throw new Error(`\u5DE5\u5177\u6CA1\u6709\u5B9E\u73B0\uFF1A${input.tool_id}`);
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
  if (!raw || typeof raw !== "object") throw new ToolDenied("TOOL_INPUT_INVALID", "\u5DE5\u5177\u53C2\u6570\u5FC5\u987B\u662F\u5BF9\u8C61", 1);
  const o = raw;
  if (typeof o.tool_id !== "string" || !o.tool_id) {
    throw new ToolDenied("TOOL_INPUT_INVALID", "\u7F3A\u5C11 tool_id", 1);
  }
  if (!o.args || typeof o.args !== "object" || Array.isArray(o.args)) {
    throw new ToolDenied("TOOL_INPUT_INVALID", "args \u5FC5\u987B\u662F\u5BF9\u8C61", 1);
  }
  if (typeof o.tool_token !== "string") {
    throw new ToolDenied("TOOL_IDENTITY_MISMATCH", "\u7F3A\u5C11 tool_token", 1);
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
    if (typeof args.text !== "string" || args.text.length > 2e3) fail("demo.echo.text \u5FC5\u987B\u662F <=2000 \u5B57\u7B26\u7684\u5B57\u7B26\u4E32");
    return;
  }
  if (toolId === "workspace.write") {
    if (typeof args.path !== "string" || typeof args.content !== "string") fail("workspace.write \u9700\u8981 path/content");
    if (args.content.length > 1024 * 1024) fail("\u5199\u5165\u5185\u5BB9\u8D85\u8FC7 1MiB");
    assertInsideWorkspace(args.path, workspace);
    return;
  }
  if (toolId === "workspace.read") {
    if (typeof args.path !== "string") fail("workspace.read \u9700\u8981 path");
    assertInsideWorkspace(args.path, workspace);
    return;
  }
  if (toolId === "api.call") {
    if (typeof args.api_profile_id !== "string" || !args.api_profile_id) fail("\u9700\u8981 api_profile_id");
    const method = String(args.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) fail(`method \u4E0D\u5141\u8BB8\uFF1A${method}`);
    if (typeof args.path !== "string" || !args.path.startsWith("/") || args.path.length > 512) {
      fail("path \u5FC5\u987B\u662F\u4EE5 / \u5F00\u5934\u7684\u76F8\u5BF9\u8DEF\u5F84");
    }
    const p = args.path;
    if (p.includes("..") || p.includes("//") || p.includes("\\") || /[\r\n]/.test(p)) fail("path \u542B\u975E\u6CD5\u6BB5");
    if (args.body !== void 0 && String(args.body).length > 64 * 1024) fail("body \u8D85\u8FC7 64KiB");
    if (args.scope !== void 0 && typeof args.scope !== "string") fail("scope \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
    return;
  }
  fail(`\u5DE5\u5177\u6CA1\u6709\u53C2\u6570\u6821\u9A8C\u89C4\u5219\uFF1A${toolId}`);
}
function assertInsideWorkspace(rel, workspace) {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) {
    throw new ToolDenied("WORKSPACE_PATH_DENIED", `\u8DEF\u5F84\u5FC5\u987B\u4F4D\u4E8E\u5DE5\u4F5C\u533A\u5185\uFF1A${rel}`, 4);
  }
  const root = path4.resolve(workspace);
  const target = path4.resolve(root, rel);
  if (target !== root && !target.startsWith(`${root}${path4.sep}`)) {
    throw new ToolDenied("WORKSPACE_PATH_DENIED", `\u8DEF\u5F84\u9003\u9038\u5DE5\u4F5C\u533A\uFF1A${rel}`, 4);
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
    throw new TaskFailed("ATTACHMENT_URL_INVALID", "\u9644\u4EF6\u5730\u5740\u4E0D\u5408\u6CD5");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TaskFailed("ATTACHMENT_URL_INVALID", "\u9644\u4EF6\u5730\u5740\u5FC5\u987B\u662F http \u6216 https");
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
      `\u53D6\u9644\u4EF6\u5931\u8D25\uFF1A${String(err?.message ?? err)}`
    );
  }
  if (!res.ok) {
    throw new TaskFailed("ATTACHMENT_FETCH_FAILED", `\u53D6\u9644\u4EF6\u5931\u8D25\uFF1AHTTP ${res.status}`);
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
      throw new TaskFailed("ATTACHMENT_TOO_LARGE", "\u9644\u4EF6\u8D85\u8FC7 32MiB");
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
            String(err?.message ?? "\u5236\u54C1\u8DEF\u5F84\u4E0D\u5728\u5DE5\u4F5C\u533A")
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
    ctx.log(`\u5DF2\u628A ${count.length} \u4E2A\u9644\u4EF6\u5199\u5165\u5DE5\u4F5C\u533A attachments/`);
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
      throw new TaskFailed("AGENT_NOT_READY", "Agent prepare \u672A\u5C31\u7EEA", prepared);
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
        String(result?.error?.message ?? result?.summary ?? "Agent \u8FD4\u56DE\u5931\u8D25")
      );
    }
    const outputs = [];
    for (const out of result.outputs ?? []) {
      const rel = out.path.replace(/^\.\/+/, "");
      assertInsideWorkspace(rel, ctx.workspaceDir);
      const file = path5.join(ctx.workspaceDir, rel);
      if (!fs5.existsSync(file)) {
        throw new TaskFailed("AGENT_OUTPUT_MISSING", `Agent \u58F0\u660E\u7684\u4EA7\u7269\u4E0D\u5B58\u5728\uFF1A${rel}`);
      }
      const uploaded = await ctx.uploadArtifact(fs5.readFileSync(file), mediaFor(rel));
      outputs.push({ name: out.name, ...uploaded });
    }
    for (const e of artifactPaths) {
      if (!outputs.some((o) => o.name === e.name)) {
        ctx.log(`Agent \u4E8B\u4EF6\u58F0\u660E\u4E86\u4EA7\u7269 ${e.name}\uFF0C\u4F46\u672A\u5728\u6700\u7EC8 result \u4E2D\u8FD4\u56DE\uFF0C\u5DF2\u5FFD\u7565`);
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
      summary: String(result.summary ?? `Agent ${profile.agent_profile_id} \u6267\u884C\u5B8C\u6210`),
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
    throw new Error(`\u627E\u4E0D\u5230 Profile \u6587\u4EF6\uFF1A${abs}`);
  }
  const raw = JSON.parse(fs6.readFileSync(abs, "utf8"));
  return raw;
}
function resolveInstanceProfiles(file, instance) {
  const agentId = instance.agent_profile_id;
  if (!agentId) throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", "\u5B9E\u4F8B\u672A\u7ED1\u5B9A Agent Profile");
  const agent = (file.agent_profiles ?? []).find((p) => p.agent_profile_id === agentId);
  if (!agent) {
    throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", `Profile \u6587\u4EF6\u91CC\u6CA1\u6709 ${agentId}`);
  }
  if (agent.enabled === false) {
    throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", `Agent Profile \u5DF2\u505C\u7528\uFF1A${agentId}`);
  }
  if (agent.role_id !== instance.role_id) {
    throw new ProfileRejected(
      "AGENT_PROFILE_NOT_ALLOWED",
      `Agent Profile \u5C5E\u4E8E ${agent.role_id}\uFF0C\u5B9E\u4F8B\u89D2\u8272\u662F ${instance.role_id}`
    );
  }
  const allowed = ADAPTERS[instance.role_id];
  if (!allowed || !allowed.includes(agent.adapter)) {
    throw new ProfileRejected(
      "ADAPTER_NOT_ALLOWED",
      `\u89D2\u8272 ${instance.role_id} \u4E0D\u5141\u8BB8 ${agent.adapter}`
    );
  }
  const binding = file.bindings?.[instance.instance_id];
  if (binding) {
    if (binding.agent_profile_id !== agentId) {
      throw new ProfileRejected(
        "AGENT_PROFILE_NOT_ALLOWED",
        `\u5B9E\u4F8B\u914D\u7F6E\u7684 Agent ${agentId} \u4E0E PCS \u7ED1\u5B9A ${binding.agent_profile_id} \u4E0D\u4E00\u81F4`
      );
    }
    const configured = new Set(instance.api_profile_ids ?? []);
    for (const id of binding.api_profile_ids ?? []) {
      if (!configured.has(id)) {
        throw new ProfileRejected(
          "API_PROFILE_NOT_ALLOWED",
          `PCS \u7ED1\u5B9A\u4E86 ${id}\uFF0C\u4F46\u5B9E\u4F8B\u542F\u52A8\u914D\u7F6E\u6CA1\u6709\u52A0\u8F7D\u5B83`
        );
      }
    }
    if (configured.size !== new Set(binding.api_profile_ids ?? []).size) {
      throw new ProfileRejected(
        "API_PROFILE_NOT_ALLOWED",
        "\u5B9E\u4F8B\u52A0\u8F7D\u4E86 PCS \u672A\u7ED1\u5B9A\u7684 API Profile"
      );
    }
  }
  const api = /* @__PURE__ */ new Map();
  for (const id of instance.api_profile_ids ?? []) {
    const p = (file.api_profiles ?? []).find((x) => x.api_profile_id === id);
    if (!p) throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `Profile \u6587\u4EF6\u91CC\u6CA1\u6709 API ${id}`);
    if (p.enabled === false) {
      throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `API Profile \u5DF2\u505C\u7528\uFF1A${id}`);
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
        `Agent Profile \u5F15\u7528\u4E86\u672A\u7ED1\u5B9A\u7684 API\uFF1A${id}`
      );
    }
  }
  return { agent, api, boundApiIds: new Set(api.keys()) };
}
function assertEnvelopeAllowed(profiles, envelope) {
  if (!envelope.agent || envelope.agent.profile_id !== profiles.agent.agent_profile_id) {
    throw new ProfileRejected(
      "AGENT_PROFILE_NOT_ALLOWED",
      `\u4EFB\u52A1\u6307\u5B9A Agent ${envelope.agent?.profile_id ?? "(\u7A7A)"}\uFF0C\u5B9E\u4F8B\u7ED1\u5B9A ${profiles.agent.agent_profile_id}`
    );
  }
  if (envelope.agent.version !== null && envelope.agent.version !== void 0 && envelope.agent.version !== profiles.agent.version) {
    throw new ProfileRejected(
      "AGENT_PROFILE_NOT_ALLOWED",
      `\u4EFB\u52A1\u6307\u5B9A\u7248\u672C ${envelope.agent.version}\uFF0C\u5B9E\u4F8B\u52A0\u8F7D ${profiles.agent.version}`
    );
  }
  for (const id of envelope.api_profiles ?? []) {
    if (!profiles.boundApiIds.has(id)) {
      throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `\u4EFB\u52A1\u5F15\u7528\u4E86\u672A\u7ED1\u5B9A\u7684 API ${id}`);
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
      if (mine.length) this.log(`\u542F\u52A8\u5BF9\u8D26\uFF1A\u91CA\u653E ${mine.length} \u4E2A\u6B8B\u7559 task grant`);
    } catch (e) {
      this.log(`\u542F\u52A8\u5BF9\u8D26\u8DF3\u8FC7\uFF1A${e instanceof Error ? e.message : String(e)}`);
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
      this.log(`\u5BA1\u8BA1\u5199\u5165\u5931\u8D25\uFF08${file}\uFF09\uFF1A${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async startApiRuntime() {
    const profiles = this.tuning.profiles;
    if (!profiles || profiles.api.size === 0) return;
    if (!this.tuning.secretStoreUrl) {
      throw new Error("\u5B9E\u4F8B\u7ED1\u5B9A\u4E86 API Profile\uFF0C\u4F46\u6CA1\u6709\u914D\u7F6E secret_store_url\uFF08\u5931\u8D25\u5173\u95ED\uFF09");
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
    this.log(`API Adapter \u5DF2\u542F\u52A8\uFF1A${this.apiAdapter.url}\uFF08${profiles.api.size} \u4E2A\u7ED1\u5B9A\uFF09`);
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
            `\u914D\u7F6E\u540C\u6B65 v${cfg2.config_version}\uFF1A\u4EFB\u52A1\u7C7B\u578B ${cfg2.allowed_task_types?.join(",") || "-"}${cfg2.drain?.requested ? "\uFF08drain \u4E2D\uFF09" : ""}`
          );
        }
      } catch (e) {
        if (e instanceof SchedulerError && e.status === 401) {
          this.log("\u914D\u7F6E\u540C\u6B65\u88AB\u62D2\uFF08401\uFF09\uFF0C\u68C0\u67E5 SCHEDULER_TOKEN \u662F\u5426\u4E0E\u8C03\u5EA6\u673A AUTH_TOKEN \u4E00\u81F4");
        } else {
          this.log(`\u914D\u7F6E\u540C\u6B65\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`);
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
        this.log("\u5DF2\u6CE8\u518C");
        return;
      } catch (e) {
        attempt++;
        const msg = e instanceof Error ? e.message : String(e);
        this.log(`\u6CE8\u518C\u5931\u8D25\uFF08\u7B2C ${attempt} \u6B21\uFF09\uFF1A${msg}\uFF0C2s \u540E\u91CD\u8BD5`);
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
      this.log(`\u5FC3\u8DF3\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`);
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
        this.log(`\u9886\u53D6\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`);
        await sleep(2e3);
        continue;
      }
      if (!assignment) {
        await sleep(this.tuning.claimIntervalSeconds * 1e3);
        continue;
      }
      void this.run(assignment);
    }
    this.log("claim \u5FAA\u73AF\u5DF2\u505C\u6B62");
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
          this.log(`${a.task_id} Profile \u4E0D\u5339\u914D\uFF08${msg}\uFF09\uFF0C\u4EFB\u52A1\u56DE\u961F`);
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
              `${a.task_id} Host Runtime \u51C6\u5165\u62D2\u7EDD\uFF1A${ha.reason ?? "INSUFFICIENT_MEMORY"}\uFF0C\u53EF\u7528 ${gb(ha.observed.mem_available_bytes)} \u9700\u8981 ${gb(ha.observed.requested_bytes)}\uFF1B\u653E\u56DE\u961F\u5217\u4E14\u4E0D\u6D88\u8017\u91CD\u8BD5`
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
            `${a.task_id} Host Runtime \u51C6\u5165\u63A5\u53E3\u4E0D\u53EF\u7528\uFF08${e instanceof Error ? e.message : String(e)}\uFF09\uFF0C\u6309\u5931\u8D25\u5173\u95ED\u62D2\u7EDD\u8BE5 assignment`
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
          `${a.task_id} \u672C\u673A\u51C6\u5165\u62D2\u7EDD\uFF1A\u53EF\u7528 ${gb(adm.observed.mem_available_bytes)} < \u9700\u8981 ${gb(adm.observed.requested_bytes)}\uFF0C\u653E\u56DE\u961F\u5217\u4E14\u4E0D\u6D88\u8017\u91CD\u8BD5`
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
      this.log(`\u5F00\u59CB ${a.task_id}\uFF08attempt ${a.attempt_number}\uFF0Cfencing ${a.fencing_token}\uFF09`);
      const renewTimer = setInterval(() => void this.renew(a, proof, controller), this.tuning.leaseRenewSeconds * 1e3);
      const watchTimer = setInterval(() => void this.watch(a, proof, controller), this.tuning.progressSeconds * 1e3);
      workspaceDir = path7.join(this.tuning.workspaceDir, a.attempt_id);
      fs7.mkdirSync(workspaceDir, { recursive: true });
      const profiles = this.tuning.profiles;
      const useAgent = profiles ? supportsTask(profiles.agent, a.task_type) && !a.task_type.startsWith("task.console.") : false;
      if (useAgent) {
        this.log(
          `${a.task_id} \u7531 Agent ${profiles.agent.agent_profile_id}@${profiles.agent.version} \u6267\u884C\uFF08${profiles.agent.adapter}\uFF09`
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
            if (!meta) throw new Error("\u8C03\u5EA6\u673A\u672A\u8FD4\u56DE\u5236\u54C1\u8BB0\u5F55");
            await this.client.uploadArtifactContent(meta.artifact_id, buf);
            await this.client.completeArtifact(meta.artifact_id);
            this.log(`  ${a.task_id}: \u5236\u54C1 ${meta.artifact_id} \u5DF2\u6821\u9A8C\uFF08${sha2562.slice(0, 19)}\u2026\uFF09`);
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
      this.log(`\u5B8C\u6210 ${a.task_id}\uFF1A${outcome.summary}${describeResult(r)}`);
    } catch (e) {
      if (e instanceof SchedulerError && e.isFencingLost) {
        this.log(`${a.task_id} \u79DF\u7EA6\u5DF2\u5931\u6548\uFF08${e.code}\uFF09\uFF0C\u653E\u5F03\u672C attempt`);
      } else {
        this.log(`${a.task_id} \u6267\u884C\u5F02\u5E38\uFF1A${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (workspaceDir && !this.tuning.keepWorkspace) {
        try {
          fs7.rmSync(workspaceDir, { recursive: true, force: true });
        } catch (e) {
          this.log(`${a.task_id} \u5DE5\u4F5C\u76EE\u5F55\u6E05\u7406\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`);
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
        await this.client.result(a.attempt_id, { ...proof, status: "CANCELLED", summary: "\u6309\u53D6\u6D88\u8BF7\u6C42\u505C\u6B62" }).catch(() => {
        });
        this.log(`${a.task_id} \u5DF2\u6309\u53D6\u6D88\u8BF7\u6C42\u505C\u6B62`);
      } else if (e.reason === "lease_lost") {
        this.log(`${a.task_id} \u79DF\u7EA6\u5931\u6548\u6216\u5DF2\u88AB\u56DE\u6536\uFF0C\u505C\u6B62\u6267\u884C\u4E14\u4E0D\u4E0A\u62A5\u7ED3\u679C`);
      } else {
        this.log(`${a.task_id} \u8FDB\u7A0B\u9000\u51FA\u524D\u672A\u5B8C\u6210\uFF0C\u7559\u7ED9\u8C03\u5EA6\u673A\u56DE\u6536`);
      }
      return;
    }
    const code = e instanceof TaskFailed ? e.code : "EXECUTOR_ERROR";
    const message = e instanceof Error ? e.message : String(e);
    await this.client.result(a.attempt_id, { ...proof, status: "FAILED", error: { code, message } }).catch((err) => this.log(`${a.task_id} \u4E0A\u62A5\u5931\u8D25\u7ED3\u679C\u65F6\u51FA\u9519\uFF1A${String(err)}`));
    this.log(`${a.task_id} \u5931\u8D25\uFF08${code}\uFF09\uFF1A${message}`);
  }
  async renew(a, proof, controller) {
    try {
      const r = await this.client.renew(a.attempt_id, proof);
      this.log(`${a.task_id} \u7EED\u79DF\u81F3 ${r?.lease_expires_at ?? "\u672A\u77E5"}`);
    } catch (e) {
      if (e instanceof SchedulerError && e.isFencingLost) {
        controller.abort("lease_lost");
      } else {
        this.log(`${a.task_id} \u7EED\u79DF\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`);
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
    this.log(`\u5F00\u59CB drain\uFF0C\u5728\u9014 ${this.running.size} \u4E2A`);
    const deadline = Date.now() + waitMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await sleep(200);
    }
    if (this.running.size > 0) {
      this.log(`drain \u8D85\u65F6\uFF0C\u653E\u5F03 ${this.running.size} \u4E2A\u5728\u9014\u4EFB\u52A1\uFF08\u7B49\u79DF\u7EA6\u8FC7\u671F\u540E\u7531\u8C03\u5EA6\u673A\u56DE\u6536\uFF09`);
      for (const { controller } of this.running.values()) controller.abort("shutdown");
    }
    try {
      const out = await this.client.deregister(this.cfg.instance_id, {
        reason: "shutdown",
        force: this.running.size > 0
      });
      this.log(`\u5DF2\u6CE8\u9500\uFF08${out?.state ?? "OFFLINE"}\uFF09`);
    } catch (e) {
      this.log(`\u6CE8\u9500\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u9000\u51FA\uFF09\uFF1A${e instanceof Error ? e.message : String(e)}`);
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
  if (r && typeof r === "object" && "idempotent" in r) return "\uFF08\u5E42\u7B49\u91CD\u653E\uFF09";
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
    throw new Error(`\u627E\u4E0D\u5230\u914D\u7F6E\u6587\u4EF6\uFF1A${abs}\uFF08\u53EF\u4ECE runtime.config.example.json \u590D\u5236\uFF09`);
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
    throw new Error("scheduler_client_cert_file \u4E0E scheduler_client_key_file \u5FC5\u987B\u540C\u65F6\u914D\u7F6E");
  }
  for (const f of [cfg2.scheduler_ca_file, cfg2.scheduler_client_cert_file, cfg2.scheduler_client_key_file]) {
    if (f && !fs8.existsSync(f)) throw new Error(`\u627E\u4E0D\u5230 TLS \u6587\u4EF6\uFF1A${f}`);
  }
  return cfg2;
}
function selectInstances(cfg2, argv) {
  const idx = argv.indexOf("--instance");
  const wanted = idx >= 0 ? argv[idx + 1] : void 0;
  const list = cfg2.instances.filter((i) => i.enabled !== false);
  if (!wanted) return list;
  const one = list.filter((i) => i.instance_id === wanted);
  if (!one.length) throw new Error(`\u914D\u7F6E\u91CC\u6CA1\u6709\u5B9E\u4F8B ${wanted}`);
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
  console.error("\u6CA1\u6709\u53EF\u542F\u52A8\u7684\u5B9E\u4F8B\uFF0C\u68C0\u67E5 runtime.config.json");
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
  console.log(`Profile \u6587\u4EF6\uFF1A${path9.resolve(cfg.profiles_file)}`);
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
console.log(`\u8C03\u5EA6\u673A ${cfg.scheduler_url}\uFF0C\u542F\u52A8 ${agents.length} \u4E2A\u5B9E\u4F8B\uFF1A${instances.map((i) => i.instance_id).join(", ")}`);
if (!tokenDir && !process.env.SCHEDULER_TOKEN) {
  console.warn("\u672A\u914D\u7F6E\u5B9E\u4F8B\u4EE4\u724C\uFF08INSTANCE_TOKEN_DIR / SCHEDULER_TOKEN\uFF09\uFF1A\u8C03\u5EA6\u673A\u82E5\u542F\u7528\u9274\u6743\uFF0C\u6CE8\u518C\u4F1A\u88AB\u62D2\u7EDD");
}
await Promise.all(agents.map((a) => a.start()));
var stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`
\u6536\u5230 ${signal}\uFF0C\u505C\u6B62\u9886\u53D6\u5E76 drain\u2026`);
  await Promise.all(agents.map((a) => a.stop()));
  console.log("\u5DF2\u9000\u51FA");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
