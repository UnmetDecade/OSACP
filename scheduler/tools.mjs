#!/usr/bin/env node
/**
 * "Builder" tools for the scheduler Agent (MCP stdio server).
 *
 * The scheduler talks to builders only through the scheduling protocol: every tool here maps to an ordinary task
 * (task.console.builder / task.chat.builder) going through claim / lease / fencing / audit,
 * never connecting to builders directly and never holding SSH private keys.
 *
 * Mounted into Claude Code by cli-agent via --mcp-config; tool names look like
 * mcp__builders__builder_exec。
 *
 * Environment:
 *   SCHEDULER_URL  defaults to http://127.0.0.1:8443 (the scheduler itself inside its container)
 */
import readline from "node:readline";
import { boundedSection, readResult } from "./tool-result-gate.mjs";

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
  if (typeof out.stdout === "string" && out.stdout) lines.push("", boundedSection("stdout", out.stdout));
  if (typeof out.stderr === "string" && out.stderr) lines.push("", boundedSection("stderr", out.stderr));
  if (!TERMINAL.has(status)) {
    lines.push(
      "",
      `The task is still running. Poll task_status with task_id=${task?.task_id ?? "-"} for the final output.`,
    );
  } else if (status !== "SUCCEEDED") {
    const summary = task?.result_summary ? ` (${task.result_summary})` : "";
    lines.push("", `The task did not succeed${summary}.`);
  }
  return lines.join("\n");
}

const TOOLS = [
  {
    name: "list_builders",
    description:
      "List the builders under this scheduler (instance ID, state, host, available capability). Use it to confirm the target before running a command.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "builder_exec",
    description:
      "Run a shell command inside a builder container (full privileges, equivalent to SSH) and return the exit code and output. " +
      "Use it to inspect the environment, install packages, or compile. Long commands return RUNNING and a task_id first; fetch the result with task_status. " +
      "Output over about 8000 chars comes back as head + tail plus a handle; use read_result to look at the rest.",
    inputSchema: {
      type: "object",
      properties: {
        instance_id: { type: "string", description: "Builder instance ID, e.g. builder-a" },
        command: { type: "string", description: "Shell command to run" },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 900,
          description: "Maximum run time in seconds, default 120; 300 is recommended for apt installs",
        },
      },
      required: ["instance_id", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "builder_ask",
    description: "Send a message to the agent on a builder and return its reply (useful for letting the builder inspect its own environment or give advice).",
    inputSchema: {
      type: "object",
      properties: {
        instance_id: { type: "string", description: "Builder instance ID" },
        message: { type: "string", description: "Message to send to the builder" },
      },
      required: ["instance_id", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "task_status",
    description: "Look up a task's state and output. Use it to fetch the final result after builder_exec returns RUNNING.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_result",
    description:
      "Read a bounded slice of an output that was too large to return in full. The tool result names the handle to use. " +
      "Prefer grep to locate the line you need; use offset/limit to page through characters. Every answer is capped, so never ask for everything.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "Result handle, e.g. r3, as printed in the truncated tool result" },
        grep: { type: "string", description: "Case-insensitive regular expression; returns matching lines with line numbers" },
        context: { type: "integer", minimum: 0, maximum: 20, description: "Lines of context around each grep match, default 2" },
        offset: { type: "integer", minimum: 0, description: "Character offset to start from when not grepping" },
        limit: { type: "integer", minimum: 1, maximum: 8000, description: "Characters to return, default and maximum 8000" },
      },
      required: ["handle"],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  if (name === "list_builders") {
    const out = await api("/v1/instances");
    const rows = (out?.items ?? []).filter((r) => r.role_id === "builder");
    if (!rows.length) return "No builders are registered under this scheduler yet.";
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
    if (!instanceId) throw new Error("instance_id is required");
    if (!command.trim()) throw new Error("command must not be empty");
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
    if (!instanceId) throw new Error("instance_id is required");
    if (!message.trim()) throw new Error("message must not be empty");
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
    return `${render(done, { instance_id: instanceId })}${reply ? `\n\n${boundedSection("reply", reply)}` : ""}`;
  }

  if (name === "task_status") {
    const taskId = String(args?.task_id ?? "").trim();
    if (!taskId) throw new Error("task_id is required");
    const task = await api(`/v1/tasks/${encodeURIComponent(taskId)}`);
    return render(task);
  }

  if (name === "read_result") {
    const handle = String(args?.handle ?? "").trim();
    if (!handle) throw new Error("handle is required");
    return readResult(handle, args);
  }

  throw new Error(`Unknown tool: ${name}`);
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  // Notifications have no id and cannot be replied to.
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
            content: [{ type: "text", text: `Tool execution failed: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          },
        });
      }
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
// A tool call returns only after finishing a whole task: when stdin closes, wait for in-flight calls to finish writing their results before exiting,
// otherwise piped calls (echo request | node tools.mjs) lose their responses.
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
    log(`Dropped unparseable message: ${text.slice(0, 120)}`);
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
