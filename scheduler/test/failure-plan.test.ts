import assert from "node:assert/strict";
import { test } from "node:test";
import { planFailure } from "../src/core/attempts.js";
import { failureKind, failureSignature, normalizeFailure } from "../src/repo/failures.js";

/** Fixed clock so reset-time arithmetic is deterministic. */
const now = new Date("2026-11-13T12:00:00.000Z");

function plan(overrides: Partial<Parameters<typeof planFailure>[0]> = {}) {
  return planFailure({
    code: "AGENT_FAILED",
    outward: false,
    now,
    attemptCount: 1,
    maxAttempts: 3,
    waivers: 0,
    backoffSeconds: 300,
    ...overrides,
  });
}

test("a failure after an outward action is never retried", () => {
  const p = plan({ outward: true, code: "AGENT_FAILED" });
  assert.equal(p.action, "dead");
  assert.equal(p.failure_class, "outward");
  assert.equal(p.outcome, "interrupted_after_outward");
});

test("a rate limit waits until the provider's reset instead of spending retries", () => {
  const p = plan({ code: "PROVIDER_RATE_LIMITED", retryAt: "2026-11-13T12:30:00.000Z" });
  assert.equal(p.action, "wait");
  assert.equal(p.failure_class, "rate_limit");
  assert.equal(p.wait_seconds, 1800);
});

test("a rate limit accepts epoch milliseconds and clamps long waits to 12h", () => {
  const p = plan({ code: "USAGE_LIMIT", retryAt: now.getTime() + 40 * 3600 * 1000 });
  assert.equal(p.action, "wait");
  assert.equal(p.wait_seconds, 12 * 3600);
});

test("a reset in the past or missing falls back to a bounded wait", () => {
  assert.equal(plan({ code: "RATE_LIMITED", retryAt: "2026-11-13T11:00:00.000Z" }).wait_seconds, 60);
  assert.equal(plan({ code: "RATE_LIMITED" }).wait_seconds, 15 * 60);
});

test("waiting is bounded by the waiver budget", () => {
  const p = plan({ code: "RATE_LIMITED", waivers: 6 });
  assert.equal(p.action, "dead");
  assert.equal(p.outcome, "rate_limited");
});

test("a busy host is a short recheck, not a failure", () => {
  const p = plan({ code: "AGENT_BUSY" });
  assert.equal(p.action, "wait");
  assert.equal(p.failure_class, "busy");
  assert.equal(p.wait_seconds, 30);
});

test("a deterministic refusal is never retried", () => {
  const p = plan({ code: "UPSTREAM_ARTIFACT_DIGEST_MISMATCH", attemptCount: 1 });
  assert.equal(p.action, "dead");
  assert.equal(p.failure_class, "permanent");
});

test("a transient failure backs off while attempts remain, then dead-letters", () => {
  const retry = plan({ attemptCount: 1, maxAttempts: 3 });
  assert.equal(retry.action, "retry");
  assert.equal(retry.wait_seconds, 300);
  const exhausted = plan({ attemptCount: 3, maxAttempts: 3 });
  assert.equal(exhausted.action, "dead");
  assert.equal(exhausted.failure_class, "transient");
});

test("normalization removes the parts that differ between hosts", () => {
  const normalized = normalizeFailure(
    "ENOENT /build/a1/src/x.ts after 42 tries, see https://ci.example/run/123 and id 3f2b9a10-1111-2222-3333-444455556666",
  );
  assert.equal(normalized, "ENOENT <path> after <n> tries, see <url> and id <uuid>");
});

test("the same failure on two hosts shares a signature", () => {
  const a = failureSignature("AGENT_FAILED", "ENOENT /build/aaa/src/x.ts");
  const b = failureSignature("AGENT_FAILED", "ENOENT /build/bbb/src/y.ts");
  assert.equal(a.signature, b.signature);
  assert.equal(a.kind, "error");
});

test("a different failure gets a different signature", () => {
  const a = failureSignature("AGENT_FAILED", "EACCES /build/x");
  const b = failureSignature("AGENT_FAILED", "ENOSPC /build/x");
  assert.notEqual(a.signature, b.signature);
});

test("the kind names the failure family", () => {
  assert.equal(failureKind("AGENT_TIMEOUT"), "timeout");
  assert.equal(failureKind("AGENT_STALLED"), "stalled");
  assert.equal(failureKind("PROVIDER_RATE_LIMITED"), "rate_limit");
  assert.equal(failureKind("UPSTREAM_ARTIFACT_DIGEST_MISMATCH"), "permanent");
  assert.equal(failureKind("INTERRUPTED_AFTER_OUTWARD_ACTION"), "outward");
});
