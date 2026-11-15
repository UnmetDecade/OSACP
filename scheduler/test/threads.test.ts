import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../src/db.js";
import { ApiError } from "../src/errors.js";
import {
  addThreadMessage,
  attachThreadTask,
  createThread,
  getThread,
  listThreads,
  pollSubscription,
  subscribeThread,
  unsubscribeThread,
} from "../src/repo/threads.js";
import { getTask } from "../src/repo/tasks.js";
import { assertTestDatabase, newTask, reset } from "./helpers.js";

// Threads index tasks and messages; a message creates the continuation task atomically, and a
// subscription reads the thread's outbox events through a stored cursor.

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
    assert.equal(e.code, code, `error code mismatch: ${e.code}`);
  }
}

describe("threads", () => {
  it("creates a thread around a task and exposes the thread id on the task", async () => {
    const task = await newTask({
      requirements: { target_instance_id: "worker-a", build: { title: "first", instruction: "first" } },
    });
    const thread = await createThread({
      title: "Fix the parser",
      source: "admin",
      created_by: "tester",
      task_id: task.task_id,
    });

    const detail = await getThread(thread.thread_id);
    assert.equal(detail.title, "Fix the parser");
    assert.equal(detail.tasks.length, 1);
    assert.equal(detail.tasks[0].task_id, task.task_id);
    assert.equal(detail.tasks[0].relation, "owner");
    assert.deepEqual(detail.messages, []);

    const withThread = await getTask(task.task_id);
    assert.equal(withThread.thread_id, thread.thread_id);
  });

  it("rejects an unknown thread instead of creating an orphan task", async () => {
    await expectApiError(() => addThreadMessage("thr_missing", { body: "hi" }), "NOT_FOUND");
    const task = await newTask();
    await expectApiError(() => attachThreadTask("thr_missing", task.task_id), "NOT_FOUND");
  });

  it("creates a follow-up task from a message and inherits the previous target", async () => {
    const first = await newTask({
      requirements: {
        target_instance_id: "worker-a",
        build: { title: "first", instruction: "first" },
      },
    });
    const thread = await createThread({ task_id: first.task_id });

    const out = await addThreadMessage(thread.thread_id, {
      body: "Now add tests for it.",
      actor: "tester",
    });
    assert.ok(out.task, "a follow-up task should be created");
    assert.equal(out.message.task_id, out.task!.task_id);
    assert.equal(out.followup?.task_type, "task.build");
    assert.equal(out.followup?.requirements?.target_instance_id, "worker-a");

    const second = await getTask(out.task!.task_id);
    const build = second.requirements.build as Record<string, unknown>;
    assert.equal(build.instruction, "Now add tests for it.");
    const threadRef = second.requirements.thread as Record<string, unknown>;
    assert.equal(threadRef.thread_id, thread.thread_id);
    assert.equal(threadRef.previous_task_id, first.task_id);
    assert.equal(second.thread_id, thread.thread_id);

    const detail = await getThread(thread.thread_id);
    assert.equal(detail.tasks.length, 2);
    assert.equal(detail.tasks[1].relation, "followup");
    assert.equal(detail.messages.length, 1);
    assert.equal(detail.messages[0].actor, "tester");
  });

  it("stores a note without a task when create_task is false", async () => {
    const first = await newTask();
    const thread = await createThread({ task_id: first.task_id });
    const out = await addThreadMessage(thread.thread_id, {
      body: "no task for this one",
      create_task: false,
    });
    assert.equal(out.task, null);
    assert.equal(out.message.task_id, null);
    const detail = await getThread(thread.thread_id);
    assert.equal(detail.tasks.length, 1);
    assert.equal(detail.messages.length, 1);
  });

  it("lists threads newest first and can attach a later task for context", async () => {
    const a = await newTask();
    const b = await newTask();
    const first = await createThread({ title: "first", task_id: a.task_id });
    const second = await createThread({ title: "second", task_id: b.task_id });
    const rows = await listThreads(10);
    assert.deepEqual(rows.map((r) => r.thread_id), [second.thread_id, first.thread_id]);

    await attachThreadTask(first.thread_id, b.task_id, "context");
    const detail = await getThread(first.thread_id);
    assert.equal(detail.tasks.length, 2);
    assert.equal(detail.tasks.find((t) => t.task_id === b.task_id)?.relation, "context");
  });

  it("delivers the thread's outbox events through a subscription cursor", async () => {
    const task = await newTask();
    const thread = await createThread({ task_id: task.task_id });
    const created = await addThreadMessage(thread.thread_id, { body: "continue", create_task: false });
    assert.ok(created.message.message_id);

    const sub = await subscribeThread(thread.thread_id, "tester");
    assert.ok(sub);
    assert.equal(Number(sub!.cursor), 0);

    const first = await pollSubscription(thread.thread_id, String(sub!.subscription_id));
    assert.ok(first.items.length >= 1, "the thread's TASK_CREATED events should be delivered");
    assert.ok(first.items.every((e) => e.aggregate_id === task.task_id));
    assert.equal(first.next_cursor, Number(first.items[first.items.length - 1].event_id));

    // Without ack the cursor stays put; polling again returns the same events.
    const again = await pollSubscription(thread.thread_id, String(sub!.subscription_id));
    assert.equal(again.items.length, first.items.length);

    const acked = await pollSubscription(thread.thread_id, String(sub!.subscription_id), { ack: true });
    assert.equal(acked.next_cursor, first.next_cursor);
    const afterAck = await pollSubscription(thread.thread_id, String(sub!.subscription_id));
    assert.equal(afterAck.items.length, 0);

    // Subscribing twice keeps one row per (thread, subscriber).
    const same = await subscribeThread(thread.thread_id, "tester");
    assert.equal(same!.subscription_id, sub!.subscription_id);

    await unsubscribeThread(thread.thread_id, String(sub!.subscription_id));
    await expectApiError(
      () => pollSubscription(thread.thread_id, String(sub!.subscription_id)),
      "NOT_FOUND",
    );
  });
});
