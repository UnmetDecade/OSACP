#!/usr/bin/env node
/**
 * 调度机 Agent 的「构建机」工具（MCP stdio server）。
 *
 * 调度机只通过调度协议和构建机打交道：这里的每个工具都翻译成一条普通任务
 * （task.console.builder / task.chat.builder），走 claim / lease / fencing / 审计，
 * 不直接连构建机、不持有 SSH 私钥。
 *
 * 由 cli-agent 通过 --mcp-config 挂给 Claude Code，工具名形如
 * mcp__builders__builder_exec。
 *
 * 环境：
 *   SCHEDULER_URL  默认 http://127.0.0.1:8443（调度机容器内自己）
 */
import readline from "node:readline";

const BASE = (process.env.SCHEDULER_URL || `http://127.0.0.1:${process.env.PORT || "8443"}`).replace(/\/+$/, "");
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"]);
const MAX_WAIT_MS = 55_000;

function log(msg) {
  process.stderr.write(`[builders-mcp] ${msg}\n`);
}

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = body?.error;
    throw new Error(`${res.status} ${err?.code ?? ""} ${err?.message ?? text}`.trim());
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function outputsOf(task) {
  const attempts = Array.isArray(task?.attempts) ? task.attempts : [];
  const last = attempts[attempts.length - 1];
  return (last?.outputs && typeof last.outputs === "object" ? last.outputs : {}) || {};
}

async function waitTask(taskId, waitMs = MAX_WAIT_MS) {
  const deadline = Date.now() + Math.min(Math.max(waitMs, 1_000), MAX_WAIT_MS);
  let task = null;
  for (;;) {
    task = await api(`/v1/tasks/${encodeURIComponent(taskId)}`);
    if (TERMINAL.has(String(task?.status ?? ""))) return task;
    if (Date.now() >= deadline) return task;
    await sleep(1_000);
  }
}

function render(task, extra = {}) {
  const out = outputsOf(task);
  const status = String(task?.status ?? "UNKNOWN");
  const lines = [
    `task_id: ${task?.task_id ?? "-"}`,
    `state: ${status}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
  ];
  if (out.exit_code !== undefined) lines.push(`exit_code: ${out.exit_code}`);
  if (out.duration_ms !== undefined) lines.push(`duration_ms: ${out.duration_ms}`);
  if (typeof out.stdout === "string" && out.stdout) lines.push("", "stdout:", out.stdout);
  if (typeof out.stderr === "string" && out.stderr) lines.push("", "stderr:", out.stderr);
  if (!TERMINAL.has(status)) {
    lines.push(
      "",
      `任务还在运行。用 task_status 轮询 task_id=${task?.task_id ?? "-"} 取最终输出。`,
    );
  } else if (status !== "SUCCEEDED") {
    const summary = task?.result_summary ? `（${task.result_summary}）` : "";
    lines.push("", `任务未成功${summary}。`);
  }
  return lines.join("\n");
}

const TOOLS = [
  {
    name: "list_builders",
    description:
      "列出本调度机管辖的构建机（实例 ID、状态、主机、可用能力）。执行命令前先用它确认目标。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "builder_exec",
    description:
      "在一台构建机容器里执行 shell 命令（完整权限，等价于 SSH），返回退出码和输出。" +
      "适合查看环境、安装软件包、编译。长命令会先返回 RUNNING 和 task_id，再用 task_status 取结果。",
    inputSchema: {
      type: "object",
      properties: {
        instance_id: { type: "string", description: "构建机实例 ID，例如 builder-a" },
        command: { type: "string", description: "要执行的 shell 命令" },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 900,
          description: "命令最长运行秒数，默认 120；apt 安装建议 300",
        },
      },
      required: ["instance_id", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "builder_ask",
    description: "把一条消息发给某台构建机上的 Agent，返回它的回复（适合让构建机自查环境或给建议）。",
    inputSchema: {
      type: "object",
      properties: {
        instance_id: { type: "string", description: "构建机实例 ID" },
        message: { type: "string", description: "要问构建机的内容" },
      },
      required: ["instance_id", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "task_status",
    description: "查询一条任务的状态与输出。用于 builder_exec 返回 RUNNING 后取最终结果。",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  if (name === "list_builders") {
    const out = await api("/v1/instances");
    const rows = (out?.items ?? []).filter((r) => r.role_id === "builder");
    if (!rows.length) return "本调度机下还没有注册的构建机。";
    return rows
      .map((r) => {
        const healthy = r?.capabilities?.healthy;
        const caps = Array.isArray(healthy) ? healthy.join(",") : "-";
        return `${r.instance_id}\t${r.state}\t${r.host_id}\t${caps}`;
      })
      .join("\n");
  }

  if (name === "builder_exec") {
    const instanceId = String(args?.instance_id ?? "").trim();
    const command = String(args?.command ?? "");
    if (!instanceId) throw new Error("instance_id 必填");
    if (!command.trim()) throw new Error("command 不能为空");
    const timeout = Math.min(Math.max(Number(args?.timeout_seconds) || 120, 1), 900);
    const task = await api("/v1/tasks", {
      method: "POST",
      body: JSON.stringify({
        task_type: "task.console.builder",
        priority_class: 0,
        max_attempts: 1,
        deadline_at: new Date(Date.now() + (timeout + 120) * 1000).toISOString(),
        requirements: {
          target_instance_id: instanceId,
          console: { command, operator: "scheduler-agent", timeout_seconds: timeout },
        },
      }),
    });
    const done = await waitTask(task.task_id, MAX_WAIT_MS);
    return render(done, { instance_id: instanceId, command });
  }

  if (name === "builder_ask") {
    const instanceId = String(args?.instance_id ?? "").trim();
    const message = String(args?.message ?? "");
    if (!instanceId) throw new Error("instance_id 必填");
    if (!message.trim()) throw new Error("message 不能为空");
    const task = await api("/v1/tasks", {
      method: "POST",
      body: JSON.stringify({
        task_type: "task.chat.builder",
        priority_class: 0,
        max_attempts: 1,
        deadline_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        requirements: {
          target_instance_id: instanceId,
          chat: { session_id: `mcp_${instanceId}`, message, history: [] },
        },
      }),
    });
    const done = await waitTask(task.task_id, MAX_WAIT_MS);
    const out = outputsOf(done);
    const reply = String(out.reply ?? done?.result_summary ?? "");
    return `${render(done, { instance_id: instanceId })}${reply ? `\n\nreply:\n${reply}` : ""}`;
  }

  if (name === "task_status") {
    const taskId = String(args?.task_id ?? "").trim();
    if (!taskId) throw new Error("task_id 必填");
    const task = await api(`/v1/tasks/${encodeURIComponent(taskId)}`);
    return render(task);
  }

  throw new Error(`未知工具：${name}`);
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  // 通知没有 id，不能回复。
  if (msg?.id === undefined || msg?.id === null) return;
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "builders", version: "1.0.0" },
        },
      });
      return;
    }
    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }
    if (method === "tools/call") {
      const name = String(params?.name ?? "");
      try {
        const text = await callTool(name, params?.arguments ?? {});
        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }], isError: false },
        });
      } catch (e) {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `工具执行失败：${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          },
        });
      }
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `未知方法：${method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
// 工具调用要打完一条任务才返回：stdin 关闭时等工作中的调用把结果写完再退出，
// 否则管道式调用（echo 请求 | node tools.mjs）会丢响应。
let inflight = 0;
let closed = false;
function maybeExit() {
  if (closed && inflight === 0) process.exit(0);
}
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    log(`丢弃无法解析的消息：${text.slice(0, 120)}`);
    return;
  }
  inflight += 1;
  void handle(msg).finally(() => {
    inflight -= 1;
    maybeExit();
  });
});
rl.on("close", () => {
  closed = true;
  maybeExit();
});
log(`ready, scheduler=${BASE}`);
