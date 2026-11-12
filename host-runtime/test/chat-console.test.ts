import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Assignment } from "../src/client.js";
import { TaskFailed, type ExecContext } from "../src/exec-types.js";
import {
  chatExecutorFor,
  consoleExecutorFor,
  mustUseDeterministicExecutor,
} from "../src/roles/chat-console.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "chat-console-test-"));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

function assignment(partial: Partial<Assignment> = {}): Assignment {
  return {
    task_id: "task_chat_1",
    task_type: "task.chat.builder",
    attempt_id: "att_1",
    attempt_number: 1,
    lease_token: "lease-1",
    fencing_token: 1,
    lease_expires_at: "",
    grant_id: "rgr_1",
    payload_ref: null,
    payload_schema: "1.0",
    resource_profile_id: "rp_builder_small",
    deadline_at: null,
    requirements: {},
    agent: { profile_id: "agp_builder", version: "1.0.0" },
    api_profiles: [],
    ...partial,
  };
}

function makeCtx(workspaceDir = BASE): ExecContext {
  return {
    signal: new AbortController().signal,
    instanceId: "builder-ubuntu22-a",
    workspaceDir,
    log: () => {},
    progress: () => {},
    async uploadArtifact() {
      return { artifact_id: "art", sha256: "sha256:x", size_bytes: 0 };
    },
    async downloadArtifact() {
      return { data: Buffer.from(""), sha256: "sha256:x", media_type: "application/octet-stream" };
    },
  };
}

describe("chat executor", () => {
  it("返回确定性回复并标记 mode", async () => {
    const task = assignment({
      requirements: {
        chat: { message: "你绑定了哪个 Agent？", session_id: "s1", history: [] },
      },
    });
    const out = await chatExecutorFor("builder")(task, makeCtx());
    const outputs = out.outputs as Record<string, unknown>;
    assert.equal(outputs.mode, "deterministic");
    assert.match(String(outputs.reply), /agp_builder/);
    assert.equal(outputs.role, "builder");
  });

  it("空消息拒绝", async () => {
    await assert.rejects(
      () => chatExecutorFor("builder")(assignment({ requirements: { chat: { message: "  " } } }), makeCtx()),
      (e: unknown) => e instanceof TaskFailed && e.code === "CHAT_MESSAGE_EMPTY",
    );
  });

  it("调度机器人使用自己的身份", async () => {
    const out = await chatExecutorFor("scheduler")(
      assignment({
        task_type: "task.chat.scheduler",
        requirements: { chat: { message: "队列怎么样？" } },
      }),
      makeCtx(),
    );
    const outputs = out.outputs as Record<string, unknown>;
    assert.equal(outputs.role, "scheduler");
    assert.match(String(outputs.reply), /派令/);
  });
});

describe("console executor（完整 shell）", () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(BASE, "hello.txt"), "你好，容器\n");
  });

  it("执行任意 shell，包括管道与复合命令", async () => {
    const out = await consoleExecutorFor("builder")(
      assignment({
        task_type: "task.console.builder",
        requirements: { console: { command: "printf 'a\\nb\\n' | wc -l; echo done", operator: "local@dev" } },
      }),
      makeCtx(),
    );
    const o = out.outputs as Record<string, unknown>;
    assert.equal(o.exit_code, 0);
    assert.match(String(o.stdout), /^\s*2\s*\ndone/m);
    assert.equal(o.operator, "local@dev");
    assert.equal(o.role, "builder");
  });

  it("工作目录是任务 workspace", async () => {
    const out = await consoleExecutorFor("builder")(
      assignment({ requirements: { console: { command: "cat hello.txt && pwd" } } }),
      makeCtx(),
    );
    const stdout = String((out.outputs as any).stdout);
    assert.match(stdout, /你好/);
    assert.match(stdout, new RegExp(BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("返回 stderr 与真实退出码", async () => {
    const out = await consoleExecutorFor("builder")(
      assignment({ requirements: { console: { command: "echo bad >&2; exit 7" } } }),
      makeCtx(),
    );
    const o = out.outputs as Record<string, unknown>;
    assert.equal(o.exit_code, 7);
    assert.match(String(o.stderr), /bad/);
  });

  it("不再限制路径：可以读取工作区外（容器内完整权限）", async () => {
    const out = await consoleExecutorFor("builder")(
      assignment({ requirements: { console: { command: "cd / && ls . >/dev/null && echo outside-ok" } } }),
      makeCtx(),
    );
    assert.match(String((out.outputs as any).stdout), /outside-ok/);
  });

  it("平台令牌不进入命令环境", async () => {
    process.env.PLATFORM_TOOL_TOKEN = "super-secret-token";
    try {
      const out = await consoleExecutorFor("builder")(
        assignment({ requirements: { console: { command: "env" } } }),
        makeCtx(),
      );
      const stdout = String((out.outputs as any).stdout);
      assert.doesNotMatch(stdout, /super-secret-token/);
      assert.doesNotMatch(stdout, /PLATFORM_TOOL_TOKEN/);
    } finally {
      delete process.env.PLATFORM_TOOL_TOKEN;
    }
  });

  it("console 任务永不路由到外部 Agent", () => {
    assert.equal(mustUseDeterministicExecutor("task.console.builder"), true);
    assert.equal(mustUseDeterministicExecutor("task.chat.builder"), false);
  });
});
