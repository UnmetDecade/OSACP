import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { roleExecutors } from "../src/roles/index.js";
import { TaskFailed, type ExecContext, type UploadedArtifact } from "../src/exec-types.js";
import { MEDIA, sha256Of } from "../src/roles/common.js";
import type { Assignment } from "../src/client.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "builder-test-"));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

function assignment(partial: Partial<Assignment> = {}): Assignment {
  return {
    task_id: "task_1",
    task_type: "task.build",
    attempt_id: "att_1",
    attempt_number: 1,
    lease_token: "lease-1",
    fencing_token: 1,
    lease_expires_at: "",
    grant_id: "rgr_1",
    payload_ref: null,
    payload_schema: "1.0",
    resource_profile_id: "rp_builder_medium",
    deadline_at: null,
    requirements: {},
    agent: { profile_id: null, version: null },
    api_profiles: [],
    ...partial,
  };
}

interface StoredArtifact {
  data: Buffer;
  sha256: string;
  media_type: string;
}

function makeCtx(instanceId = "builder-ubuntu22-a") {
  const store = new Map<string, StoredArtifact>();
  const uploads: UploadedArtifact[] = [];
  let seq = 0;
  const ctx: ExecContext = {
    signal: new AbortController().signal,
    instanceId,
    workspaceDir: fs.mkdtempSync(path.join(BASE, "ws-")),
    log: () => {},
    progress: () => {},
    async uploadArtifact(content, mediaType = "application/octet-stream") {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const artifact: UploadedArtifact = {
        artifact_id: `art_${++seq}`,
        sha256: sha256Of(data),
        size_bytes: data.length,
      };
      store.set(artifact.artifact_id, { data, sha256: artifact.sha256, media_type: mediaType });
      uploads.push(artifact);
      return artifact;
    },
    async downloadArtifact(artifactId) {
      const v = store.get(artifactId);
      if (!v) throw new Error(`unknown artifact ${artifactId}`);
      return v;
    },
  };
  return { ctx, store, uploads };
}

async function expectTaskFailed(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    assert.fail(`期望抛出 ${code}，实际成功`);
  } catch (e) {
    assert.ok(e instanceof TaskFailed, `期望 TaskFailed，实际 ${e}`);
    assert.equal(e.code, code, `错误码不匹配：${e.code} / ${JSON.stringify(e.detail)}`);
    return e;
  }
}

describe("v4 builder 执行器", () => {
  it("执行 requirements.build.command，并把完整日志落为制品", async () => {
    const { ctx, store, uploads } = makeCtx();
    const task = assignment({
      task_id: "task_build",
      requirements: {
        build: {
          command: "printf 'hello-build'; echo 'warn' >&2",
          workdir: ".",
          env: { CC: "gcc-13" },
        },
      },
    });

    const out = await roleExecutors["task.build"](task, ctx);
    assert.equal(uploads.length, 1);
    assert.equal(store.get(uploads[0].artifact_id)!.media_type, MEDIA.log);
    const log = store.get(uploads[0].artifact_id)!.data.toString("utf8");
    assert.match(log, /hello-build/);
    assert.match(log, /warn/);
    assert.match(log, /command: printf 'hello-build'/);
    assert.equal(out.outputs?.exit_code, 0);
    assert.equal(out.outputs?.stdout_tail, "hello-build");
    assert.match(String(out.summary), /构建完成/);
  });

  it("工作目录固定在 workspace 内，命令以该目录为 cwd", async () => {
    const { ctx } = makeCtx();
    const out = await roleExecutors["task.build"](
      assignment({ requirements: { build: { command: "pwd", workdir: "." } } }),
      ctx,
    );
    assert.equal(String(out.outputs?.stdout_tail).trim(), fs.realpathSync(ctx.workspaceDir));
  });

  it("管理应用传入 workspace 根路径时映射到本次 attempt 目录", async () => {
    const { ctx } = makeCtx();
    const out = await roleExecutors["task.build"](
      assignment({
        requirements: {
          build: { command: "pwd", workdir: path.dirname(ctx.workspaceDir) },
        },
      }),
      ctx,
    );
    assert.equal(String(out.outputs?.stdout_tail).trim(), fs.realpathSync(ctx.workspaceDir));
  });

  it("工作目录越界直接拒绝", async () => {
    const { ctx } = makeCtx();
    await expectTaskFailed(
      () =>
        roleExecutors["task.build"](
          assignment({ requirements: { build: { command: "pwd", workdir: "../.." } } }),
          ctx,
        ),
      "BUILD_WORKDIR_INVALID",
    );
  });

  it("非零退出码 → BUILD_FAILED，并保留日志制品与 stderr 尾部", async () => {
    const { ctx, store, uploads } = makeCtx();
    const err = await expectTaskFailed(
      () =>
        roleExecutors["task.build"](
          assignment({ requirements: { build: { command: "echo boom >&2; exit 3" } } }),
          ctx,
        ),
      "BUILD_FAILED",
    );
    const detail = err.detail as Record<string, unknown>;
    assert.equal(detail.exit_code, 3);
    assert.match(String(detail.stderr_tail), /boom/);
    assert.equal(uploads.length, 1);
    assert.match(store.get(uploads[0].artifact_id)!.data.toString("utf8"), /boom/);
  });

  it("没有 command 时保留确定性清单构建（演示 / 冒烟）", async () => {
    const { ctx, store, uploads } = makeCtx();
    const task = assignment({ task_id: "task_build", payload_ref: "git://repo" });
    const out = await roleExecutors["task.build"](task, ctx);
    assert.equal(uploads.length, 1);
    const manifest = JSON.parse(store.get(uploads[0].artifact_id)!.data.toString("utf8"));
    assert.equal(manifest.schema, "build-manifest/1");
    assert.equal(manifest.built_by, "builder-ubuntu22-a");
    assert.equal(manifest.files.length, 3);
    for (const f of manifest.files) {
      const file = path.join(ctx.workspaceDir, f.path);
      assert.ok(fs.existsSync(file), `工作目录缺少 ${f.path}`);
      assert.equal(sha256Of(fs.readFileSync(file)), f.sha256);
    }
    assert.equal(out.outputs?.artifact_id, uploads[0].artifact_id);
  });
});
