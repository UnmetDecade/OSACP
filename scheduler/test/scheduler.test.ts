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
  forget,
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
  downloadFilename,
  listTaskArtifacts,
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
import { cancelTask, createTask, getTask, listEvents, retryTask } from "../src/repo/tasks.js";
import { syncRelays } from "../src/core/relay.js";
import { getGrants, markGrantApplied } from "../src/repo/resources.js";
import {
  advance,
  assertTestDatabase,
  claimOrFail,
  newTask,
  reset,
  runToSuccess,
  uploadArtifactFor,
} from "./helpers.js";

// Every test starts with a truncate, so refuse to run before touching a database that is not clearly
// a test one.
before(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  await reset();
});

after(async () => {
  await closePool();
});

async function expectApiError(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    assert.fail(`expected ${code} to be thrown, but the call succeeded`);
  } catch (e) {
    assert.ok(e instanceof ApiError, `expected ApiError, got ${e}`);
    assert.equal(e.code, code, `error code mismatch: ${e.code} / ${JSON.stringify((e as ApiError).detail)}`);
  }
}

describe("M1 tasks and state machine", () => {
  it("a created task is QUEUED and writes a TASK_CREATED event", async () => {
    const t = await newTask();
    assert.equal(t.status, "QUEUED");
    const events = await listEvents(t.task_id);
    assert.equal(events[0].event_type, "TASK_CREATED");
  });

  it("undefined task types are rejected", async () => {
    await expectApiError(() => newTask({ task_type: "nope" }), "TASK_TYPE_UNKNOWN");
  });

  it("illegal state transitions are rejected (table-driven)", async () => {
    const t = await newTask();
    await cancelTask(t.task_id);
    await expectApiError(() => cancelTask(t.task_id), "STATE_CONFLICT");
  });

  it("task_events is append-only", async () => {
    const t = await newTask();
    await assert.rejects(
      () => pool.query(`UPDATE task_events SET event_type = 'X' WHERE task_id = $1`, [t.task_id]),
      /append-only/,
    );
  });
});

describe("M2 claiming and leases", () => {
  it("claiming makes the task ASSIGNED and creates a lease, attempt, and HELD reservation", async () => {
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

  it("the default per-instance concurrency limit is 1: a second claim by the same instance returns empty", async () => {
    await newTask();
    await newTask();
    await claimOrFail("worker-a");
    assert.equal(await claim({ instance_id: "worker-a" }), null);
  });

  it("two instances claiming concurrently never get the same task", async () => {
    await q(`UPDATE scheduler_config SET instance_limit = 5, task_type_limit = 50`);
    for (let i = 0; i < 10; i++) await newTask();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        claim({ instance_id: i % 2 === 0 ? "worker-a" : "worker-b" }),
      ),
    );
    const ids = results.filter(Boolean).map((r) => r!.task_id);
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 10, "a duplicate claim occurred");
  });

  it("start-ack moves the task to RUNNING and the reservation to ACTIVE", async () => {
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

  it("repeated start-ack is idempotent", async () => {
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

  it("reporting a result without start-ack → STATE_CONFLICT", async () => {
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

  it("renewal extends expires_at", async () => {
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

describe("M3 fencing and duplicate execution", () => {
  it("successful results are idempotent: reporting again for the same attempt returns the first result", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");
    const proof = {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    };
    await startAck(a.attempt_id, proof);
    await submitResult(a.attempt_id, { ...proof, status: "SUCCEEDED", summary: "first time" });
    const second = await submitResult(a.attempt_id, { ...proof, status: "FAILED" });
    assert.equal((second as any).idempotent, true);
    assert.equal((second as any).attempt_status, "SUCCEEDED");
  });

  it("writes with mismatched fencing are rejected", async () => {
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

  it("after the lease is reclaimed, result writes from the old attempt are blocked with FENCING_STALE", async () => {
    const t = await newTask();
    const first = await claimOrFail("worker-a");
    await startAck(first.attempt_id, {
      lease_token: first.lease_token,
      fencing_token: first.fencing_token,
      instance_id: "worker-a",
    });

    // Instance "lost": lease expires
    await advance(301);
    const swept = await sweepLeases();
    assert.equal(swept.reclaimed.length, 1);
    assert.equal(swept.reclaimed[0].cause, "LEASE_EXPIRED");

    // After backoff a new instance takes over; fencing becomes 2
    await advance(301);
    const second = await claimOrFail("worker-b");
    assert.equal(second.fencing_token, 2);

    // Only now does the old attempt write back its result — it must be rejected
    await expectApiError(
      () =>
        submitResult(first.attempt_id, {
          lease_token: first.lease_token,
          fencing_token: first.fencing_token,
          status: "SUCCEEDED",
          summary: "late success (poison message)",
        }),
      "FENCING_STALE",
    );

    // The new attempt completes normally
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

  it("no ack within the 30s startup window triggers reclamation without marking the RUNNING task failed", async () => {
    await newTask();
    await claimOrFail("worker-a");
    await advance(31);
    const r = await sweepLeases();
    assert.equal(r.reclaimed[0].cause, "START_TIMEOUT");
    assert.equal(r.reclaimed[0].to, "QUEUED");
  });

  it("local admission rejection does not consume retries", async () => {
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

    // The next claim must succeed: attempt_number must not be reused because attempt_count rolled back
    const b = await claimOrFail("worker-b");
    assert.equal(b.attempt_number, 2);
    const rows = await q1<{ n: string }>(
      `SELECT count(*)::text AS n FROM task_attempts WHERE task_id = $1`,
      [t.task_id],
    );
    assert.equal(rows?.n, "2");
  });
});

describe("M4 retries and dead letters", () => {
  it("retryable failure → requeued with backoff and not claimable during the backoff", async () => {
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

    // Not claimable during backoff
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    await advance(301);
    assert.ok(await claim({ instance_id: "worker-a" }));
  });

  it("exhausted retries → FAILED + dead letter", async () => {
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

  it("operator retry requeues a dead-lettered task with a fresh attempt budget", async () => {
    const t = await newTask({ max_attempts: 1 });
    const a = await claimOrFail("worker-a");
    const proof = {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    };
    await startAck(a.attempt_id, proof);
    await submitResult(a.attempt_id, { ...proof, status: "FAILED", error: { code: "TEST_FAILED" } });
    assert.equal((await getTask(t.task_id)).status, "FAILED");

    const out = await retryTask(t.task_id, "tester");
    assert.equal(out.status, "QUEUED");
    assert.equal(out.attempt_count, 0);
    assert.equal(out.dead_letter, false);
    const events = await listEvents(t.task_id);
    assert.equal(events[events.length - 1].event_type, "TASK_REQUEUED");

    // No backoff: the retried task is claimable at once, and the attempt number keeps growing.
    const next = await claimOrFail("worker-a");
    assert.equal(next.task_id, t.task_id);
    assert.equal(next.attempt_number, 2);
  });

  it("retry is rejected while the task is still active", async () => {
    const t = await newTask();
    await expectApiError(() => retryTask(t.task_id), "STATE_CONFLICT");
  });

  it("non-retryable errors fail immediately without consuming further retries", async () => {
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

describe("reservation reconciliation and orphan grants", () => {
  it("after lease reclamation the old reservation closes, the new attempt uses a new grant, and no HELD/ACTIVE remains", async () => {
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

    // After backoff another instance takes over and must get a new grant_id
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

  it("after cancel-ack the reservation closes as RELEASED", async () => {
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

describe("M2 heartbeat and health", () => {
  it("45s without a heartbeat → SUSPECT and no more claims; 90s → OFFLINE", async () => {
    await newTask();
    await advance(46);
    const hb = await sweepHeartbeats({ suspectAfter: 45, offlineAfter: 90 });
    assert.deepEqual(hb.suspect.filter((id) => id.startsWith("worker-")).sort(), [
      "worker-a",
      "worker-b",
    ]);

    await expectApiError(() => claim({ instance_id: "worker-a" }), "INSTANCE_NOT_ELIGIBLE");

    await advance(45); // 91s total
    const hb2 = await sweepHeartbeats({ suspectAfter: 45, offlineAfter: 90 });
    assert.deepEqual(hb2.offline.filter((id) => id.startsWith("worker-")).sort(), [
      "worker-a",
      "worker-b",
    ]);
  });

  it("SUSPECT does not reclaim in-flight leases", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      instance_id: "worker-a",
    });
    await advance(46);
    await sweepHeartbeats({ suspectAfter: 45, offlineAfter: 90 });
    // Lease still present
    const lease = await q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM leases WHERE task_id = $1 AND released_at IS NULL`,
      [a.task_id],
    );
    assert.equal(lease?.n, 1);
  });
});

describe("ordering and admission", () => {
  it("aging: P2 gains parity with P1 after 600s and is ordered by enqueue time", async () => {
    const older = await newTask({ priority_class: 2 });
    await advance(700);
    const newer = await newTask({ priority_class: 1 });

    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, older.task_id, "after aging, the earlier-enqueued task should be claimed first");

    const events = await listEvents(older.task_id);
    assert.ok(events.some((e) => e.event_type === "TASK_AGED"));

    // The new task is still queued
    assert.equal((await getTask(newer.task_id)).status, "QUEUED");
  });

  it("P0 does not participate in aging", async () => {
    const p0 = await newTask({ priority_class: 0 });
    await advance(1800);
    await newTask({ priority_class: 1 });
    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, p0.task_id);
  });

  it("dispatch stops while the host is PROTECTING", async () => {
    await newTask();
    await q(`UPDATE hosts SET host_state = 'PROTECTING' WHERE host_id = 'host-a'`);
    await expectApiError(() => claim({ instance_id: "worker-a" }), "HOST_NOT_ELIGIBLE");
  });

  it("insufficient host memory → the task stays QUEUED and resource_block_reason is written", async () => {
    await q(`UPDATE hosts SET mem_available_bytes = 1000 WHERE host_id = 'host-a'`);
    const t = await newTask();
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    const task = await getTask(t.task_id);
    assert.equal(task.status, "QUEUED");
    assert.equal(task.resource_block_reason, "INSUFFICIENT_MEMORY");
    assert.ok(task.resource_evaluated_at);

    // Claimable once resources recover; the block backoff (1s, 2s, 4s…) has to elapse first.
    await q(`UPDATE hosts SET mem_available_bytes = 12884901888 WHERE host_id = 'host-a'`);
    await advance(2);
    await claimOrFail("worker-a");
  });
});

describe("cancellation", () => {
  it("cancelling QUEUED takes effect immediately", async () => {
    const t = await newTask();
    const out = await cancelTask(t.task_id, "tester");
    assert.equal((out as any).status, "CANCELLED");
  });

  it("cancelling RUNNING only records the request until the instance acks", async () => {
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

describe("M5 instance lifecycle", () => {
  it("registration stores capability totals above 2 GiB (memory is bigint, not int4)", async () => {
    // 8 GiB = 8589934592 does not fit in an int4; the register INSERT must bind the parameter as bigint.
    const out = await register({
      instance_id: "worker-a",
      role_id: "worker",
      host_id: "host-a",
      agent_profile_id: "agent-w1",
      allowed_task_types: ["task.build"],
      capabilities: { healthy: ["code.edit", "shell"] },
      capability_detail: { cores: 4, mem_gb: 8 },
      config_version: 1,
    });
    assert.ok(Number((out as any).capability_score) > 0);
    const row = await q1<any>(
      `SELECT cap_cpu_millicores, cap_mem_bytes FROM role_instances WHERE instance_id = 'worker-a'`,
    );
    assert.equal(Number(row.cap_cpu_millicores), 4000);
    assert.equal(Number(row.cap_mem_bytes), 8 * 1024 ** 3);
  });

  it("capabilities can only narrow: shrinking succeeds and expanding returns 403", async () => {
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

    // Capabilities cannot exceed the declaration
    await expectApiError(
      () => setCapabilities("worker-a", { declared: { capabilities: ["code.edit", "gpu"] } }),
      "CAPABILITY_MISMATCH",
    );
    // Task types cannot cross the allowlist
    await expectApiError(
      () => setCapabilities("worker-a", { declared: { task_types: ["task.commit"] } }),
      "CAPABILITY_MISMATCH",
    );
  });

  it("drain stops claims while in-flight work continues; heartbeats cannot undo drain and resume restores it", async () => {
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

    // No new tasks are dispatched
    await expectApiError(() => claim({ instance_id: "worker-a" }), "INSTANCE_NOT_ELIGIBLE");

    // In-flight tasks can finish normally
    await submitResult(a.attempt_id, {
      lease_token: a.lease_token,
      fencing_token: a.fencing_token,
      status: "SUCCEEDED",
      summary: "ok",
    });

    // An ONLINE heartbeat must not overwrite an admin-issued DRAINING
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

  it("an incomplete drain timeout → OFFLINE", async () => {
    await drain("worker-a", { timeout_seconds: 60 });
    await advance(61);
    assert.deepEqual(await sweepDrainTimeouts(), ["worker-a"]);
    const inst = await q1<{ state: string }>(
      `SELECT state FROM role_instances WHERE instance_id = 'worker-a'`,
    );
    assert.equal(inst?.state, "OFFLINE");
  });

  it("unregistration is blocked with in-flight tasks; force=true allows it", async () => {
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

  it("a live registration cannot be forgotten; a deregistered one can", async () => {
    await register({
      instance_id: "ghost-worker",
      role_id: "worker",
      host_id: "host-a",
      agent_profile_id: "agent-w1",
      allowed_task_types: ["task.build"],
      capabilities: { healthy: [] },
      config_version: 1,
    });
    await expectApiError(() => forget("ghost-worker"), "INSTANCE_ALIVE");

    await deregister("ghost-worker", { force: true });
    const out = await forget("ghost-worker");
    assert.equal((out as any).forgotten, true);
    assert.ok(!(await q1(`SELECT instance_id FROM role_instances WHERE instance_id = 'ghost-worker'`)));
    await expectApiError(() => forget("ghost-worker"), "INSTANCE_UNKNOWN");
  });

  it("config-sync: an unchanged version returns null (HTTP 304), a changed one returns the new config", async () => {
    const cfg = await syncConfig("worker-a");
    assert.equal((cfg as any).config_version, 1);
    assert.deepEqual((cfg as any).allowed_task_types, ["task.build"]);
    assert.equal(await syncConfig("worker-a", 1), null);

    await q(`UPDATE role_instances SET config_version = 2 WHERE instance_id = 'worker-a'`);
    const cfg2 = await syncConfig("worker-a", 1);
    assert.equal((cfg2 as any).config_version, 2);
  });

  it("P4: the envelope only carries Agent/API Profile references and config-sync only syncs references", async () => {
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

    // The envelope has no implementation, address or secret values, only references
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

    // Switch Agent: only the reference changes and the envelope follows; task definitions and code stay put
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

  it("with AUTH_TOKEN set, a missing or wrong instance token → 401", () => {
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

describe("M6 Outbox and event push", () => {
  it("task creation and the outbox entry are written in one transaction with complete fields", async () => {
    const t = await newTask();
    const created = (await listOutbox(0)).find((e) => e.event_type === "TASK_CREATED");
    assert.ok(created, "the outbox should contain TASK_CREATED");
    assert.equal(created.aggregate_type, "task");
    assert.equal(created.aggregate_id, t.task_id);
    assert.equal(created.schema_version, "1.0");
    assert.equal(created.aggregate_version, "1");
    const payload = created.payload as any;
    assert.equal(payload.task_id, t.task_id);
    assert.equal(payload.to_status, "QUEUED");
  });

  it("state transition events carry attempt / fencing and can be resumed in order", async () => {
    await newTask();
    const a = await claimOrFail("worker-a");

    const all = await listOutbox(0);
    const assigned = all.find((e) => e.event_type === "TASK_ASSIGNED");
    assert.ok(assigned);
    const payload = assigned.payload as any;
    assert.equal(payload.payload.attempt_id, a.attempt_id);
    assert.equal(payload.payload.fencing_token, a.fencing_token);
    assert.equal(assigned.aggregate_version, "2", "version should be 2 after assign");

    // Cursor: after only returns newer events
    const firstId = Number(all[0].event_id);
    const rest = await listOutbox(firstId);
    assert.ok(rest.length < all.length);
    assert.ok(rest.every((e) => Number(e.event_id) > firstId));
    assert.equal(await latestEventId(), Number(all[all.length - 1].event_id));
  });

  it("outbox is append-only", async () => {
    await newTask();
    await assert.rejects(
      () => pool.query(`UPDATE outbox_events SET event_type = 'X'`),
      /append-only/,
    );
  });
});

describe("concurrency stress", () => {
  it("30 tasks and 3 instances (including raised concurrency) are neither duplicated nor lost", async () => {
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

    assert.equal(new Set(ids).size, ids.length, "a task was claimed twice");
    assert.equal(ids.length, 30, `wrong claim count: ${ids.length}`);

    const counts = await q<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM tasks GROUP BY status`,
    );
    assert.deepEqual(counts, [{ status: "ASSIGNED", n: 30 }]);
  });
});

describe("M7 workflows and approvals (signed tokens + artifact digests)", () => {
  // Each test process generates a one-off ES256 key pair; the private key lives only in test memory
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

  /** Start a wft_test workflow, run EXECUTE / REVIEW to success, and walk the artifact channel */
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
    // Artifact content → server-recomputed digest; this is what approval binds to
    const digest = await uploadArtifactFor(
      review.task_id,
      `review diff for ${review.task_id}`,
    );
    await submitResult(review.attempt_id, {
      lease_token: review.lease_token,
      fencing_token: review.fencing_token,
      instance_id: "reviewer-a",
      status: "SUCCEEDED",
      // Deliberately report a fake digest: approval must use the value confirmed by the artifact channel
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

  it("workflow creation cannot include artifact handoff or approval fields", async () => {
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
    // Handoff and approval fields may only be written by the scheduler during phase advance / approval
    assert.deepEqual((task as any).requirements, { capabilities: ["code.edit"] });
  });

  it("stage progression: EXECUTE → REVIEW → WAITING_APPROVAL, then COMMIT → VERIFY → COMPLETED after approval", async () => {
    const { runId, reviewTaskId, requestId, digest } = await reachApproval();

    const waiting = (await getWorkflowRun(runId)) as any;
    assert.equal(waiting.status, "WAITING_APPROVAL");
    assert.equal(waiting.current_phase, "APPROVE");
    assert.equal(waiting.approval_requests.length, 1);
    assert.equal(waiting.approval_requests[0].status, "PENDING");

    // Data source for the admin app approval center: includes task / workflow context, so the admin app need not write SQL.
    const listed = (await listApprovalRequests({ status: "PENDING" })) as any[];
    const row = listed.find((x) => x.approval_request_id === requestId);
    assert.ok(row, "the pending-approval list should contain the current request");
    assert.equal(row.task_id, reviewTaskId);
    assert.equal(row.target_role, "reviewer");
    assert.equal(row.workflow_status, "WAITING_APPROVAL");
    assert.deepEqual(row.action_scope, ["svn.commit"]);
    assert.ok(row.evidence?.some((e: string) => e.startsWith("text/plain:")));
    // The digest comes from the server-verified artifact, not the spoofed value in the executor's outputs
    assert.equal(waiting.approval_requests[0].subject_digest, digest);
    assert.notEqual(waiting.approval_requests[0].subject_digest, "sha256:spoofed-by-executor");

    // Digest bound to the token is wrong → reject
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

    // Token was not issued for this request → reject
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
    assert.ok(verifyTask, "a VERIFY stage task should be created");
    assert.equal(verifyTask.task_type, "task.test.run");
    await runToSuccess("tester-a", verifyTask.task_id);

    const done = (await getWorkflowRun(runId)) as any;
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.current_task_id, null);
    assert.equal(done.tasks.length, 4, "one task each for EXECUTE/REVIEW/COMMIT/VERIFY");

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
      assert.ok(typesSeen.includes(t), `outbox is missing ${t}: ${typesSeen.join(",")}`);
    }
  });

  it("rejecting approval → workflow FAILED without creating a COMMIT task", async () => {
    const { runId, reviewTaskId, requestId, digest } = await reachApproval();

    const out = await decideApproval({
      task_id: reviewTaskId,
      decision: "REJECTED",
      operator_id: OP,
      approval_token: approvalToken({ requestId, digest }),
      comment: "the diff has issues",
    });
    assert.equal((out.run as any).status, "FAILED");
    assert.equal(out.task, null);

    const run = (await getWorkflowRun(runId)) as any;
    assert.equal(run.status, "FAILED");
    assert.equal(
      run.tasks.some((t: any) => t.task_type === "task.commit"),
      false,
      "no COMMIT task should exist after rejection",
    );
    assert.equal(run.approval_requests[0].status, "REJECTED");
  });

  it("approval tokens are single-use: a token whose jti is already stored cannot be reused", async () => {
    const { reviewTaskId, requestId, digest } = await reachApproval();
    const token = approvalToken({ requestId, digest, jti: "tok-fixed-once" });

    await decideApproval({
      task_id: reviewTaskId,
      decision: "APPROVED",
      operator_id: OP,
      approval_token: token,
    });

    // Manually set the request back to PENDING to simulate "request reopened";
    // the token itself is still valid, so only the unique jti can block the replay
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

  it("the approver must be the operator in the token", async () => {
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

  it("approval fails closed without the PCS public key; instance token signature, audience, scope, and self-proof are all validated", async () => {
    const saved = process.env.PCS_PUBLIC_KEY;
    // 1) No public key configured: approval returns 503 directly
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
      // Instance auth falls back to shared-token mode (allow if AUTH_TOKEN is unset)
      assert.equal(requireInstanceAuth({ headers: {} } as any), null);
    } finally {
      process.env.PCS_PUBLIC_KEY = saved;
    }

    // 2) With a public key configured, instance endpoints must receive a valid JWT
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

    // A forged signature (re-signed with another private key) is rejected
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const forged = signJwt(
      { iss: "platform-control", aud: "scheduler", sub: "worker-b", exp: now() + 600 },
      other.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    assert.throws(() => call(forged), (e: any) => e.code === "TOKEN_INVALID");

    // The token subject cannot impersonate another instance
    assert.throws(() => assertSelf(auth!, "worker-b"), (e: any) => e.code === "ROLE_NOT_ALLOWED");
    assert.doesNotThrow(() => assertSelf(auth!, "worker-a"));

    // Scope is a hard boundary
    const limited = call(instanceToken({ sub: "worker-a", scopes: ["instance:claim"] }));
    assert.throws(
      () => requireScope(limited!.claims!, "task:report"),
      (e: any) => e.code === "ROLE_NOT_ALLOWED",
    );
    assert.doesNotThrow(() => requireScope(limited!.claims!, "instance:claim"));
  });

  it("the artifact digest is recomputed server-side: complete fails when the content is swapped", async () => {
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

  it("artifact content: readable by the owner, unreadable by instances without a handoff, and the handoff is revoked when the attempt ends", async () => {
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

    // Another role on the same host and workflow is still denied: only the owner or an explicit handoff counts
    await expectApiError(
      () => readArtifactContent(art!.artifact_id, "reviewer-a"),
      "ROLE_NOT_ALLOWED",
    );
    // Only local development without auth (instanceId empty) is allowed
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
    // Ending the attempt revokes the handoff authorization; an expired attempt cannot keep pulling artifacts
    await expectApiError(
      () => readArtifactContent(art!.artifact_id, "tester-a"),
      "ROLE_NOT_ALLOWED",
    );
  });

  it("file channel: artifacts keep their names, are listed by task, and download under the original filename", async () => {
    const t = await newTask();
    const buf = Buffer.from([0x00, 0xff, 0x10, 0x42]);
    const sha = digestOf(buf);
    const meta = await createArtifact(
      {
        task_id: t.task_id,
        sha256: sha,
        size_bytes: buf.length,
        media_type: "application/octet-stream",
        name: "out/结果.bin",
      },
      "worker-a",
    );
    await putArtifactContent(meta.artifact_id as string, buf, "worker-a");
    await completeArtifact(meta.artifact_id as string, "worker-a");

    const items = (await listTaskArtifacts(t.task_id)) as any[];
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "out/结果.bin");
    assert.equal(items[0].status, "COMPLETE");
    assert.equal(items[0].media_type, "application/octet-stream");
    assert.equal(items[0].actual_sha256, sha);
    // The download header uses only the basename; bytes are returned unchanged.
    assert.equal(downloadFilename(items[0]), "结果.bin");
    const own = await readArtifactContent(meta.artifact_id as string, "worker-a");
    assert.deepEqual(own.data, buf);
    assert.equal(own.name, "out/结果.bin");
  });

  it("artifacts without a name still download under a name derived from the media type", async () => {
    const t = await newTask();
    const meta = await createArtifact(
      { task_id: t.task_id, sha256: digestOf(Buffer.from("{}")), media_type: "application/json" },
      "worker-a",
    );
    await putArtifactContent(meta.artifact_id as string, Buffer.from("{}"), "worker-a");
    await completeArtifact(meta.artifact_id as string, "worker-a");
    const [row] = (await listTaskArtifacts(t.task_id)) as any[];
    assert.equal(row.name, null);
    assert.equal(downloadFilename(row), `${meta.artifact_id}.json`);
  });

  it("artifacts that have not finished verification cannot be read", async () => {
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

  it("non-retryable failure → workflow FAILED; cancellation → workflow CANCELLED", async () => {
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

  it("unknown template → 404; the workflow list is queryable", async () => {
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

describe("work capability W and task difficulty D", () => {
  it("only builders with W >= D can claim tasks", async () => {
    await q(`UPDATE role_instances SET capability_score = 120 WHERE instance_id = 'worker-a'`);
    await q(`UPDATE role_instances SET capability_score = 600 WHERE instance_id = 'worker-b'`);

    const hard = await newTask({ difficulty: 300 });
    // worker-a's W is insufficient: the candidate is filtered out, null is returned, and the task stays QUEUED
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    assert.equal((await getTask(hard.task_id)).status, "QUEUED");

    const a = await claimOrFail("worker-b");
    assert.equal(a.task_id, hard.task_id);
    assert.equal(a.difficulty, 300);

    const easy = await newTask({ difficulty: 100 });
    const b = await claimOrFail("worker-a");
    assert.equal(b.task_id, easy.task_id);
  });

  it("an idle stronger builder gets the task even when the weaker builder polls first", async () => {
    await q(`UPDATE role_instances SET capability_score = 120 WHERE instance_id = 'worker-a'`);
    await q(`UPDATE role_instances SET capability_score = 600 WHERE instance_id = 'worker-b'`);

    const t = await newTask({ difficulty: 100 });
    // worker-a asks first but yields: worker-b is idle and strictly stronger.
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    assert.equal((await getTask(t.task_id)).status, "QUEUED");
    // Yielding is not a block: no backoff, no reason, no event.
    const row = await q1<any>(
      `SELECT blocked_attempts, resource_block_reason FROM tasks WHERE task_id = $1`,
      [t.task_id],
    );
    assert.equal(Number(row.blocked_attempts), 0);
    assert.equal(row.resource_block_reason, null);
    assert.equal(
      (await listEvents(t.task_id)).filter((e) => e.event_type !== "TASK_CREATED").length,
      0,
    );

    const a = await claimOrFail("worker-b");
    assert.equal(a.task_id, t.task_id);
  });

  it("the preference is bounded: a stronger builder that never takes it does not starve the queue", async () => {
    await q(`UPDATE role_instances SET capability_score = 120 WHERE instance_id = 'worker-a'`);
    await q(`UPDATE role_instances SET capability_score = 600 WHERE instance_id = 'worker-b'`);

    const t = await newTask({ difficulty: 100 });
    // waiter longer than CAPABILITY_PREFER_WINDOW_SECONDS: the weaker builder stops yielding.
    await advance(31);
    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, t.task_id);
  });

  it("a stronger builder that cannot run the task does not hold it back", async () => {
    await q(
      `UPDATE role_instances SET capability_score = 120, capabilities = '{"healthy":["code.edit","shell"]}'
        WHERE instance_id = 'worker-a'`,
    );
    await q(
      `UPDATE role_instances SET capability_score = 600, capabilities = '{"healthy":["code.edit"]}'
        WHERE instance_id = 'worker-b'`,
    );

    const t = await newTask({ requirements: { capabilities: ["code.edit", "shell"] } });
    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, t.task_id);
  });

  it("instances that do not report W keep the old behavior (no difficulty filtering)", async () => {
    const t = await newTask({ difficulty: 800 });
    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, t.task_id);
    assert.equal(a.difficulty, 800);
  });

  it("reported node ΣW adds up level by level, and the root does not double-count grandchildren", async () => {
    // This machine has one builder with W=320
    await q(
      `INSERT INTO role_instances (instance_id, role_id, host_id, state, agent_profile_id,
                                   allowed_task_types, capabilities, capability_score, last_heartbeat_at)
       VALUES ('builder-w','builder','host-a','ONLINE','agent-b1',
               ARRAY['task.build'], '{"healthy":["code.edit"]}', 320, app_now())`,
    );
    // child-b subtree = local 200 + grandchild 50 = 250; it reports only 250 to root-a
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

    // The grandchild is not attached directly to root-a, so it is not double-counted
    const nodes = await listNodes();
    assert.equal(nodes.length, 2);
  });
});

describe("cross-scheduler relay", () => {
  it("a pushed-down parent task stays local but is no longer claimed", async () => {
    const t = await newTask();
    await q(
      `INSERT INTO task_relays (parent_task_id, child_node_id, child_url, child_task_id, state)
       VALUES ($1, 'node-a', 'http://127.0.0.1:9', 'task_child', 'ACTIVE')`,
      [t.task_id],
    );
    // The candidate query excludes ACTIVE relays: even with an online local builder, it cannot be claimed
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    assert.equal((await getTask(t.task_id)).status, "QUEUED");
  });

  it("relay sync mirrors the child's terminal state and output back to the parent task", async () => {
    const child = {
      task_id: "task_child",
      status: "SUCCEEDED",
      result_summary: "child node finished",
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

  it("multi-level relay: when an intermediate node has no attempt, outputs come from the nested child_result", async () => {
    const child = {
      task_id: "task_grandchild_holder",
      status: "SUCCEEDED",
      result_summary: "grandchild node finished",
      // The intermediate node did not execute; attempts is empty and outputs hang off its relay result
      attempts: [],
      relay: {
        state: "DONE",
        child_state: "SUCCEEDED",
        child_result: { summary: "grandchild node finished", outputs: { stdout: "deep-ok\n", exit_code: 0 } },
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

describe("dynamic scheduling (v0.3)", () => {
  const GIB = 1024 ** 3;

  /** Turn worker-a into a dynamic builder on a constrained host pool and silence the applied gate unless a test needs it. */
  async function dynamicHost(
    opts: {
      capCpu?: number;
      capMem?: number;
      poolCpu?: number;
      poolMem?: number;
      requireApplied?: boolean;
    } = {},
  ): Promise<void> {
    const capCpu = opts.capCpu ?? 4000;
    const capMem = opts.capMem ?? 4 * GIB;
    const poolCpu = opts.poolCpu ?? 8000;
    const poolMem = opts.poolMem ?? 8 * GIB;
    await q(
      `UPDATE role_instances
          SET scheduling_mode = 'dynamic', cap_cpu_millicores = $1, cap_mem_bytes = $2
        WHERE instance_id = 'worker-a'`,
      [capCpu, capMem],
    );
    await q(
      `INSERT INTO host_resource_pools (host_id, cpu_total_millicores, mem_total_bytes)
       VALUES ('host-a', $1, $2)
       ON CONFLICT (host_id) DO UPDATE SET
         cpu_total_millicores = EXCLUDED.cpu_total_millicores,
         mem_total_bytes = EXCLUDED.mem_total_bytes`,
      [poolCpu, poolMem],
    );
    if (!opts.requireApplied) {
      await q(
        `UPDATE scheduler_config SET dynamic_policy = '{"require_applied_before_start": false}'::jsonb`,
      );
    }
  }

  it("claim results for static instances keep their original shape", async () => {
    const t = await newTask();
    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, t.task_id);
    assert.equal(a.scheduling_mode, "static");
    assert.equal(a.resource_grant, null);
  });

  it("dynamic instance claims generate a quota and return it with the assignment", async () => {
    await dynamicHost();
    const t = await newTask();
    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, t.task_id);
    assert.equal(a.scheduling_mode, "dynamic");
    assert.ok(a.resource_grant, "a dynamic claim must return a quota");
    assert.ok(a.resource_grant!.generation >= 2, "a reservation change after allocation should raise the generation");
    // 2 GiB reservation is reflected in the refreshed grant.
    assert.ok(a.resource_grant!.memory_bytes >= 2 * GIB);
    assert.ok(a.resource_grant!.memory_low_bytes <= a.resource_grant!.memory_bytes);

    const grants = await getGrants("host-a");
    assert.equal(grants.length, 1);
    assert.equal(grants[0].instance_id, "worker-a");
    assert.equal(grants[0].state, "PENDING", "the quota stays PENDING until the host reports applied");
  });

  it("with require_applied_before_start, nothing is dispatched before the quota is APPLIED", async () => {
    await dynamicHost({ requireApplied: true });
    const t = await newTask();
    assert.equal(await claim({ instance_id: "worker-a" }), null);

    const queued = await getTask(t.task_id);
    assert.equal(queued.status, "QUEUED");
    // GRANT_PENDING is a host-wide wait, not the task's fault: no backoff is recorded.
    const row = await q1<any>(
      `SELECT blocked_attempts, resource_block_reason FROM tasks WHERE task_id = $1`,
      [t.task_id],
    );
    assert.equal(Number(row.blocked_attempts), 0);
    assert.equal(row.resource_block_reason, null);

    const [grant] = await getGrants("host-a");
    assert.ok(grant, "the first claim should compute the quota inline");
    await markGrantApplied({
      host_id: "host-a",
      instance_id: "worker-a",
      generation: grant.generation,
      cpu_millicores: grant.cpu_millicores,
      memory_bytes: grant.memory_bytes,
    });

    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, t.task_id);
  });

  it("when host pressure disallows admission nothing is dispatched and the task is not penalized", async () => {
    await dynamicHost();
    // High usage keeps the state machine in PRESSURE; an idle pool would exit to RECOVERING and admit.
    await q(
      `UPDATE host_resource_pools
          SET pressure_state = 'PRESSURE', mem_used_bytes = $1, mem_working_set_bytes = 0
        WHERE host_id = 'host-a'`,
      [7 * GIB],
    );
    const t = await newTask();
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    const row = await q1<any>(
      `SELECT blocked_attempts, status FROM tasks WHERE task_id = $1`,
      [t.task_id],
    );
    assert.equal(row.status, "QUEUED");
    assert.equal(Number(row.blocked_attempts), 0);
  });

  it("limits are not pretended to be enforced when the host provides no cgroup", async () => {
    await dynamicHost();
    await q(
      `UPDATE host_resource_pools
          SET cgroup_available = FALSE, cgroup_driver = 'none', reported_at = app_now()
        WHERE host_id = 'host-a'`,
    );
    const t = await newTask();
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    assert.equal((await getTask(t.task_id)).status, "QUEUED");
  });

  it("when the head task lacks resources it is skipped, scanning continues, and it is retried after backoff", async () => {
    await dynamicHost();
    await q(
      `INSERT INTO resource_profiles (profile_id, cpu_millicores, memory_bytes, disk_bytes, timeout_seconds)
       VALUES ('rp_big', 6000, $1, 0, 3600)`,
      [6 * GIB],
    );
    // The big task is enqueued first and can never fit this instance's 4 GiB cap.
    const big = await newTask({ resource_profile_id: "rp_big" });
    const small = await newTask();

    const a = await claimOrFail("worker-a");
    assert.equal(a.task_id, small.task_id, "skips the blocked head task and claims a runnable one behind it");

    const blocked = await q1<any>(
      `SELECT blocked_attempts, resource_block_reason, resource_retry_after, unschedulable
         FROM tasks WHERE task_id = $1`,
      [big.task_id],
    );
    assert.equal(blocked.resource_block_reason, "INSUFFICIENT_MEMORY");
    assert.equal(Number(blocked.blocked_attempts), 1);
    assert.ok(blocked.resource_retry_after, "a retry-after is written after blocking");
    assert.equal(blocked.unschedulable, false);

    // Still inside the backoff window: the task is skipped, not attempted again.
    const small2 = await newTask();
    const b = await claimOrFail("worker-a");
    assert.equal(b.task_id, small2.task_id);
    const still = await q1<any>(
      `SELECT blocked_attempts FROM tasks WHERE task_id = $1`,
      [big.task_id],
    );
    assert.equal(Number(still.blocked_attempts), 1);

    // After the window it is evaluated again and the counter advances.
    await advance(2);
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    const retried = await q1<any>(
      `SELECT blocked_attempts FROM tasks WHERE task_id = $1`,
      [big.task_id],
    );
    assert.equal(Number(retried.blocked_attempts), 2);
  });

  it("new claims stop when the quota is below committed amounts (OVERCOMMITTED)", async () => {
    await dynamicHost();
    await newTask();
    await claimOrFail("worker-a");
    await q(
      `UPDATE resource_grants SET cpu_millicores = 1000, memory_bytes = $1
        WHERE host_id = 'host-a' AND instance_id = 'worker-a'`,
      [GIB],
    );
    const t = await newTask();
    assert.equal(await claim({ instance_id: "worker-a" }), null);
    const row = await q1<any>(
      `SELECT blocked_attempts FROM tasks WHERE task_id = $1`,
      [t.task_id],
    );
    assert.equal(Number(row.blocked_attempts), 0);
  });

  it("dynamic mode uses k(i,τ) instead of a fixed instance_limit", async () => {
    await dynamicHost();
    const t1 = await newTask();
    const t2 = await newTask();
    const a = await claimOrFail("worker-a");
    const b = await claimOrFail("worker-a");
    assert.deepEqual(new Set([a.task_id, b.task_id]), new Set([t1.task_id, t2.task_id]));
  });
});
