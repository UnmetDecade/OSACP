import { after, before, beforeEach, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { closePool, pool, q, q1 } from "../src/db.js";
import { ApiError } from "../src/errors.js";
import { claim } from "../src/core/claim.js";
import { renew, startAck, submitResult } from "../src/core/attempts.js";
import { sweepLeases } from "../src/loops/reaper.js";
import {
  deregister,
  drain,
  heartbeat,
  register,
  resume,
  setCapabilities,
  sweepDrainTimeouts,
  sweepHeartbeats,
  syncConfig,
} from "../src/repo/instances.js";
import { assertSelf, requireInstanceAuth } from "../src/auth.js";
import { requireScope, signJwt } from "../src/jwt.js";
import {
  createArtifact,
  completeArtifact,
  digestOf,
  putArtifactContent,
  readArtifactContent,
} from "../src/core/artifacts.js";
import {
  createWorkflowRun,
  decideApproval,
  getWorkflowRun,
  listApprovalRequests,
  listWorkflowRuns,
} from "../src/core/workflow.js";
import { latestEventId, listOutbox } from "../src/repo/outbox.js";
import { capabilitySnapshot, listNodes, upsertNodeReport } from "../src/repo/federation.js";
import { cancelTask, createTask, getTask, listEvents } from "../src/repo/tasks.js";
import { syncRelays } from "../src/core/relay.js";
import { advance, claimOrFail, newTask, reset, runToSuccess, uploadArtifactFor } from "./helpers.js";

beforeEach(async () => {
  await reset();
});

after(async () => {
  await closePool();
});

async function expectApiError(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    assert.fail(`期望抛出 ${code}，实际成功`);
  } catch (e) {
    assert.ok(e instanceof ApiError, `期望 ApiError，实际 ${e}`);
    assert.equal(e.code, code, `错误码不匹配：${e.code} / ${JSON.stringify((e as ApiError).detail)}`);
  }
}

describe("M1 任务与状态机", () => {
  it("创建任务后为 QUEUED，且写入 TASK_CREATED 事件", async () => {
    const t = await newTask();
    assert.equal(t.status, "QUEUED");
    const events = await listEvents(t.task_id);
    assert.equal(events[0].event_type, "TASK_CREATED");
  });

  it("未定义的任务类型被拒绝", async () => {
    await expectApiError(() => newTask({ task_type: "nope" }), "TASK_TYPE_UNKNOWN");
  });

  it("非法状态迁移被拒绝（表驱动）", async () => {
    const t = await newTask();
    await cancelTask(t.task_id);
    await expectApiError(() => cancelTask(t.task_id), "STATE_CONFLICT");
  });

  it("task_events 只允许追加", async () => {
    const t = await newTask();
    await assert.rejects(
      () => pool.query(`UPDATE task_events SET event_type = 'X' WHERE task_id = $1`, [t.task_id]),
      /append-only/,
    );
  });
});

describe("M2 领取与租约", () => {
  it("领取后任务 ASSIGNED，生成租约、attempt、HELD 预留", async () => {
    const t = await newTask();
    const a = await claimOrFail("worker-a");

    assert.equal(a.task_id, t.task_id);
    assert.equal(a.fencing_token, 1);
    const task = await getTask(t.task_id);
    assert.equal(task.status, "ASSIGNED");
    assert.equal(task.attempt_count, 1);

    const res = await q1<{ state: string }>(
      `SELECT state FROM resource_reservations WHERE attempt_id = $1`,
      [a.attempt_id],
    );
    assert.equal(res?.state, "HELD");
  });

  it("实例并发上限默认 1：同一实例第二次领取返回空", async () => {
    await newTask();
    await newTask();
    await claimOrFail("worker-a");
    assert.equal(await claim({ instance_id: "worker-a" }), null);
  });

  it("两个实例并发领取不会拿到同一个任务", async () => {
    await q(`UPDATE scheduler_config SET instance_limit = 5, task_type_limit = 50`);
    for (let i = 0; i < 10; i++) await newTask();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        claim({ instance_id: i % 2 === 0 ? "worker-a" : "worker-b" }),
      ),
    );
    const ids = results.filter(Boolean).map((r) => r!.task_id);
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 10, "出现重复领取");
  });

  it("start-ack 后 RUNNING，预留转 ACTIVE", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    });
    const task = await getTask(a.task_id);
    assert.equal(task.status, "RUNNING");
    const res = await q1<{ state: string }>(
      `SELECT state FROM resource_reservations WHERE attempt_id = $1`,
      [a.attempt_id],
    );
    assert.equal(res?.state, "ACTIVE");
  });

  it("重复 start-ack 幂等", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");
    const proof = {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    };
    await startAck(a.attempt_id, proof);
    const again = await startAck(a.attempt_id, proof);
    assert.equal((again as any).idempotent, true);
  });

  it("未 start-ack 直接报结果 → STATE_CONFLICT", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");
    await expectApiError(
      () =>
        submitResult(a.attempt_id, {
          lease_token: a.lease_token,
          fencing_token: a.fencing_token,
          status: "SUCCEEDED",
        }),
      "STATE_CONFLICT",
    );
  });

  it("续租延长 expires_at", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");
    const before = new Date(a.lease_expires_at).getTime();
    await advance(60);
    const r = await renew(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
    });
    assert.ok(new Date(r.lease_expires_at).getTime() > before);
  });
});

describe("M3 fencing 与重复执行", () => {
  it("成功结果幂等：同一 attempt 重复上报返回首次结果", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");
    const proof = {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    };
    await startAck(a.attempt_id, proof);
    await submitResult(a.attempt_id, { ...proof, status: "SUCCEEDED", summary: "第一次" });
    const second = await submitResult(a.attempt_id, { ...proof, status: "FAILED" });
    assert.equal((second as any).idempotent, true);
    assert.equal((second as any).attempt_status, "SUCCEEDED");
  });

  it("fencing 不匹配的写入被拒绝", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");
    await expectApiError(
      () =>
        startAck(a.attempt_id, {
          lease_token: a.lease_token,
          fencing_token: 999,
          instance_id: "worker-a",
        }),
      "FENCING_STALE",
    );
  });

  it("租约被回收后，旧 attempt 的结果写入被 FENCING_STALE 挡住", async () => {
    const t = await newTask();
    const first = await claimOrFail("worker-a");
    await startAck(first.attempt_id, {
      lease_token: first.lease_token,
      fencing_token: first.fencing_token,
      instance_id: "worker-a",
    });

    // 实例“失联”：租约过期
    await advance(301);
    const swept = await sweepLeases();
    assert.equal(swept.reclaimed.length, 1);
    assert.equal(swept.reclaimed[0].cause, "LEASE_EXPIRED");

    // 退避结束后新实例接手，fencing 变为 2
    await advance(301);
    const second = await claimOrFail("worker-b");
    assert.equal(second.fencing_token, 2);

    // 旧 attempt 这时才回写结果 —— 必须被拒绝
    await expectApiError(
      () =>
        submitResult(first.attempt_id, {
          lease_token: first.lease_token,
          fencing_token: first.fencing_token,
          status: "SUCCEEDED",
          summary: "迟到的成功（毒消息）",
        }),
      "FENCING_STALE",
    );

    // 新 attempt 正常完成
    await startAck(second.attempt_id, {
      lease_token: second.lease_token,
      fencing_token: second.fencing_token,
      instance_id: "worker-b",
    });
    const r = await submitResult(second.attempt_id, {
      lease_token: second.lease_token,
      fencing_token: second.fencing_token,
      status: "SUCCEEDED",
      summary: "ok",
    });
    assert.equal((r as any).task.status, "SUCCEEDED");

    const events = await listEvents(t.task_id);
    const types = events.map((e) => e.event_type);
    assert.ok(types.includes("TASK_RECLAIMED"));
    assert.ok(types.includes("TASK_SUCCEEDED"));
  });

  it("启动窗口 30s 未 ack 即回收，且不把 RUNNING 任务判成失败", async () => {
    await newTask();
    await claimOrFail("worker-a");
    await advance(31);
    const r = await sweepLeases();
    assert.equal(r.reclaimed[0].cause, "START_TIMEOUT");
    assert.equal(r.reclaimed[0].to, "QUEUED");
  });

  it("本机准入拒绝不消耗重试次数", async () => {
    const t = await newTask();
    const a = await claimOrFail("worker-a");
    const out = await startAck(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      status: "x" as never,
      accepted: false,
    } as any);
    assert.equal((out as any).status, "REJECTED");
    const task = await getTask(t.task_id);
    assert.equal(task.status, "QUEUED");
    assert.equal(task.attempt_count, 0);

    // 再次领取必须成功：attempt_number 不能因为 attempt_count 回退而复用
    const b = await claimOrFail("worker-b");
    assert.equal(b.attempt_number, 2);
    const rows = await q1<{ n: string }>(
      `SELECT count(*)::text AS n FROM task_attempts WHERE task_id = $1`,
      [t.task_id],
    );
    assert.equal(rows?.n, "2");
  });
});

describe("M4 重试与死信", () => {
  it("可重试失败 → 退避回队，退避期内不可领取", async () => {
    const t = await newTask();
    const a = await claimOrFail("worker-a");
    const proof = {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    };
    await startAck(a.attempt_id, proof);
    const r = await submitResult(a.attempt_id, {
      ...proof,
      status: "FAILED",
      error: { code: "TEST_FAILED" },
    });
    assert.equal((r as any).retry_in_seconds, 300);

    const task = await getTask(t.task_id);
    assert.equal(task.status, "QUEUED");

    // 退避期内领不到
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    await advance(301);
    assert.ok(await claim({ instance_id: "worker-a" }));
  });

  it("重试耗尽 → FAILED + 死信", async () => {
    const t = await newTask({ max_attempts: 2 });
    for (let i = 0; i < 2; i++) {
      const a = await claimOrFail("worker-a");
      await startAck(a.attempt_id, {
        lease_token: a.lease_token,
        fencing_token: a.fencing_token,
        instance_id: "worker-a",
      });
      await submitResult(a.attempt_id, {
        lease_token: a.lease_token,
        fencing_token: a.fencing_token,
        status: "FAILED",
        error: { code: "TEST_FAILED" },
      });
      await advance(301);
    }
    const task = await getTask(t.task_id);
    assert.equal(task.status, "FAILED");
    assert.equal(task.dead_letter, true);
    const types = (await listEvents(t.task_id)).map((e) => e.event_type);
    assert.ok(types.includes("TASK_DEAD_LETTERED"));
  });

  it("不可重试错误立即失败，不消耗后续重试", async () => {
    const t = await newTask();
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    });
    const r = await submitResult(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      status: "FAILED",
      error: { code: "PAYLOAD_INVALID" },
    });
    assert.equal((r as any).dead_letter, true);
    assert.equal((await getTask(t.task_id)).status, "FAILED");
  });
});

describe("预留核对与孤儿 grant", () => {
  it("租约回收后旧预留关闭，新 attempt 使用新 grant，无残留 HELD/ACTIVE", async () => {
    const t = await newTask();
    const a = await claimOrFail("worker-a");
    const old = await q1<{ grant_id: string; state: string }>(
      `SELECT grant_id, state FROM resource_reservations WHERE attempt_id = $1`,
      [a.attempt_id],
    );
    assert.equal(old?.state, "HELD");
    assert.equal(old?.grant_id, a.grant_id);

    await advance(301);
    const swept = await sweepLeases();
    assert.equal(swept.reclaimed.length, 1);

    const closed = await q1<{ state: string; closed_at: string | null; close_reason: string }>(
      `SELECT state, closed_at, close_reason FROM resource_reservations WHERE attempt_id = $1`,
      [a.attempt_id],
    );
    assert.equal(closed?.state, "RECLAIMED");
    assert.ok(closed?.closed_at);
    assert.equal(closed?.close_reason, "LEASE_EXPIRED");

    const orphan = await q1<{ n: string }>(
      `SELECT count(*)::text AS n FROM resource_reservations WHERE state IN ('HELD','ACTIVE')`,
    );
    assert.equal(orphan?.n, "0");

    // 退避结束后由另一个实例接管，必须拿到新的 grant_id
    await advance(300);
    const b = await claimOrFail("worker-b");
    assert.notEqual(b.grant_id, a.grant_id);
    const fresh = await q1<{ grant_id: string; state: string }>(
      `SELECT grant_id, state FROM resource_reservations WHERE attempt_id = $1`,
      [b.attempt_id],
    );
    assert.equal(fresh?.grant_id, b.grant_id);
    assert.equal(fresh?.state, "HELD");
    assert.equal((await getTask(t.task_id)).status, "ASSIGNED");
  });

  it("取消 ack 后预留按 RELEASED 关闭", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");
    const proof = {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    };
    await startAck(a.attempt_id, proof);
    await submitResult(a.attempt_id, { ...proof, status: "CANCELLED" });

    const res = await q1<{ state: string; close_reason: string }>(
      `SELECT state, close_reason FROM resource_reservations WHERE attempt_id = $1`,
      [a.attempt_id],
    );
    assert.equal(res?.state, "RELEASED");
    assert.equal(res?.close_reason, "TASK_CANCELLED");
  });
});

describe("M2 心跳与健康", () => {
  it("45s 无心跳 → SUSPECT 且不再领取；90s → OFFLINE", async () => {
    await newTask();
    await advance(46);
    const hb = await sweepHeartbeats({ suspectAfter: 45, offlineAfter: 90 });
    assert.deepEqual(hb.suspect.filter((id) => id.startsWith("worker-")).sort(), [
      "worker-a",
      "worker-b",
    ]);

    await expectApiError(() => claim({ instance_id: "worker-a" }), "INSTANCE_NOT_ELIGIBLE");

    await advance(45); // 累计 91s
    const hb2 = await sweepHeartbeats({ suspectAfter: 45, offlineAfter: 90 });
    assert.deepEqual(hb2.offline.filter((id) => id.startsWith("worker-")).sort(), [
      "worker-a",
      "worker-b",
    ]);
  });

  it("SUSPECT 不回收在途租约", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    });
    await advance(46);
    await sweepHeartbeats({ suspectAfter: 45, offlineAfter: 90 });
    // 租约仍在
    const lease = await q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM leases WHERE task_id = $1 AND released_at IS NULL`,
      [a.task_id],
    );
    assert.equal(lease?.n, 1);
  });
});

describe("排序与准入", () => {
  it("老化：P2 等够 600s 后与 P1 同权，按入队时间先出", async () => {
    const older = await newTask({ priority_class: 2 });
    await advance(700);
    const newer = await newTask({ priority_class: 1 });

    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, older.task_id, "老化后应先领取更早入队的任务");

    const events = await listEvents(older.task_id);
    assert.ok(events.some((e) => e.event_type === "TASK_AGED"));

    // 新任务仍在排队
    assert.equal((await getTask(newer.task_id)).status, "QUEUED");
  });

  it("P0 不参与老化", async () => {
    const p0 = await newTask({ priority_class: 0 });
    await advance(1800);
    await newTask({ priority_class: 1 });
    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, p0.task_id);
  });

  it("主机 PROTECTING 时停止派发", async () => {
    await newTask();
    await q(`UPDATE hosts SET host_state = 'PROTECTING' WHERE host_id = 'host-a'`);
    await expectApiError(() => claim({ instance_id: "worker-a" }), "HOST_NOT_ELIGIBLE");
  });

  it("宿主机内存不足 → 任务保持 QUEUED 并写 resource_block_reason", async () => {
    await q(`UPDATE hosts SET mem_available_bytes = 1000 WHERE host_id = 'host-a'`);
    const t = await newTask();
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    const task = await getTask(t.task_id);
    assert.equal(task.status, "QUEUED");
    assert.equal(task.resource_block_reason, "INSUFFICIENT_MEMORY");
    assert.ok(task.resource_evaluated_at);

    // 资源恢复后可以领取
    await q(`UPDATE hosts SET mem_available_bytes = 12884901888 WHERE host_id = 'host-a'`);
    await claimOrFail("worker-a");
  });
});

describe("取消", () => {
  it("QUEUED 取消立即生效", async () => {
    const t = await newTask();
    const out = await cancelTask(t.task_id, "tester");
    assert.equal((out as any).status, "CANCELLED");
  });

  it("RUNNING 取消只登记请求，等实例 ack", async () => {
    const t = await newTask();
    const a = await claimOrFail("worker-a");
    const proof = {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    };
    await startAck(a.attempt_id, proof);

    const out = await cancelTask(t.task_id, "tester");
    assert.equal((out as any).status, "RUNNING");

    const r = await submitResult(a.attempt_id, { ...proof, status: "CANCELLED" });
    assert.equal((r as any).task.status, "CANCELLED");
  });
});

describe("M5 实例生命周期", () => {
  it("能力只能收窄：缩小成功，扩大 403", async () => {
    await register({
      instance_id: "worker-a",
      role_id: "worker",
      host_id: "host-a",
      agent_profile_id: "agent-w1",
      allowed_task_types: ["task.build"],
      capabilities: { healthy: ["code.edit", "shell"] },
      config_version: 1,
    });

    const ok = await setCapabilities("worker-a", {
      declared: { capabilities: ["code.edit"], task_types: ["task.build"] },
    });
    assert.deepEqual((ok as any).capabilities.healthy, ["code.edit"]);

    // 能力不能扩到声明之外
    await expectApiError(
      () => setCapabilities("worker-a", { declared: { capabilities: ["code.edit", "gpu"] } }),
      "CAPABILITY_MISMATCH",
    );
    // 任务类型不能越过白名单
    await expectApiError(
      () => setCapabilities("worker-a", { declared: { task_types: ["task.commit"] } }),
      "CAPABILITY_MISMATCH",
    );
  });

  it("drain 停止领取、在途继续；心跳不能撤销 drain，resume 恢复", async () => {
    const t1 = await newTask();
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    });
    await newTask();

    const d = await drain("worker-a", { timeout_seconds: 60, reason: "deploy_upgrade" });
    assert.equal((d as any).state, "DRAINING");
    assert.equal((d as any).active_attempts, 1);

    // 不再派发新任务
    await expectApiError(() => claim({ instance_id: "worker-a" }), "INSTANCE_NOT_ELIGIBLE");

    // 在途任务可以正常结束
    await submitResult(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      status: "SUCCEEDED",
      summary: "ok",
    });

    // 心跳上报 ONLINE 不能把管理员下发的 DRAINING 覆盖掉
    await heartbeat({ instance_id: "worker-a", state: "ONLINE" });
    const inst = await q1<{ state: string }>(
      `SELECT state FROM role_instances WHERE instance_id = 'worker-a'`,
    );
    assert.equal(inst?.state, "DRAINING");

    const r = await resume("worker-a");
    assert.equal((r as any).state, "ONLINE");
    const next = await claimOrFail("worker-a");
    assert.notEqual(next.task_id, t1.task_id);
  });

  it("drain 超时未完成 → OFFLINE", async () => {
    await drain("worker-a", { timeout_seconds: 60 });
    await advance(61);
    assert.deepEqual(await sweepDrainTimeouts(), ["worker-a"]);
    const inst = await q1<{ state: string }>(
      `SELECT state FROM role_instances WHERE instance_id = 'worker-a'`,
    );
    assert.equal(inst?.state, "OFFLINE");
  });

  it("有在途任务时不能注销；force=true 放行", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    });

    await expectApiError(() => deregister("worker-a", { reason: "shutdown" }), "STATE_CONFLICT");

    const out = await deregister("worker-a", { reason: "shutdown", force: true });
    assert.equal((out as any).state, "OFFLINE");
    assert.equal((out as any).active_attempts, 1);
    await expectApiError(() => claim({ instance_id: "worker-a" }), "INSTANCE_NOT_ELIGIBLE");
  });

  it("config-sync：版本未变返回 null（HTTP 304），变了返回新配置", async () => {
    const cfg = await syncConfig("worker-a");
    assert.equal((cfg as any).config_version, 1);
    assert.deepEqual((cfg as any).allowed_task_types, ["task.build"]);
    assert.equal(await syncConfig("worker-a", 1), null);

    await q(`UPDATE role_instances SET config_version = 2 WHERE instance_id = 'worker-a'`);
    const cfg2 = await syncConfig("worker-a", 1);
    assert.equal((cfg2 as any).config_version, 2);
  });

  it("P4：信封只带 Agent/API Profile 引用，config-sync 只同步引用", async () => {
    await register({
      instance_id: "worker-a",
      role_id: "worker",
      host_id: "host-a",
      agent_profile_id: "agp_worker_alpha",
      agent_profile_version: "1.0.0",
      api_profile_ids: ["api_mock", "api_meta"],
      allowed_task_types: ["task.build"],
      capabilities: { healthy: ["code.edit", "shell"] },
      config_version: 1,
    });

    const t = await newTask();
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    });
    assert.deepEqual(a.agent, { profile_id: "agp_worker_alpha", version: "1.0.0" });
    assert.deepEqual(a.api_profiles, ["api_mock", "api_meta"]);

    // 信封里没有实现、地址或密钥值，只有引用
    const envelope = JSON.stringify({
      task_id: a.task_id,
      requirements: a.requirements,
      agent: a.agent,
      api_profiles: a.api_profiles,
    });
    assert.ok(!envelope.includes("secret://"));
    assert.ok(!envelope.includes("base_url"));
    assert.ok(!envelope.includes("entrypoint"));

    const cfg = await syncConfig("worker-a");
    assert.deepEqual((cfg as any).agent, {
      profile_id: "agp_worker_alpha",
      version: "1.0.0",
      args: {},
    });
    assert.deepEqual((cfg as any).api_profiles, ["api_mock", "api_meta"]);

    // 换 Agent：只改引用，信封随之变化；任务定义与代码不动
    await register({
      instance_id: "worker-a",
      role_id: "worker",
      host_id: "host-a",
      agent_profile_id: "agp_worker_beta",
      agent_profile_version: "1.0.0",
      api_profile_ids: ["api_mock", "api_meta"],
      allowed_task_types: ["task.build"],
      capabilities: { healthy: ["code.edit", "shell"] },
      config_version: 1,
    });
    await submitResult(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      status: "SUCCEEDED",
      summary: "done",
    });
    await newTask();
    const b = await claimOrFail("worker-a");
    assert.equal(b.agent.profile_id, "agp_worker_beta");
    assert.equal(t.task_id !== b.task_id, true);
  });

  it("设置 AUTH_TOKEN 后，实例接口缺令牌/错令牌 → 401", () => {
    const old = process.env.AUTH_TOKEN;
    process.env.AUTH_TOKEN = "s3cret-token";
    try {
      const call = (headers: Record<string, string> = {}) =>
        requireInstanceAuth({ headers } as any);
      assert.throws(call, (e: any) => e.code === "UNAUTHENTICATED");
      assert.throws(
        () => call({ authorization: "Bearer wrong" }),
        (e: any) => e.code === "UNAUTHENTICATED",
      );
      assert.doesNotThrow(() => call({ authorization: "Bearer s3cret-token" }));
    } finally {
      if (old === undefined) delete process.env.AUTH_TOKEN;
      else process.env.AUTH_TOKEN = old;
    }
  });
});

describe("M6 Outbox 与事件推送", () => {
  it("创建任务与 outbox 同事务写入，字段完整", async () => {
    const t = await newTask();
    const created = (await listOutbox(0)).find((e) => e.event_type === "TASK_CREATED");
    assert.ok(created, "outbox 里应有 TASK_CREATED");
    assert.equal(created.aggregate_type, "task");
    assert.equal(created.aggregate_id, t.task_id);
    assert.equal(created.schema_version, "1.0");
    assert.equal(created.aggregate_version, "1");
    const payload = created.payload as any;
    assert.equal(payload.task_id, t.task_id);
    assert.equal(payload.to_status, "QUEUED");
  });

  it("状态迁移事件带 attempt / fencing，顺序可续传", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");

    const all = await listOutbox(0);
    const assigned = all.find((e) => e.event_type === "TASK_ASSIGNED");
    assert.ok(assigned);
    const payload = assigned.payload as any;
    assert.equal(payload.payload.attempt_id, a.attempt_id);
    assert.equal(payload.payload.fencing_token, a.fencing_token);
    assert.equal(assigned.aggregate_version, "2", "assign 后 version 应为 2");

    // 游标：after 只拿更新的事件
    const firstId = Number(all[0].event_id);
    const rest = await listOutbox(firstId);
    assert.ok(rest.length < all.length);
    assert.ok(rest.every((e) => Number(e.event_id) > firstId));
    assert.equal(await latestEventId(), Number(all[all.length - 1].event_id));
  });

  it("outbox 只允许追加", async () => {
    await newTask();
    await assert.rejects(
      () => pool.query(`UPDATE outbox_events SET event_type = 'X'`),
      /append-only/,
    );
  });
});

describe("并发压力", () => {
  it("30 个任务、3 个实例（含提升并发）不重不漏", async () => {
    await q(
      `UPDATE scheduler_config SET instance_limit = 10, role_pool_limit = 200,
              global_limit = 200, task_type_limit = 200`,
    );
    await q(
      `INSERT INTO role_instances (instance_id, role_id, host_id, state, agent_profile_id,
                                   allowed_task_types, capabilities, last_heartbeat_at)
       VALUES ('worker-c','worker','host-a','ONLINE','agent-w1',ARRAY['task.build'],
               '{"healthy":["code.edit","shell"]}', app_now())`,
    );
    for (let i = 0; i < 30; i++) await newTask();

    const ids: string[] = [];
    for (let round = 0; round < 12; round++) {
      const batch = await Promise.all(
        ["worker-a", "worker-b", "worker-c"].map((i) => claim({ instance_id: i })),
      );
      for (const b of batch) if (b) ids.push(b.task_id);
    }

    assert.equal(new Set(ids).size, ids.length, "有任务被重复领取");
    assert.equal(ids.length, 30, `领取数量不对：${ids.length}`);

    const counts = await q<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM tasks GROUP BY status`,
    );
    assert.deepEqual(counts, [{ status: "ASSIGNED", n: 30 }]);
  });
});

describe("M7 工作流与审批（签名令牌 + 制品摘要）", () => {
  // 每个测试进程生成一次性 ES256 密钥对，私钥只在测试内存里
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
  const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const OP = "alice";
  const now = () => Math.floor(Date.now() / 1000);

  before(() => {
    process.env.PCS_PUBLIC_KEY = PUBLIC_PEM;
  });
  after(() => {
    delete process.env.PCS_PUBLIC_KEY;
  });

  function approvalToken(opts: {
    requestId: string;
    operator?: string;
    digest?: string | null;
    scope?: string[];
    ttl?: number;
    jti?: string;
  }): string {
    const operator = opts.operator ?? OP;
    return signJwt(
      {
        iss: "platform-control",
        aud: "scheduler",
        sub: `operator:${operator}`,
        typ: "approval",
        approval_request_id: opts.requestId,
        operator_id: operator,
        subject_digest: opts.digest ?? null,
        action_scope: opts.scope ?? ["svn.commit"],
        scopes: ["approval:decide"],
        iat: now(),
        exp: now() + (opts.ttl ?? 600),
        jti: opts.jti ?? `tok_${randomUUID()}`,
      },
      PRIVATE_PEM,
    );
  }

  function instanceToken(opts: { sub?: string; scopes?: string[]; ttl?: number; aud?: string } = {}): string {
    return signJwt(
      {
        iss: "platform-control",
        aud: opts.aud ?? "scheduler",
        sub: opts.sub ?? "worker-a",
        role: "worker",
        host_id: "host-a",
        scopes: opts.scopes ?? [
          "instance:register",
          "instance:claim",
          "task:report",
          "artifact:write",
        ],
        iat: now(),
        exp: now() + (opts.ttl ?? 600),
        jti: `tok_${randomUUID()}`,
      },
      PRIVATE_PEM,
    );
  }

  /** 起一个 wft_test 工作流，把 EXECUTE / REVIEW 跑成功，并走完制品通道 */
  async function reachApproval() {
    const { run, task } = await createWorkflowRun({
      workflow_template_id: "wft_test",
      priority_class: 1,
      payload_sha256: "sha256:payload",
    });
    await runToSuccess("worker-a", task.task_id);

    const review = await claimOrFail("reviewer-a");
    await startAck(review.attempt_id, {
      lease_token: review.lease_token,
      fencing_token: review.fencing_token,
      instance_id: "reviewer-a",
    });
    // 制品内容 → 服务端重算的摘要，这才是审批绑定的对象
    const digest = await uploadArtifactFor(
      review.task_id,
      `review diff for ${review.task_id}`,
    );
    await submitResult(review.attempt_id, {
      lease_token: review.lease_token,
      fencing_token: review.fencing_token,
      instance_id: "reviewer-a",
      status: "SUCCEEDED",
      // 故意上报一个假的摘要：审批必须采用制品通道确认的值
      outputs: { subject_digest: "sha256:spoofed-by-executor" },
    });

    const waiting = (await getWorkflowRun((run as any).workflow_run_id)) as any;
    const request = waiting.approval_requests[0];
    return {
      runId: (run as any).workflow_run_id as string,
      reviewTaskId: review.task_id,
      requestId: request.approval_request_id as string,
      digest,
    };
  }

  it("工作流创建不能自带制品交接或审批字段", async () => {
    const { task } = await createWorkflowRun({
      workflow_template_id: "wft_test",
      requirements: {
        capabilities: ["code.edit"],
        upstream_artifacts: [{ artifact_id: "art_forged", sha256: "sha256:" + "a".repeat(64) }],
        approval_id: "apr_forged",
        approval_subject_digest: "sha256:" + "b".repeat(64),
        approved_action_scope: ["svn.commit"],
      } as any,
    });
    // 交接与审批字段只能由调度机在阶段推进 / 审批时写入
    assert.deepEqual((task as any).requirements, { capabilities: ["code.edit"] });
  });

  it("阶段推进：EXECUTE → REVIEW → WAITING_APPROVAL，审批后 COMMIT → VERIFY → COMPLETED", async () => {
    const { runId, reviewTaskId, requestId, digest } = await reachApproval();

    const waiting = (await getWorkflowRun(runId)) as any;
    assert.equal(waiting.status, "WAITING_APPROVAL");
    assert.equal(waiting.current_phase, "APPROVE");
    assert.equal(waiting.approval_requests.length, 1);
    assert.equal(waiting.approval_requests[0].status, "PENDING");

    // 管理应用审批中心的数据源：带任务 / 工作流上下文，管理应用不需要拼 SQL。
    const listed = (await listApprovalRequests({ status: "PENDING" })) as any[];
    const row = listed.find((x) => x.approval_request_id === requestId);
    assert.ok(row, "待审批列表应包含当前请求");
    assert.equal(row.task_id, reviewTaskId);
    assert.equal(row.target_role, "reviewer");
    assert.equal(row.workflow_status, "WAITING_APPROVAL");
    assert.deepEqual(row.action_scope, ["svn.commit"]);
    assert.ok(row.evidence?.some((e: string) => e.startsWith("text/plain:")));
    // 摘要来自服务端校验过的制品，不是执行器 outputs 里那个 spoofed 值
    assert.equal(waiting.approval_requests[0].subject_digest, digest);
    assert.notEqual(waiting.approval_requests[0].subject_digest, "sha256:spoofed-by-executor");

    // 令牌绑定的摘要不对 → 拒绝
    await expectApiError(
      () =>
        decideApproval({
          task_id: reviewTaskId,
          decision: "APPROVED",
          operator_id: OP,
          approval_token: approvalToken({
            requestId,
            digest: "sha256:" + "0".repeat(64),
          }),
        }),
      "APPROVAL_SUBJECT_CHANGED",
    );

    // 令牌不是为这条请求签发的 → 拒绝
    await expectApiError(
      () =>
        decideApproval({
          task_id: reviewTaskId,
          decision: "APPROVED",
          operator_id: OP,
          approval_token: approvalToken({ requestId: "aprq_other", digest }),
        }),
      "ROLE_NOT_ALLOWED",
    );

    const decided = await decideApproval({
      task_id: reviewTaskId,
      decision: "APPROVED",
      operator_id: OP,
      approval_token: approvalToken({ requestId, digest }),
      subject_digest: digest,
    });
    assert.equal((decided.run as any).status, "READY_FOR_COMMIT");
    assert.equal((decided.task as any).task_type, "task.commit");

    await runToSuccess("reviewer-a", (decided.task as any).task_id);
    const verifying = (await getWorkflowRun(runId)) as any;
    assert.equal(verifying.status, "VERIFYING");
    assert.equal(verifying.current_phase, "VERIFY");

    const verifyTask = verifying.tasks.find((t: any) => t.status === "QUEUED");
    assert.ok(verifyTask, "应创建 VERIFY 阶段任务");
    assert.equal(verifyTask.task_type, "task.test.run");
    await runToSuccess("tester-a", verifyTask.task_id);

    const done = (await getWorkflowRun(runId)) as any;
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.current_task_id, null);
    assert.equal(done.tasks.length, 4, "EXECUTE/REVIEW/COMMIT/VERIFY 各一个任务");

    const types = done.tasks.map((t: any) => t.task_type).sort();
    assert.deepEqual(types, ["task.build", "task.commit", "task.review.snapshot", "task.test.run"]);

    const events = (await listOutbox(0)).filter(
      (e) => e.aggregate_type === "workflow" && e.aggregate_id === runId,
    );
    const typesSeen = events.map((e) => e.event_type);
    for (const t of [
      "WORKFLOW_CREATED",
      "WORKFLOW_PHASE_STARTED",
      "WORKFLOW_WAITING_APPROVAL",
      "APPROVAL_DECIDED",
      "WORKFLOW_COMPLETED",
    ]) {
      assert.ok(typesSeen.includes(t), `outbox 缺少 ${t}: ${typesSeen.join(",")}`);
    }
  });

  it("拒绝审批 → 工作流 FAILED，不创建 COMMIT 任务", async () => {
    const { runId, reviewTaskId, requestId, digest } = await reachApproval();

    const out = await decideApproval({
      task_id: reviewTaskId,
      decision: "REJECTED",
      operator_id: OP,
      approval_token: approvalToken({ requestId, digest }),
      comment: "diff 有问题",
    });
    assert.equal((out.run as any).status, "FAILED");
    assert.equal(out.task, null);

    const run = (await getWorkflowRun(runId)) as any;
    assert.equal(run.status, "FAILED");
    assert.equal(
      run.tasks.some((t: any) => t.task_type === "task.commit"),
      false,
      "拒绝后不应有 COMMIT 任务",
    );
    assert.equal(run.approval_requests[0].status, "REJECTED");
  });

  it("审批令牌一次性：jti 已落库的令牌不能再用", async () => {
    const { reviewTaskId, requestId, digest } = await reachApproval();
    const token = approvalToken({ requestId, digest, jti: "tok-fixed-once" });

    await decideApproval({
      task_id: reviewTaskId,
      decision: "APPROVED",
      operator_id: OP,
      approval_token: token,
    });

    // 人为把请求改回 PENDING，模拟“请求被重新打开”；
    // 此时令牌本身仍有效，只能靠 jti 唯一拦下重放
    await q(
      `UPDATE approval_requests SET status = 'PENDING', decided_at = NULL
        WHERE approval_request_id = $1`,
      [requestId],
    );
    await expectApiError(
      () =>
        decideApproval({
          task_id: reviewTaskId,
          decision: "APPROVED",
          operator_id: OP,
          approval_token: token,
        }),
      "APPROVAL_TOKEN_USED",
    );
  });

  it("审批人必须是令牌里的 operator", async () => {
    const { reviewTaskId, requestId, digest } = await reachApproval();
    await expectApiError(
      () =>
        decideApproval({
          task_id: reviewTaskId,
          decision: "APPROVED",
          operator_id: "bob",
          approval_token: approvalToken({ requestId, digest, operator: OP }),
        }),
      "ROLE_NOT_ALLOWED",
    );
  });

  it("无 PCS 公钥时审批 fail closed；实例令牌签名、受众、scope、自证都校验", async () => {
    const saved = process.env.PCS_PUBLIC_KEY;
    // 1) 没配置公钥：审批直接 503
    delete process.env.PCS_PUBLIC_KEY;
    try {
      await assert.rejects(
        () =>
          decideApproval({
            task_id: "task_x",
            decision: "APPROVED",
            operator_id: OP,
            approval_token: "not-a-jwt",
          }),
        (e: any) => e.code === "APPROVAL_NOT_CONFIGURED",
      );
      // 实例鉴权退回共享令牌模式（未配置 AUTH_TOKEN 则放行）
      assert.equal(requireInstanceAuth({ headers: {} } as any), null);
    } finally {
      process.env.PCS_PUBLIC_KEY = saved;
    }

    // 2) 配了公钥后，实例接口必须拿到合法 JWT
    const call = (token?: string) =>
      requireInstanceAuth({ headers: token ? { authorization: `Bearer ${token}` } : {} } as any);

    assert.throws(() => call(), (e: any) => e.code === "UNAUTHENTICATED");
    assert.throws(
      () => call(instanceToken({ sub: "worker-a", aud: "someone-else" })),
      (e: any) => e.code === "TOKEN_INVALID",
    );
    assert.throws(
      () => call(instanceToken({ sub: "worker-a", ttl: -3600 })),
      (e: any) => e.code === "TOKEN_EXPIRED",
    );

    const auth = call(instanceToken({ sub: "worker-a" }));
    assert.equal(auth?.kind, "jwt");
    assert.equal(auth?.instance_id, "worker-a");

    // 伪造签名（用另一把私钥重签）被拒
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const forged = signJwt(
      { iss: "platform-control", aud: "scheduler", sub: "worker-b", exp: now() + 600 },
      other.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    assert.throws(() => call(forged), (e: any) => e.code === "TOKEN_INVALID");

    // 令牌主体不能冒充别的 instance
    assert.throws(() => assertSelf(auth!, "worker-b"), (e: any) => e.code === "ROLE_NOT_ALLOWED");
    assert.doesNotThrow(() => assertSelf(auth!, "worker-a"));

    // scope 是硬边界
    const limited = call(instanceToken({ sub: "worker-a", scopes: ["instance:claim"] }));
    assert.throws(
      () => requireScope(limited!.claims!, "task:report"),
      (e: any) => e.code === "ROLE_NOT_ALLOWED",
    );
    assert.doesNotThrow(() => requireScope(limited!.claims!, "instance:claim"));
  });

  it("制品摘要由服务端重算：内容被换掉时 complete 失败", async () => {
    const t = await newTask();
    const declared = digestOf(Buffer.from("expected content"));
    const meta = await createArtifact(
      { task_id: t.task_id, sha256: declared, media_type: "text/plain" },
      "worker-a",
    );
    await putArtifactContent(meta.artifact_id as string, Buffer.from("tampered content"), "worker-a");
    await expectApiError(
      () => completeArtifact(meta.artifact_id as string, "worker-a"),
      "ARTIFACT_DIGEST_MISMATCH",
    );
    const failed = await q1<{ status: string }>(
      `SELECT status FROM artifacts WHERE artifact_id = $1`,
      [meta.artifact_id],
    );
    assert.equal(failed?.status, "FAILED");
  });

  it("制品内容：属主可读，未交接的实例不可读，交接随 attempt 结束收回", async () => {
    const buildTask = await newTask();
    const sha = await uploadArtifactFor(buildTask.task_id, "build output", "worker-a");
    const art = await q1<{ artifact_id: string }>(
      `SELECT artifact_id FROM artifacts WHERE task_id = $1 AND status = 'COMPLETE'`,
      [buildTask.task_id],
    );
    assert.ok(art?.artifact_id);

    const own = await readArtifactContent(art!.artifact_id, "worker-a");
    assert.equal(own.data.toString("utf8"), "build output");
    assert.equal(own.sha256, sha);
    assert.equal(own.media_type, "text/plain");

    // 同主机、同工作流的另一个角色也不行：只认属主或显式交接
    await expectApiError(
      () => readArtifactContent(art!.artifact_id, "reviewer-a"),
      "ROLE_NOT_ALLOWED",
    );
    // 未配置鉴权的本地开发模式（instanceId 为空）才放行
    assert.equal((await readArtifactContent(art!.artifact_id)).data.toString("utf8"), "build output");

    const verifyTask = await newTask({
      task_type: "task.test.run",
      requirements: {
        upstream_artifacts: [{ artifact_id: art!.artifact_id, sha256: sha }],
      },
    });
    const a = await claimOrFail("tester-a");
    assert.equal(a.task_id, verifyTask.task_id);
    assert.equal((a.requirements.upstream_artifacts as any[])[0]?.artifact_id, art!.artifact_id);
    assert.equal(
      (await readArtifactContent(art!.artifact_id, "tester-a")).data.toString("utf8"),
      "build output",
    );

    await startAck(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "tester-a",
    });
    await submitResult(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "tester-a",
      status: "SUCCEEDED",
      summary: "ok",
    });
    // attempt 结束即收回交接授权，过期 attempt 不能继续拉制品
    await expectApiError(
      () => readArtifactContent(art!.artifact_id, "tester-a"),
      "ROLE_NOT_ALLOWED",
    );
  });

  it("未完成校验的制品不能读", async () => {
    const t = await newTask();
    const meta = await createArtifact(
      { task_id: t.task_id, sha256: digestOf(Buffer.from("x")), media_type: "text/plain" },
      "worker-a",
    );
    await putArtifactContent(meta.artifact_id as string, Buffer.from("x"), "worker-a");
    await expectApiError(
      () => readArtifactContent(meta.artifact_id as string, "worker-a"),
      "STATE_CONFLICT",
    );
  });

  it("不可重试失败 → 工作流 FAILED；取消 → 工作流 CANCELLED", async () => {
    const { run: run1, task: task1 } = await createWorkflowRun({
      workflow_template_id: "wft_test",
    });
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    });
    await submitResult(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
      status: "FAILED",
      error: { code: "PAYLOAD_INVALID" },
    });
    assert.equal((await getWorkflowRun((run1 as any).workflow_run_id) as any).status, "FAILED");
    assert.equal((task1 as any).task_type, "task.build");

    const { run: run2, task: rootTask } = await createWorkflowRun({
      workflow_template_id: "wft_test",
    });
    await cancelTask((rootTask as any).task_id, "op-1");
    assert.equal(
      (await getWorkflowRun((run2 as any).workflow_run_id) as any).status,
      "CANCELLED",
    );
  });

  it("未知模板 → 404；工作流列表可查", async () => {
    await expectApiError(
      () => createWorkflowRun({ workflow_template_id: "wft_missing" }),
      "WORKFLOW_TEMPLATE_UNKNOWN",
    );
    const { run } = await createWorkflowRun({ workflow_template_id: "wft_test" });
    const items = await listWorkflowRuns();
    assert.equal(items.length, 1);
    assert.equal((items[0] as any).workflow_run_id, (run as any).workflow_run_id);
  });
});

describe("工作能力值 W 与任务难度 D", () => {
  it("只有 W >= D 的构建机可以领取任务", async () => {
    await q(`UPDATE role_instances SET capability_score = 120 WHERE instance_id = 'worker-a'`);
    await q(`UPDATE role_instances SET capability_score = 600 WHERE instance_id = 'worker-b'`);

    const hard = await newTask({ difficulty: 300 });
    // worker-a 的 W 不够：候选被过滤，返回 null，任务保持 QUEUED
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    assert.equal((await getTask(hard.task_id)).status, "QUEUED");

    const a = await claimOrFail("worker-b");
    assert.equal(a.task_id, hard.task_id);
    assert.equal(a.difficulty, 300);

    const easy = await newTask({ difficulty: 100 });
    const b = await claimOrFail("worker-a");
    assert.equal(b.task_id, easy.task_id);
  });

  it("未上报 W 的实例保持旧行为（不按难度过滤）", async () => {
    const t = await newTask({ difficulty: 800 });
    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, t.task_id);
    assert.equal(a.difficulty, 800);
  });

  it("结点上报的 ΣW 逐级相加，根节点不重复计算孙结点", async () => {
    // 本机有一台 W=320 的构建机
    await q(
      `INSERT INTO role_instances (instance_id, role_id, host_id, state, agent_profile_id,
                                   allowed_task_types, capabilities, capability_score, last_heartbeat_at)
       VALUES ('builder-w','builder','host-a','ONLINE','agent-b1',
               ARRAY['task.build'], '{"healthy":["code.edit"]}', 320, app_now())`,
    );
    // child-b 子树 = 本地 200 + 孙结点 50 = 250；它只把 250 上报给 root-a
    await upsertNodeReport({
      node_id: "root-a",
      host_id: "host-a",
      role: "root",
      local_score: 320,
      subtree_score: 320,
      builder_count: 1,
    });
    await upsertNodeReport({
      node_id: "root-b",
      parent_node_id: "root-a",
      host_id: "host-b",
      role: "node",
      local_score: 200,
      subtree_score: 250,
      builder_count: 2,
      child_count: 1,
    });

    const snap = await capabilitySnapshot("root-a");
    assert.equal(snap.local_score, 320);
    assert.equal(snap.child_score, 250);
    assert.equal(snap.subtree_score, 570);
    assert.equal(snap.children.length, 1);

    // 孙结点不直接挂到 root-a，因此不会重复相加
    const nodes = await listNodes();
    assert.equal(nodes.length, 2);
  });
});

describe("跨调度机中继", () => {
  it("已下推的父任务留在本地但不再被领取", async () => {
    const t = await newTask();
    await q(
      `INSERT INTO task_relays (parent_task_id, child_node_id, child_url, child_task_id, state)
       VALUES ($1, 'node-a', 'http://127.0.0.1:9', 'task_child', 'ACTIVE')`,
      [t.task_id],
    );
    // 候选查询排除 ACTIVE 中继：本机有在线构建机也领不到
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    assert.equal((await getTask(t.task_id)).status, "QUEUED");
  });

  it("中继同步把子结点终态与输出镜像回父任务", async () => {
    const child = {
      task_id: "task_child",
      status: "SUCCEEDED",
      result_summary: "子结点完成",
      attempts: [{ outputs: { stdout: "relay-ok\n", exit_code: 0 } }],
    };
    const server: Server = createServer((req, res) => {
      if (req.url === "/v1/tasks/task_child") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(child));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const t = await newTask();
      await q(
        `INSERT INTO task_relays (parent_task_id, child_node_id, child_url, child_task_id, state)
         VALUES ($1, 'node-a', $2, 'task_child', 'ACTIVE')`,
        [t.task_id, `http://127.0.0.1:${port}`],
      );
      const out = await syncRelays();
      assert.equal(out.checked, 1);
      assert.equal(out.updated, 1);

      const parent = await getTask(t.task_id);
      assert.equal(parent.status, "SUCCEEDED");
      const relay = (parent as any).relay;
      assert.equal(relay.state, "DONE");
      assert.equal(relay.child_state, "SUCCEEDED");
      assert.equal(relay.child_result.outputs.stdout, "relay-ok\n");
      const events = await listEvents(t.task_id);
      assert.ok(events.some((e) => e.event_type === "TASK_RELAY_SUCCEEDED"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("多级中继：中间结点没有 attempt 时从嵌套 child_result 取输出", async () => {
    const child = {
      task_id: "task_grandchild_holder",
      status: "SUCCEEDED",
      result_summary: "孙结点完成",
      // 中间结点自己没执行，attempts 为空，输出挂在它的中继结果里
      attempts: [],
      relay: {
        state: "DONE",
        child_state: "SUCCEEDED",
        child_result: { summary: "孙结点完成", outputs: { stdout: "deep-ok\n", exit_code: 0 } },
      },
    };
    const server: Server = createServer((req, res) => {
      if (req.url === "/v1/tasks/task_grandchild_holder") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(child));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const t = await newTask();
      await q(
        `INSERT INTO task_relays (parent_task_id, child_node_id, child_url, child_task_id, state)
         VALUES ($1, 'node-b', $2, 'task_grandchild_holder', 'ACTIVE')`,
        [t.task_id, `http://127.0.0.1:${port}`],
      );
      await syncRelays();
      const parent = await getTask(t.task_id);
      assert.equal(parent.status, "SUCCEEDED");
      const relay = (parent as any).relay;
      assert.equal(relay.child_result.outputs.stdout, "deep-ok\n");
      assert.equal(relay.child_result.outputs.exit_code, 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
