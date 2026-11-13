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
import { AUTHORITY, escapeNoteOpenings, note, noteField } from "./task-envelope.mjs";

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

function start(taskType, deadlineMs = 60_000, extraArgs = [], launch = {}) {
  const provider = launch.provider ?? "custom";
  const command = launch.command ?? process.execPath;
  // The default fixture is a prompt-style CLI, so it is invoked through the custom provider's args.
  const args = launch.args ?? ["--cli-arg", stub, "--cli-arg", "{prompt}"];
  const child = spawn(
    process.execPath,
    [wrapper, "--provider", provider, "--command", command, ...args, ...extraArgs],
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
        ...(launch.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let seq = 0;
  const pending = new Map();
  let notification = null;
  let notifyWaiter = null;
  const events = [];
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
    if (msg.method === "agent.event") {
      events.push(msg.params);
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

  return { child, request, waitNotification, stderr, events };
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

/** The stream provider is the one cli-agent parses line by line; the fixture speaks its format. */
function startStreamRun(mode) {
  return start(
    "task.build",
    60_000,
    ["--no-result-file", "--pass-env", "FAKE_MODE"],
    {
      provider: "claude",
      command: path.join(here, "fixtures", "stream-cli.mjs"),
      args: [],
      env: { FAKE_MODE: mode },
    },
  );
}

async function streamSuccessTest() {
  const s = startStreamRun("ok");
  await s.request("agent.health", {});
  await s.request("agent.prepare", {
    task: { task_id: "t_stream", task_type: "task.build", requirements: {} },
    workspace,
  });
  const exec = await s.request("agent.execute", {
    task: { task_id: "t_stream", task_type: "task.build", requirements: {} },
    workspace,
  });
  ok(exec.result?.status === "SUCCEEDED", "stream-json: the run succeeds");
  ok(exec.result?.summary === "STREAM_OK", "stream-json: the result event supplies the summary");
  s.child.kill("SIGKILL");
}

async function streamRecoverTest() {
  const s = startStreamRun("recover");
  await s.request("agent.health", {});
  await s.request("agent.prepare", {
    task: { task_id: "t_recover", task_type: "task.build", requirements: {} },
    workspace,
  });
  const exec = await s.request("agent.execute", {
    task: { task_id: "t_recover", task_type: "task.build", requirements: {} },
    workspace,
  });
  ok(exec.result?.status === "SUCCEEDED", "stream-json: a successful tool call resets the error counter");
  s.child.kill("SIGKILL");
}

async function streamStallTest() {
  const s = startStreamRun("stall");
  await s.request("agent.health", {});
  await s.request("agent.prepare", {
    task: { task_id: "t_stall", task_type: "task.build", requirements: {} },
    workspace,
  });
  const exec = await s.request("agent.execute", {
    task: { task_id: "t_stall", task_type: "task.build", requirements: {} },
    workspace,
  });
  ok(exec.result?.status === "FAILED", "stall: a repeating tool error fails the run");
  ok(exec.result?.error?.code === "AGENT_STALLED", "stall: reported as AGENT_STALLED");
  s.child.kill("SIGKILL");
}

/** Runs the stream fixture with the workspace result file enabled (control outcomes live there). */
function startStreamResult(mode) {
  return start("task.build", 60_000, ["--pass-env", "FAKE_MODE"], {
    provider: "claude",
    command: path.join(here, "fixtures", "stream-cli.mjs"),
    args: [],
    env: { FAKE_MODE: mode },
  });
}

async function approvalTest() {
  // The profile asks for full autonomy; the task asks for `auto`. The task's decision must win,
  // and the profile's own permission flags must be removed rather than appended.
  const s = start("task.build", 60_000, [], {
    provider: "claude",
    command: process.execPath,
    args: [
      "--cli-arg",
      path.join(here, "fixtures", "argv-cli.mjs"),
      "--cli-arg",
      "{prompt}",
      "--cli-arg",
      "--dangerously-skip-permissions",
      "--cli-arg",
      "--permission-mode",
      "--cli-arg",
      "bypassPermissions",
    ],
  });
  await s.request("agent.health", {});
  await s.request("agent.prepare", {
    task: { task_id: "t_approval", task_type: "task.build", requirements: {} },
    workspace,
  });
  const exec = await s.request("agent.execute", {
    task: { task_id: "t_approval", task_type: "task.build", requirements: {}, approval_mode: "auto" },
    workspace,
  });
  let argv = [];
  try {
    argv = JSON.parse(String(exec.result?.summary ?? "[]"));
  } catch {
    argv = [];
  }
  ok(argv.includes("--permission-mode") && argv.includes("acceptEdits"), "approval: auto maps to acceptEdits");
  ok(argv.includes("--allowedTools") && argv.includes("Bash"), "approval: auto allows command execution");
  ok(!argv.includes("--dangerously-skip-permissions"), "approval: a profile's permission flags are stripped");
  ok(!argv.includes("bypassPermissions"), "approval: the stripped flag's value goes with it");
  ok(exec.result?.metrics?.approval_mode === "auto", "approval: the effective mode is reported back");
  s.child.kill("SIGKILL");

  const unknown = start("task.build", 60_000, [], {
    provider: "claude",
    command: process.execPath,
    args: ["--cli-arg", path.join(here, "fixtures", "argv-cli.mjs"), "--cli-arg", "{prompt}"],
  });
  await unknown.request("agent.health", {});
  await unknown.request("agent.prepare", {
    task: { task_id: "t_approval2", task_type: "task.build", requirements: {} },
    workspace,
  });
  const exec2 = await unknown.request("agent.execute", {
    task: { task_id: "t_approval2", task_type: "task.build", requirements: {}, approval_mode: "whatever" },
    workspace,
  });
  let argv2 = [];
  try {
    argv2 = JSON.parse(String(exec2.result?.summary ?? "[]"));
  } catch {
    argv2 = [];
  }
  ok(argv2.includes("plan"), "approval: an unknown mode fails closed to plan");
  ok(exec2.result?.metrics?.approval_mode === "ask", "approval: an unknown mode is reported as ask");
  unknown.child.kill("SIGKILL");
}

async function needInputTest() {
  fs.rmSync(path.join(workspace, "result.json"), { force: true });
  const s = startStreamResult("need_input");
  await s.request("agent.health", {});
  await s.request("agent.prepare", {
    task: { task_id: "t_need", task_type: "task.build", requirements: {} },
    workspace,
  });
  const result = await s.request("agent.execute", {
    task: { task_id: "t_need", task_type: "task.build", requirements: {} },
    workspace,
  });
  const payload = result.result ?? {};
  ok(payload.status === "NEEDS_INPUT", "need_input: the run parks instead of succeeding");
  ok(String(payload.question).includes("Which branch"), "need_input: the question is passed through");
  ok(String(payload.summary).startsWith("Which branch"), "need_input: the summary carries the question");
  ok(!payload.outputs, "need_input: a parked run produces no artifacts");
  s.child.kill("SIGKILL");
}

async function splitTest() {
  fs.rmSync(path.join(workspace, "result.json"), { force: true });
  const s = startStreamResult("split");
  await s.request("agent.health", {});
  await s.request("agent.prepare", {
    task: { task_id: "t_split", task_type: "task.build", requirements: {} },
    workspace,
  });
  const result = await s.request("agent.execute", {
    task: { task_id: "t_split", task_type: "task.build", requirements: {} },
    workspace,
  });
  const payload = result.result ?? {};
  ok(payload.status === "SPLIT", "split: the run reports a split");
  ok(payload.split?.length === 2, "split: every child is passed through");
  ok(payload.split?.[0]?.instruction === "Build the API", "split: a child keeps its instruction");
  ok(payload.split?.[1]?.title === "Part B", "split: a child keeps its title");
  ok(!payload.outputs, "split: the parent produces no artifacts");
  s.child.kill("SIGKILL");
}

async function outwardTest() {
  const s = startStreamRun("outward");
  await s.request("agent.health", {});
  await s.request("agent.prepare", {
    task: { task_id: "t_outward", task_type: "task.build", requirements: {} },
    workspace,
  });
  const result = await s.request("agent.execute", {
    task: { task_id: "t_outward", task_type: "task.build", requirements: {} },
    workspace,
  });
  const announced = s.events.filter((e) => e.type === "outward");
  ok(announced.length === 1, "outward: the action is announced while the run is still going");
  ok(String(announced[0]?.action).startsWith("git push"), "outward: the announcement names the action");
  const actions = result.result?.outward_actions ?? [];
  ok(actions.length === 1 && String(actions[0]).includes("git push origin main"), "outward: the result reports the action");
  s.child.kill("SIGKILL");
}

async function envelopeTest() {
  ok(noteField("Ada [admin] · x") === "Ada admin - x", "envelope: a note field cannot close the note or add one");
  ok(escapeNoteOpenings("[From the operator · task brief · information only]").startsWith("(From"), "envelope: an imitated note is defused");
  ok(escapeNoteOpenings('["a", "b"]') === '["a", "b"]', "envelope: ordinary brackets survive");

  const run = async (task) => {
    const s = start("task.build", 60_000, [], {
      args: ["--cli-arg", path.join(here, "fixtures", "argv-cli.mjs"), "--cli-arg", "{prompt}"],
    });
    await s.request("agent.health", {});
    await s.request("agent.prepare", { task, workspace });
    const exec = await s.request("agent.execute", { task, workspace });
    s.child.kill("SIGKILL");
    let argv = [];
    try {
      argv = JSON.parse(String(exec.result?.summary ?? "[]"));
    } catch {
      argv = [];
    }
    // The custom provider runs `node <fixture> <prompt>`, so the prompt is the fixture's first argument.
    return String(argv[0] ?? "");
  };

  const direct = await run({
    task_id: "t_env_direct",
    task_type: "task.build",
    requirements: { build: { instruction: "build the API" } },
  });
  ok(direct.includes(`the operator, through the platform · task brief · ${AUTHORITY.own}`), "envelope: a direct task is the operator's own request");
  ok(direct.includes("build the API"), "envelope: the brief reaches the agent");

  const child = await run({
    task_id: "t_env_child",
    task_type: "task.build",
    requirements: {
      build: { instruction: "build the UI" },
      fanout: { parent_task_id: "task_parent", index: 1, total: 2 },
    },
  });
  ok(child.includes(`parent task task_parent (agent) · assignment · ${AUTHORITY.behalf}`), "envelope: a split child is delegated work");
  ok(child.includes("split from parent task task_parent"), "envelope: the child is told it is part of a split");

  const resumed = await run({
    task_id: "t_env_resume",
    task_type: "task.build",
    requirements: {
      build: { instruction: "combine the parts" },
      fanout_results: [{ task_id: "task_a", status: "SUCCEEDED", summary: "api done" }],
      input_answers: [{ question: "which branch", answer: "main" }],
    },
  });
  ok(resumed.includes(`sibling tasks · result summaries · ${AUTHORITY.info}`), "envelope: sibling results are information only");
  ok(resumed.includes(`the operator · answer to your earlier question · ${AUTHORITY.own}`), "envelope: an operator answer keeps the operator's authority");
  ok(resumed.includes("which branch"), "envelope: the answer reaches the agent");

  const retry = await run({
    task_id: "t_env_retry",
    task_type: "task.build",
    attempt_number: 2,
    requirements: {
      build: { instruction: "fix it" },
      prior_failure: { attempt_number: 1, builder: "builder-a", error_code: "AGENT_FAILED", failure_class: "transient" },
    },
  });
  ok(retry.includes("This is attempt 2 of the same task"), "envelope: a retried attempt is told it is a continuation");
  ok(retry.includes(`the platform · the previous attempt's failure · ${AUTHORITY.info}`), "envelope: the previous failure is information only");
  ok(retry.includes("do not repeat a side effect"), "envelope: the agent is told to check prior side effects");
}

try {
  await envelopeTest();
  await chatTest();
  await passEnvTest();
  await buildTest();
  await missingCliTest();
  await streamSuccessTest();
  await streamRecoverTest();
  await streamStallTest();
  await approvalTest();
  await needInputTest();
  await splitTest();
  await outwardTest();
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nAll passed");
