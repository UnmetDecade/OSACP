import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool, q, q1 } from "../src/db.js";
import { ApiError } from "../src/errors.js";
import { progress, startAck, submitResult } from "../src/core/attempts.js";
import { splitTask } from "../src/core/fanout.js";
import { sweepLeases, sweepNeedsInput } from "../src/loops/reaper.js";
import { answerTask, cancelTask, getTask } from "../src/repo/tasks.js";
import { advance, assertTestDatabase, claimOrFail, newTask, reset, runToSuccess } from "./helpers.js";

// Parking and fan-out extend the task state machine; these cases pin the edges that make them
// safe: the retry budget, the resume limits, and the rule that a task which already acted
// outside the workspace is never rerun automatically.

before(async () => {
  await assertTestDatabase();
});

beforeEach(async () => {
  await reset();
});

after(async () => {
  await closePool();
});

function proof(a: { lease_token: string; fencing_token: number }, instanceId: string) {
  return { lease_token: a.lease_token, fencing_token: a.fencing_token, instance_id: instanceId };
}

async function startedTask(instanceId = "worker-a") {
  const task = await newTask();
  const a = await claimOrFail(instanceId);
  assert.equal(a.task_id, task.task_id);
  await startAck(a.attempt_id, proof(a, instanceId));
  return { task, a };
}

async function expectApiError(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    assert.fail(`expected ${code} to be thrown, but the call succeeded`);
  } catch (e) {
    assert.ok(e instanceof ApiError, `expected ApiError, got ${e}`);
    assert.equal(e.code, code, `error code mismatch: ${e.code}`);
  }
}

describe("agent control: needs_input", () => {
  it("parks the attempt, releases the lease, and an answer requeues without spending a retry", async () => {
    const { task, a } = await startedTask();

    const r = await submitResult(a.attempt_id, {
      ...proof(a, "worker-a"),
      status: "NEEDS_INPUT",
      summary: "Which branch?",
      question: "Which branch should I push to?",
    });
    assert.equal(r.needs_input, true);

    const parked = await getTask(task.task_id);
    assert.equal(parked.status, "NEEDS_INPUT");
    assert.equal(parked.pending_question.question, "Which branch should I push to?");
    assert.equal(parked.current_attempt_id, null);
    const attempt = await q1(`SELECT status, park_reason FROM task_attempts WHERE attempt_id = $1`, [a.attempt_id]);
    assert.equal(attempt.status, "PARKED");
    assert.equal(attempt.park_reason, "NEEDS_INPUT");
    const lease = await q1(`SELECT released_at FROM leases WHERE attempt_id = $1`, [a.attempt_id]);
    assert.ok(lease.released_at, "the lease is released so another builder could take other work");

    const answered = await answerTask(task.task_id, "Use main", "alice");
    assert.equal(answered.status, "QUEUED");
    assert.equal(answered.resume_rounds, 1);
    // claim added one attempt and answering rolled it back: parking is not a failure.
    assert.equal(answered.attempt_count, 0);
    assert.equal(answered.requirements.input_answers.length, 1);
    assert.equal(answered.requirements.input_answers[0].answer, "Use main");
    assert.equal(answered.requirements.input_answers[0].question, "Which branch should I push to?");

    // The failed-capable budget is intact: the task can still use its full retry allowance.
    assert.equal(answered.max_attempts, 3);
    await runToSuccess("worker-a", task.task_id);
    assert.equal((await getTask(task.task_id)).status, "SUCCEEDED");
  });

  it("rejects an empty question and an answer to a task that is not waiting", async () => {
    const { task, a } = await startedTask();
    await expectApiError(
      () => submitResult(a.attempt_id, { ...proof(a, "worker-a"), status: "NEEDS_INPUT", question: "  " }),
      "QUESTION_REQUIRED",
    );
    await expectApiError(() => answerTask(task.task_id, "too early"), "STATE_CONFLICT");
    await expectApiError(() => answerTask(task.task_id, "   "), "ANSWER_REQUIRED");
  });

  it("fails a task that used up its resume rounds instead of accepting the answer", async () => {
    const { task, a } = await startedTask();
    await submitResult(a.attempt_id, {
      ...proof(a, "worker-a"),
      status: "NEEDS_INPUT",
      question: "Which database?",
    });
    await q(`UPDATE scheduler_config SET max_resume_rounds = 1`);
    await q(`UPDATE tasks SET resume_rounds = 1 WHERE task_id = $1`, [task.task_id]);

    const answered = await answerTask(task.task_id, "postgres");
    assert.equal(answered.answer_rejected, "TOO_MANY_RESUMES");
    const failed = await getTask(task.task_id);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.outcome, "input_exhausted");
    assert.equal(failed.dead_letter, true);
  });

  it("expires a question nobody answered, without retrying it", async () => {
    const { task, a } = await startedTask();
    await submitResult(a.attempt_id, {
      ...proof(a, "worker-a"),
      status: "NEEDS_INPUT",
      question: "Which region?",
    });
    await q(`UPDATE tasks SET needs_input_expires_at = app_now() - interval '1 minute' WHERE task_id = $1`, [
      task.task_id,
    ]);

    const swept = await sweepNeedsInput();
    assert.ok(swept.expired.includes(task.task_id));
    const failed = await getTask(task.task_id);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.outcome, "input_expired");
    assert.equal(failed.dead_letter, true);
  });
});

describe("agent control: fan-out", () => {
  it("parks the parent and enqueues children with their own instructions and depth", async () => {
    const task = await newTask({
      requirements: { build: { instruction: "build everything", attachments: [{ url: "https://example.test/a.zip" }] } },
    });
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, proof(a, "worker-a"));

    const split = await splitTask(task.task_id, proof(a, "worker-a"), [
      { title: "API", instruction: "Build the API" },
      { title: "UI", instruction: "Build the UI" },
    ]);
    assert.equal(split.children.length, 2);

    const parent = await getTask(task.task_id);
    assert.equal(parent.status, "WAITING_CHILDREN");
    assert.equal(parent.current_attempt_id, null);
    assert.equal(parent.fanout_rounds, 1);
    const attempt = await q1(`SELECT status, park_reason FROM task_attempts WHERE attempt_id = $1`, [a.attempt_id]);
    assert.equal(attempt.status, "PARKED");
    assert.equal(attempt.park_reason, "SPLIT");
    const lease = await q1(`SELECT released_at FROM leases WHERE task_id = $1 AND released_at IS NULL`, [
      task.task_id,
    ]);
    assert.equal(lease, null);

    const children = await q(`SELECT * FROM tasks WHERE fanout_id = $1`, [task.task_id]);
    assert.equal(children.length, 2);
    for (const child of children) {
      assert.equal(child.status, "QUEUED");
      assert.equal(child.task_type, "task.build");
      assert.equal(child.fanout_depth, 1);
      assert.equal(child.parent_task_id, task.task_id);
      // Attachments are shared so each child sees the same inputs; fanout positioning is recorded.
      assert.equal(child.requirements.build.attachments[0].url, "https://example.test/a.zip");
      assert.equal(child.requirements.fanout.parent_task_id, task.task_id);
      assert.equal(child.requirements.fanout.total, 2);
    }
    const byTitle = Object.fromEntries(children.map((c) => [c.requirements.build.title, c.requirements.build.instruction]));
    assert.equal(byTitle.API, "Build the API");
    assert.equal(byTitle.UI, "Build the UI");
  });

  it("resumes the parent with every child's result once the last child is terminal", async () => {
    const task = await newTask({ requirements: { build: { instruction: "build everything" } } });
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, proof(a, "worker-a"));
    await splitTask(task.task_id, proof(a, "worker-a"), [
      { instruction: "Build the API" },
      { instruction: "Build the UI" },
    ]);

    await runToSuccess("worker-a", "");
    assert.equal((await getTask(task.task_id)).status, "WAITING_CHILDREN", "one child is still running");
    await runToSuccess("worker-b", "");

    const parent = await getTask(task.task_id);
    assert.equal(parent.status, "QUEUED");
    assert.equal(parent.resume_rounds, 1);
    // The attempt spent on the split is given back; the resumed run gets the full budget.
    assert.equal(parent.attempt_count, 0);
    const results = parent.requirements.fanout_results;
    assert.equal(results.length, 2);
    assert.ok(results.every((r: any) => r.status === "SUCCEEDED"));
    const settled = await q1(
      `SELECT event_type FROM task_events WHERE task_id = $1 AND event_type = 'TASK_CHILDREN_SETTLED'`,
      [task.task_id],
    );
    assert.ok(settled, "the settle is recorded as its own event");
  });

  it("refuses a split that is too wide, too deep, or has a child without instructions", async () => {
    const { task, a } = await startedTask();
    const p = proof(a, "worker-a");

    await q(`UPDATE scheduler_config SET max_fanout_children = 2`);
    await expectApiError(
      () => splitTask(task.task_id, p, [{ instruction: "a" }, { instruction: "b" }, { instruction: "c" }]),
      "SPLIT_TOO_WIDE",
    );
    await expectApiError(() => splitTask(task.task_id, p, [{ title: "no instruction" }]), "SPLIT_INVALID");
    await expectApiError(() => splitTask(task.task_id, p, []), "SPLIT_INVALID");

    await q(`UPDATE scheduler_config SET max_fanout_children = 16, max_fanout_depth = 1`);
    await splitTask(task.task_id, p, [{ instruction: "Build the API" }]);
    const child = await claimOrFail("worker-b");
    await startAck(child.attempt_id, proof(child, "worker-b"));
    await expectApiError(
      () => splitTask(child.task_id, proof(child, "worker-b"), [{ instruction: "grandchild" }]),
      "SPLIT_TOO_DEEP",
    );

    // Splitting one task over and over is also bounded, independently of the tree depth.
    const repeat = await startedTask("worker-a");
    await q(`UPDATE scheduler_config SET max_resume_rounds = 1`);
    await q(`UPDATE tasks SET fanout_rounds = 1 WHERE task_id = $1`, [repeat.task.task_id]);
    await expectApiError(
      () => splitTask(repeat.task.task_id, proof(repeat.a, "worker-a"), [{ instruction: "again" }]),
      "SPLIT_TOO_MANY",
    );
  });

  it("cancelling the last non-terminal child still resumes the parent", async () => {
    const task = await newTask();
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, proof(a, "worker-a"));
    await splitTask(task.task_id, proof(a, "worker-a"), [
      { instruction: "Build the API" },
      { instruction: "Build the UI" },
    ]);

    await runToSuccess("worker-a", "");
    const remaining = await q1(`SELECT task_id FROM tasks WHERE fanout_id = $1 AND status = 'QUEUED'`, [
      task.task_id,
    ]);
    // Without settling on cancellation the parent would wait for a sibling that no longer exists.
    await cancelTask(remaining.task_id, "alice");

    const parent = await getTask(task.task_id);
    assert.equal(parent.status, "QUEUED");
    const results = parent.requirements.fanout_results;
    assert.deepEqual(
      results.map((r: any) => r.status),
      ["SUCCEEDED", "CANCELLED"],
    );
  });

  it("cancelling the parent cancels every child and does not resume the parent", async () => {
    const task = await newTask();
    const a = await claimOrFail("worker-a");
    await startAck(a.attempt_id, proof(a, "worker-a"));
    const split = await splitTask(task.task_id, proof(a, "worker-a"), [
      { instruction: "Build the API" },
      { instruction: "Build the UI" },
    ]);

    const cancelled = await cancelTask(task.task_id, "alice");
    assert.equal(cancelled.status, "CANCELLED");
    const children = await q(`SELECT status FROM tasks WHERE fanout_id = $1`, [task.task_id]);
    assert.deepEqual(
      children.map((c) => c.status),
      ["CANCELLED", "CANCELLED"],
    );
    // Settling a cancelled descendant must not bring the parent back.
    assert.equal((await getTask(task.task_id)).status, "CANCELLED");
    assert.equal((await getTask(split.children[0])).status, "CANCELLED");
  });
});

describe("agent control: outward actions", () => {
  it("persists an outward action on progress and records an event", async () => {
    const { task, a } = await startedTask();
    const r = await progress(a.attempt_id, {
      ...proof(a, "worker-a"),
      percent: 50,
      outward: ["git push origin main"],
    });
    assert.deepEqual(r.outward_actions, ["git push origin main"]);

    // A repeat report is merged, not duplicated: the list is evidence, not a counter.
    await progress(a.attempt_id, { ...proof(a, "worker-a"), outward: ["git push origin main"] });
    const attempt = await q1(`SELECT outward_actions FROM task_attempts WHERE attempt_id = $1`, [a.attempt_id]);
    assert.deepEqual(attempt.outward_actions, ["git push origin main"]);

    const event = await q1(
      `SELECT payload FROM task_events WHERE task_id = $1 AND event_type = 'TASK_OUTWARD_ACTION'`,
      [task.task_id],
    );
    assert.ok(event, "the action is recorded before the attempt ends");
    assert.deepEqual(event.payload.outward_actions, ["git push origin main"]);
  });

  it("dead-letters a failure after an outward action instead of retrying it", async () => {
    const { task, a } = await startedTask();
    const r = await submitResult(a.attempt_id, {
      ...proof(a, "worker-a"),
      status: "FAILED",
      summary: "push was interrupted",
      error: { code: "AGENT_FAILED", message: "connection dropped" },
      outward_actions: ["npm publish"],
    });
    assert.equal(r.dead_letter, true);
    assert.equal(r.outcome, "interrupted_after_outward");

    const failed = await getTask(task.task_id);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.outcome, "interrupted_after_outward");
    assert.equal(failed.dead_letter, true);
    // The retry budget was not spent: the task is not retrying because rerunning would be unsafe.
    assert.equal(failed.attempt_count, 1);
    assert.equal(failed.max_attempts, 3);
  });

  it("fails an expired lease after an outward action instead of requeueing it", async () => {
    const { task, a } = await startedTask();
    await progress(a.attempt_id, { ...proof(a, "worker-a"), outward: ["docker push registry.example/app"] });

    await advance(301); // expires the lease
    const swept = await sweepLeases();
    assert.ok(swept.reclaimed.some((x) => x.task_id === task.task_id));

    const failed = await getTask(task.task_id);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.outcome, "interrupted_after_outward");
    assert.equal(failed.dead_letter, true);
    const deadLettered = await q1(
      `SELECT payload FROM task_events WHERE task_id = $1 AND event_type = 'TASK_DEAD_LETTERED'`,
      [task.task_id],
    );
    assert.equal(deadLettered.payload.error_code, "INTERRUPTED_AFTER_OUTWARD_ACTION");
    assert.deepEqual(deadLettered.payload.outward_actions, ["docker push registry.example/app"]);
  });

  it("still requeues an expired lease when nothing left the machine", async () => {
    const { task, a } = await startedTask();
    await progress(a.attempt_id, { ...proof(a, "worker-a"), percent: 20 });
    await advance(301);
    await sweepLeases();
    const requeued = await getTask(task.task_id);
    assert.equal(requeued.status, "QUEUED");
    assert.equal(requeued.dead_letter, false);
  });
});
