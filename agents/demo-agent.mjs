#!/usr/bin/env node
/**
 * P4 验收入口 Adapter：stdio JSON-RPC 2.0（每行一个 JSON）。
 *
 * 它刻意是一个“没有特权”的 Agent：
 * - 没有实例令牌，读不到 Secret Store；
 * - 外部 API 只能通过 PLATFORM_API_PROXY 的本地句柄；
 * - 工具调用必须带 role-agent 注入的 tool_token，并经 Policy Guard。
 *
 * 换 Agent 不改代码：同一个文件通过 --marker 区分 Profile，任务结果里带 marker。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const markerArg = process.argv.find((a) => a.startsWith("--marker="));
const MARKER = markerArg ? markerArg.slice("--marker=".length) : "default";
const TOOL_TOKEN = process.env.PLATFORM_TOOL_TOKEN ?? "";
const WORKSPACE = process.env.PLATFORM_WORKSPACE ?? process.cwd();
let executeId = null;
let task = null;
let turns = 0;
let toolSeq = 1000;
const toolWaiters = new Map();

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function callTool(tool_id, args, idempotency_key) {
  const id = ++toolSeq;
  const params = { tool_id, args, tool_token: TOOL_TOKEN };
  if (idempotency_key) params.idempotency_key = idempotency_key;
  send({ jsonrpc: "2.0", id, method: "tool.call", params });
  turns++;
  return new Promise((resolve, reject) => {
    toolWaiters.set(id, { resolve, reject });
    setTimeout(() => {
      if (toolWaiters.delete(id)) reject(new Error("tool call timeout"));
    }, 5000);
  });
}

function event(params) {
  send({ jsonrpc: "2.0", method: "agent.event", params });
}

async function execute(id) {
  executeId = id;
  const req = task?.requirements ?? {};
  const text = String(req.message ?? `probe ${task?.task_id ?? "unknown"}`);
  event({ type: "progress", percent: 10, phase: "start" });
  event({ type: "log", level: "info", message: `demo-agent ${MARKER} 开始` });

  if (req.crash === true) {
    // 模拟 Adapter 崩溃：不返回 result，role-agent 必须按可重试失败处理
    process.exit(7);
  }

  const echo = await callTool("demo.echo", { text }, `echo-${task?.task_id}`);

  let forbidden = null;
  if (req.probe_forbidden !== false) {
    try {
      await callTool("demo.forbidden", { command: "rm -rf /" });
      forbidden = "ALLOWED";
    } catch (e) {
      forbidden = e?.message ?? "DENIED";
    }
  }

  let api = null;
  if (req.probe_api === true) {
    const apiId = String(req.api_profile_id ?? "");
    try {
      api = await callTool("api.call", {
        api_profile_id: apiId,
        method: "GET",
        path: "/whoami",
        scope: "probe.read",
      });
    } catch (e) {
      api = { error: e?.message ?? "API call failed" };
    }
  }

  let apiMeta = null;
  if (req.probe_api_meta === true) {
    try {
      apiMeta = await callTool("api.call", {
        api_profile_id: "api_meta",
        method: "GET",
        path: "/latest/meta-data/",
      });
    } catch (e) {
      apiMeta = { error: e?.message ?? "API call failed" };
    }
  }

  event({ type: "progress", percent: 80, phase: "write" });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const out = path.join(WORKSPACE, "result.json");
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        marker: MARKER,
        task_id: task?.task_id ?? null,
        message: text,
        echo,
        forbidden,
        api,
        api_meta: apiMeta,
        turns,
        secrets_seen: 0,
      },
      null,
      2,
    ),
  );
  event({ type: "artifact", name: "result", path: "result.json" });

  const result = {
    status: "SUCCEEDED",
    summary: `agent-marker=${MARKER} forbidden=${forbidden ? "denied" : "not-probed"}`,
    outputs: [{ name: "result", path: "result.json" }],
    metrics: { turns },
  };
  event({ type: "progress", percent: 100, phase: "done" });
  send({ jsonrpc: "2.0", method: "agent.result", params: result });
  if (executeId !== null) send({ jsonrpc: "2.0", id: executeId, result });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }

  if (msg.id !== undefined && toolWaiters.has(msg.id)) {
    const w = toolWaiters.get(msg.id);
    toolWaiters.delete(msg.id);
    if (msg.error) {
      const data = msg.error.data ?? {};
      const code = data.code ?? msg.error.code;
      // 错误回执里的 code 是平台拒绝原因；message 是给人和日志看的原因说明。
      const e = new Error(`${code ?? "TOOL_DENIED"}: ${data.message ?? msg.error.message ?? "tool denied"}`);
      e.code = code;
      w.reject(e);
    } else {
      w.resolve(msg.result);
    }
    return;
  }

  if (msg.method === "agent.health") {
    send({ jsonrpc: "2.0", id: msg.id, result: { healthy: true, version: "1.0.0", marker: MARKER } });
    return;
  }
  if (msg.method === "agent.prepare") {
    task = msg.params?.task ?? {};
    const missing = msg.params?.workspace ? null : "workspace";
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { ready: !missing, capabilities: ["demo.echo"], reason: missing },
    });
    return;
  }
  if (msg.method === "agent.execute") {
    void execute(msg.id).catch((e) => {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { status: "FAILED", error: { code: "AGENT_FAILED", message: String(e?.message ?? e) } },
      });
    });
    return;
  }
  if (msg.method === "agent.cancel") {
    send({ jsonrpc: "2.0", id: msg.id, result: { stopped: true } });
    setTimeout(() => process.exit(0), 50);
  }
});
