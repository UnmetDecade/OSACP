#!/usr/bin/env node
/**
 * Protocol-level smoke test for cli-agent.mjs (does not depend on real Claude Code / Codex).
 *
 * Run: node agents/test-cli-agent.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.join(here, "cli-agent.mjs");
const stub = path.join(here, "fixtures", "stub-cli.mjs");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-agent-test-"));
let failures = 0;

function ok(cond, label) {
  if (cond) console.log(`ok - ${label}`);
  else {
    failures++;
    console.log(`FAIL - ${label}`);
  }
}

function start(taskType, deadlineMs = 60_000, extraArgs = []) {
  const child = spawn(
    process.execPath,
    [wrapper, "--provider", "custom", "--command", process.execPath, "--cli-arg", stub, "--cli-arg", "{prompt}", ...extraArgs],
    {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? "C.UTF-8",
        HOME: workspace,
        PLATFORM_WORKSPACE: workspace,
        PLATFORM_TOOL_TOKEN: "must-not-leak",
        PLATFORM_API_PROXY: "http://127.0.0.1:9999",
        PLATFORM_TASK_TYPE: taskType,
        PLATFORM_DEADLINE: new Date(Date.now() + deadlineMs).toISOString(),
        AMBIENT_SECRET: "ambient-must-not-leak",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let seq = 0;
  const pending = new Map();
  let notification = null;
  let notifyWaiter = null;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    if (msg.method === "agent.result") {
      notification = msg.params;
      notifyWaiter?.(msg.params);
    }
  });
  const stderr = [];
  child.stderr.on("data", (b) => stderr.push(b.toString("utf8")));

  function request(method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timeout`));
      }, 8000);
    });
  }

  function waitNotification() {
    if (notification) return Promise.resolve(notification);
    return new Promise((resolve) => {
      notifyWaiter = resolve;
      setTimeout(() => resolve(null), 8000);
    });
  }

  return { child, request, waitNotification, stderr };
}

async function chatTest() {
  const s = start("task.chat.worker");
  const health = await s.request("agent.health", {});
  ok(health.result?.healthy === true && health.result?.available === true, "health: CLI available");
  const prep = await s.request("agent.prepare", {
    task: { task_id: "t_chat", task_type: "task.chat.worker", requirements: {} },
    workspace,
  });
  ok(prep.result?.ready === true, "prepare: ready");
  const exec = await s.request("agent.execute", {
    task: {
      task_id: "t_chat",
      task_type: "task.chat.worker",
      requirements: { chat: { message: "Hello, how is it going?", history: [] } },
    },
    workspace,
  });
  const result = await s.waitNotification();
  ok(exec.result?.status === "SUCCEEDED", "execute: chat succeeded");
  ok(String(result?.reply ?? "").includes("STUB_REPLY(Hello, how is it going?)"), "chat: reply passed through");
  ok(String(result?.reply ?? "").includes("token=stripped"), "chat: the external CLI cannot see the tool token");
  ok(String(result?.reply ?? "").includes("ambient=hidden"), "chat: undeclared host environment variables are not inherited by default");
  ok(!s.stderr.join("").includes("must-not-leak"), "chat: the token did not appear on stderr");
  s.child.kill("SIGKILL");
}

async function passEnvTest() {
  const s = start("task.chat.worker", 60_000, ["--pass-env", "AMBIENT_SECRET"]);
  await s.request("agent.health", {});
  await s.request("agent.prepare", {
    task: { task_id: "t_env", task_type: "task.chat.worker", requirements: {} },
    workspace,
  });
  const exec = await s.request("agent.execute", {
    task: {
      task_id: "t_env",
      task_type: "task.chat.worker",
      requirements: { chat: { message: "environment test", history: [] } },
    },
    workspace,
  });
  ok(String(exec.result?.reply ?? "").includes("ambient=visible"), "pass-env: explicitly declared variables reach the CLI");
  s.child.kill("SIGKILL");
}

async function buildTest() {
  const s = start("task.build");
  await s.request("agent.health", {});
  await s.request("agent.prepare", {
    task: { task_id: "t_build", task_type: "task.build", requirements: { change: "demo" } },
    workspace,
  });
  const exec = await s.request("agent.execute", {
    task: { task_id: "t_build", task_type: "task.build", requirements: { change: "demo" } },
    workspace,
  });
  ok(exec.result?.status === "SUCCEEDED", "execute: build succeeded");
  ok(exec.result?.summary === "STUB_BUILD_OK", "build: reads the result.json summary");
  ok(exec.result?.outputs?.[0]?.path === "artifact.txt", "build: declares artifacts");
  ok(fs.existsSync(path.join(workspace, "artifact.txt")), "build: artifacts land in the workspace");
  s.child.kill("SIGKILL");
}

async function missingCliTest() {
  const s = start("task.chat.worker");
  // Override with a nonexistent command (start a new process with different arguments)
  s.child.kill("SIGKILL");
  const child = spawn(
    process.execPath,
    [wrapper, "--provider", "custom", "--command", "/nonexistent/agent-cli"],
    {
      cwd: workspace,
      env: { PATH: process.env.PATH, PLATFORM_WORKSPACE: workspace },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const lines = [];
  readline.createInterface({ input: child.stdout }).on("line", (l) => lines.push(l));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent.health", params: {} })}\n`);
  await new Promise((r) => setTimeout(r, 500));
  let health;
  try {
    health = JSON.parse(lines[0] ?? "{}");
  } catch {
    health = {};
  }
  ok(health.result?.available === false, "health: a missing CLI reports unavailable");
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "agent.prepare", params: { task: {}, workspace } })}\n`,
  );
  await new Promise((r) => setTimeout(r, 300));
  let prep;
  try {
    prep = JSON.parse(lines[1] ?? "{}");
  } catch {
    prep = {};
  }
  ok(prep.result?.ready === false && /CLI_NOT_INSTALLED/.test(String(prep.result?.reason)), "prepare: a missing CLI refuses execution");
  child.kill("SIGKILL");
}

try {
  await chatTest();
  await passEnvTest();
  await buildTest();
  await missingCliTest();
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nAll passed");
