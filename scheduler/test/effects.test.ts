import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../src/db.js";
import { ApiError } from "../src/errors.js";
import {
  ackEffect,
  createEffect,
  deleteEffect,
  listEffects,
  nackEffect,
  outboxStats,
  pullEffectEvents,
  setEffectStatus,
} from "../src/repo/effects.js";
import { assertTestDatabase, newTask, reset } from "./helpers.js";

// Effects are named outbox consumers with a durable cursor: pull, ack or nack, retry.
// The cursor only moves forward, so an ack of an older position is a conflict, not a replay.

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

describe("outbox effects", () => {
  it("starts at the latest event by default and delivers only new events", async () => {
    await newTask();
    const effect = await createEffect({ name: "notifier" });
    assert.equal(effect.cursor, await latestCursor());

    const before = await pullEffectEvents(effect.effect_id);
    assert.equal(before.items.length, 0);
    assert.equal(before.next_cursor, effect.cursor);

    await newTask();
    const after = await pullEffectEvents(effect.effect_id);
    assert.ok(after.items.length >= 1, "the new task's events should be delivered");
    assert.ok(after.next_cursor > effect.cursor);
  });

  it("replays history when after is 0 and advances the cursor on ack", async () => {
    await newTask();
    const effect = await createEffect({ name: "replayer", after: 0 });
    const pulled = await pullEffectEvents(effect.effect_id, 10);
    assert.ok(pulled.items.length >= 1);
    assert.equal(pulled.items[0].event_type, "TASK_CREATED");

    const acked = await ackEffect(effect.effect_id, pulled.next_cursor);
    assert.equal(acked.cursor, pulled.next_cursor);
    assert.equal(acked.delivered_count, pulled.items.length);
    assert.equal(acked.retry_count, 0);
    assert.equal(acked.last_error, null);

    const drained = await pullEffectEvents(effect.effect_id);
    assert.equal(drained.items.length, 0);
  });

  it("rejects a backwards ack and clamps an ack past the latest event", async () => {
    await newTask();
    const effect = await createEffect({ name: "clamp", after: 0 });
    const pulled = await pullEffectEvents(effect.effect_id);
    const acked = await ackEffect(effect.effect_id, pulled.next_cursor);
    assert.ok(acked.cursor > 0);

    await expectApiError(() => ackEffect(effect.effect_id, 0), "CURSOR_REGRESSION");

    const clamped = await ackEffect(effect.effect_id, 10_000_000);
    const latest = await latestCursor();
    assert.equal(clamped.cursor, latest);
  });

  it("records a nack without moving the cursor, and a later ack clears the retry", async () => {
    await newTask();
    const effect = await createEffect({ name: "flaky", after: 0 });
    const pulled = await pullEffectEvents(effect.effect_id);

    const failed = await nackEffect(effect.effect_id, "webhook returned 502");
    assert.equal(failed.cursor, Number(effect.cursor));
    assert.equal(failed.retry_count, 1);
    assert.equal(failed.last_error, "webhook returned 502");
    assert.ok(failed.last_attempt_at);

    const again = await nackEffect(effect.effect_id, "");
    assert.equal(again.retry_count, 2);
    assert.equal(again.last_error, "delivery failed");

    const acked = await ackEffect(effect.effect_id, pulled.next_cursor);
    assert.equal(acked.retry_count, 0);
    assert.equal(acked.last_error, null);
  });

  it("filters by event type", async () => {
    await newTask();
    const onlyCreated = await createEffect({ name: "created-only", after: 0, event_type: "TASK_CREATED" });
    const pulled = await pullEffectEvents(onlyCreated.effect_id);
    assert.ok(pulled.items.length >= 1);
    assert.ok(pulled.items.every((e) => e.event_type === "TASK_CREATED"));

    const never = await createEffect({ name: "never", after: 0, event_type: "NO_SUCH_EVENT" });
    const none = await pullEffectEvents(never.effect_id);
    assert.equal(none.items.length, 0);
  });

  it("refuses to deliver while paused and resumes on request", async () => {
    await newTask();
    const effect = await createEffect({ name: "pausable", after: 0 });
    const paused = await setEffectStatus(effect.effect_id, "PAUSED");
    assert.equal(paused.status, "PAUSED");
    await expectApiError(() => pullEffectEvents(effect.effect_id), "EFFECT_PAUSED");

    const resumed = await setEffectStatus(effect.effect_id, "ACTIVE");
    assert.equal(resumed.status, "ACTIVE");
    const pulled = await pullEffectEvents(effect.effect_id);
    assert.ok(pulled.items.length >= 1);
  });

  it("rejects duplicate names and unknown effects", async () => {
    await createEffect({ name: "only-once" });
    await expectApiError(() => createEffect({ name: "only-once" }), "EFFECT_EXISTS");
    await expectApiError(() => pullEffectEvents("eff_missing"), "NOT_FOUND");
    await expectApiError(() => ackEffect("eff_missing", 1), "NOT_FOUND");
    await expectApiError(() => nackEffect("eff_missing", "boom"), "NOT_FOUND");
    await expectApiError(() => deleteEffect("eff_missing"), "NOT_FOUND");
  });

  it("reports lag per effect and outbox totals by event type", async () => {
    await newTask();
    const effect = await createEffect({ name: "laggy", after: 0 });
    const rows = await listEffects();
    const row = rows.find((r) => r.effect_id === effect.effect_id);
    assert.ok(row);
    assert.ok((row!.lag ?? 0) >= 1);

    await ackEffect(effect.effect_id, await latestCursor());
    const drained = (await listEffects()).find((r) => r.effect_id === effect.effect_id);
    assert.equal(drained!.lag, 0);

    const stats = await outboxStats();
    assert.ok(stats.total_events >= 1);
    assert.equal(stats.max_lag, 0);
    assert.equal(stats.effect_count, 1);
    assert.equal(stats.by_type[0].event_type, "TASK_CREATED");
  });

  it("deletes a consumer and stops listing it", async () => {
    const effect = await createEffect({ name: "temporary" });
    const removed = await deleteEffect(effect.effect_id);
    assert.equal(removed.effect_id, effect.effect_id);
    assert.equal((await listEffects()).length, 0);
  });
});

async function latestCursor(): Promise<number> {
  return (await outboxStats()).latest_event_id;
}
