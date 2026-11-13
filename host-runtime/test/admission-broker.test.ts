import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AdmissionBroker, startAdmissionServer } from "../src/admission-broker.js";
import {
  checkHostAdmission,
  listHostGrants,
  releaseHostAdmission,
} from "../src/host-admission-client.js";
import type { AdmissionConfig } from "../src/runtime-config.js";

const G = 1024 ** 3;
const admissionCfg: AdmissionConfig = {
  host_reserve_bytes: 0,
  system_reserve_bytes: 0,
  safety_margin_bytes: 0,
  max_task_grant_bytes: 12 * G,
  grant_ttl_seconds: 3600,
};

function req(grantId: string, memory: number, attempt = "att_1") {
  return {
    grant_id: grantId,
    kind: "TASK" as const,
    instance_id: "ins_1",
    task_id: "tsk_1",
    attempt_id: attempt,
    resources: { memory_bytes: memory },
  };
}

function broker(total = 10 * G, available = 10 * G, cfg = admissionCfg, now?: () => number) {
  return new AdmissionBroker(
    () => total,
    () => available,
    cfg,
    now,
  );
}

test("concurrent requests cannot oversubscribe", async () => {
  const b = broker();
  const [a, c] = await Promise.all([b.check(req("rgr_a", 6 * G)), b.check(req("rgr_b", 6 * G))]);
  assert.equal([a, c].filter((r) => r.allowed).length, 1);

  const denied = a.allowed ? c : a;
  assert.equal(denied.reason, "INSUFFICIENT_MEMORY");
  assert.equal(denied.observed.requested_bytes, 6 * G);
  assert.equal(b.summary().task_grants, 1);
});

test("the same grant is idempotent; reusing a grant across attempts conflicts", async () => {
  const b = broker();
  const first = await b.check(req("rgr_a", 2 * G));
  const again = await b.check(req("rgr_a", 2 * G));
  assert.equal(first.allowed, true);
  assert.deepEqual(again, first);
  assert.equal(b.summary().task_bytes, 2 * G);

  await assert.rejects(
    () => b.check(req("rgr_a", 2 * G, "att_2")),
    (e: any) => e.code === "GRANT_CONFLICT",
  );
});

test("released capacity is returned", async () => {
  const b = broker();
  assert.equal((await b.check(req("rgr_a", 8 * G))).allowed, true);
  assert.equal((await b.check(req("rgr_b", 8 * G))).allowed, false);
  assert.deepEqual(await b.release("rgr_a"), { grant_id: "rgr_a", released: true });
  assert.deepEqual(await b.release("rgr_a"), { grant_id: "rgr_a", released: false });
  assert.equal((await b.check(req("rgr_b", 8 * G))).allowed, true);
});

test("grant prefix, type, limits, and live capacity are validated", async () => {
  const b = broker();
  await assert.rejects(
    () => b.check({ ...req("gr_x", G) }),
    (e: any) => e.code === "INVALID_GRANT",
  );
  await assert.rejects(
    () => b.check({ ...req("rgr_a", G), kind: "DEPLOYMENT" as unknown as "TASK" }),
    (e: any) => e.code === "INVALID_GRANT_KIND",
  );
  await assert.rejects(
    () => b.check(req("rgr_a", 13 * G)),
    (e: any) => e.code === "RESOURCE_REQUEST_TOO_LARGE",
  );
  await assert.rejects(
    () => b.check(req("rgr_a", 0)),
    (e: any) => e.code === "INVALID_RESOURCES",
  );

  const realtimeSmall = broker(10 * G, 1 * G);
  const denied = await realtimeSmall.check(req("rgr_a", 2 * G));
  assert.equal(denied.allowed, false);
  assert.equal(denied.observed.mem_available_bytes, 1 * G);
});

test("expired TTLs are reclaimed automatically", async () => {
  let now = 1_000_000;
  const b = broker(10 * G, 10 * G, { ...admissionCfg, grant_ttl_seconds: 10 }, () => now);
  assert.equal((await b.check(req("rgr_a", 8 * G))).allowed, true);
  assert.equal((await b.check(req("rgr_b", 8 * G))).allowed, false);
  assert.equal(b.grants().length, 1);
  now += 11_000;
  assert.equal(b.grants().length, 0, "expired grants should no longer appear in the reconciliation list");
  assert.equal((await b.check(req("rgr_b", 8 * G))).allowed, true);
});

test("deployment usage counts toward the total and does not leak after reconciler recreation", async () => {
  const b = broker();
  assert.equal((await b.checkDeployment("rgr_dep", "ins_dep", 7 * G)).allowed, true);
  assert.equal((await b.check(req("rgr_task", 4 * G))).allowed, false);

  b.setDeploymentGrants([]);
  assert.equal((await b.check(req("rgr_task", 4 * G))).allowed, true);

  b.setDeploymentGrants([
    { grant_id: "rgr_dep", instance_id: "ins_dep", memory_bytes: 5 * G },
    { grant_id: "rgr_dep2", instance_id: "ins_dep2", memory_bytes: 5 * G },
  ]);
  assert.equal(b.summary().deployment_grants, 2);
  assert.equal(b.summary().deployment_bytes, 10 * G);
});

test("redeploying the same instance does not count old container usage toward admission", async () => {
  const b = broker(8 * G, 8 * G);
  b.setDeploymentGrants([{ grant_id: "rgr_old", instance_id: "ins_dep", memory_bytes: 6 * G }]);

  // Other instances still cannot fit: the old container's 6G is still counted.
  assert.equal((await b.checkDeployment("rgr_other", "ins_other", 4 * G)).allowed, false);
  // A new deployment of the same instance takes over the old container, so the old 6G must not block itself.
  assert.equal((await b.checkDeployment("rgr_new", "ins_dep", 6 * G)).allowed, true);
});

test("the unix socket is mode 0600 and the client can inspect and release", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admission-test-"));
  const socketPath = path.join(dir, "runtime.sock");
  const b = broker();
  const server = await startAdmissionServer(b, socketPath);
  try {
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

    const ok = await checkHostAdmission(socketPath, req("rgr_sock", 2 * G));
    assert.equal(ok.allowed, true);
    assert.equal(ok.observed.allocatable_bytes, 10 * G);

    const dup = await checkHostAdmission(socketPath, req("rgr_sock", 2 * G));
    assert.deepEqual(dup, ok);

    assert.equal(b.summary().task_grants, 1);

    // Used for post-crash reconciliation: obtain the instance / attempt of an individual grant
    const listed = await listHostGrants(socketPath);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].instance_id, "ins_1");
    assert.equal(listed.items[0].attempt_id, "att_1");

    const released = await releaseHostAdmission(socketPath, "rgr_sock");
    assert.equal(released.released, true);
    assert.equal(b.summary().task_grants, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
