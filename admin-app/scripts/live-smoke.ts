/**
 * Live admin app data-layer smoke test (no browser; calls live/* directly).
 *
 * Usage (test machine):
 *   PCS_URL=http://127.0.0.1:7901 SCHEDULER_URL=http://127.0.0.1:7801 \
 *   PCS_ADMIN_TOKEN=$(cat admin.jwt) MFA_CODE=246810 tsx live-smoke.ts
 *
 * Note: tokens are read from environment variables only; never printed or persisted.
 */
import assert from "node:assert/strict";
import {
  applyPlan,
  decideApproval,
  fetchWorkflowRuns,
  instanceAction,
  previewPlan,
  submitWorkflow,
  testConnection,
} from "../src/live/actions";
import { scheduler } from "../src/live/client";
import type { LiveConnection } from "../src/live/config";
import { db } from "../src/mock/store";
import { fetchTaskEvents, syncLive } from "../src/live/sync";

const connection: LiveConnection = {
  pcsUrl: process.env.PCS_URL ?? "http://127.0.0.1:7901",
  schedulerUrl: process.env.SCHEDULER_URL ?? "http://127.0.0.1:7801",
  adminToken: process.env.PCS_ADMIN_TOKEN ?? "",
  operator: process.env.OPERATOR ?? "alice",
};
if (!connection.adminToken) throw new Error("PCS_ADMIN_TOKEN is required");

const MFA = process.env.MFA_CODE ?? "246810";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitWorkflow(runId: string, status: string, seconds: number) {
  for (let i = 0; i < seconds * 4; i++) {
    const out = await scheduler(connection, `/v1/workflows/${encodeURIComponent(runId)}`);
    if (out?.run?.status === status || out?.status === status) return out;
    await sleep(250);
  }
  throw new Error(`workflow ${runId} did not reach ${status} within ${seconds}s`);
}

console.log("== Connectivity and first sync");
await testConnection(connection);
let summary = await syncLive(connection);
assert.ok(summary.hosts >= 1, "expected at least one host");
assert.ok(summary.instances >= 2, "expected to see instances");
assert.ok(summary.tasks >= 1, "expected to see tasks");
assert.ok(summary.approvals >= 1, "expected to see approval records");
const host = db.hosts.find((h) => h.state === "ONLINE" || h.state === "WARNING");
assert.ok(host, "expected a deployable host");
assert.ok(db.apis.every((a) => a.secret_ref.startsWith("secret://") || a.secret_ref === "-"), "APIs should expose only secret_ref");
console.log(`ok - hosts=${summary.hosts} instances=${summary.instances} tasks=${summary.tasks} approvals=${summary.approvals}`);

console.log("== Deployment plan preview and apply (admin app actions)");
const plan = await previewPlan(connection, {
  host_id: host.id,
  role: "worker",
  count: 2,
  agent_profile_id: "agp_p5",
  api_profile_ids: ["api_p5"],
  resource_profile: "rp_worker_medium",
});
assert.match(plan.plan_digest, /^sha256:/);
assert.equal(plan.names.length, 2);
const applied = await applyPlan(connection, plan);
assert.equal(applied.instances.length, 2);
await instanceAction(connection, applied.instances[0].id, "restart");
summary = await syncLive(connection);
assert.ok(db.instances.some((i) => i.id === applied.instances[0].id), "newly deployed instances should appear in the sync view");
console.log(`ok - plan=${plan.plan_id} instances=${applied.instances.map((i) => i.id).join(",")}`);

console.log("== Task events and workflow list");
const firstTask = db.tasks[0];
if (firstTask) {
  const events = await fetchTaskEvents(connection, firstTask.id);
  assert.ok(Array.isArray(events));
}
const runs = await fetchWorkflowRuns(connection);
assert.ok(Array.isArray(runs) && runs.length >= 1, "expected at least one workflow run");
console.log(`ok - task events / workflow runs=${runs.length}`);

console.log("== Approval: the admin app issues a token and submits it to the scheduler");
const submitted = await submitWorkflow(connection, {
  workflow_template_id: "wft_standard_dev",
  priority: 2,
  payload_ref: `admin://live-smoke/${Date.now()}/approval`,
});
assert.ok(submitted.workflow_run_id, "expected a submitted workflow");
await waitWorkflow(submitted.workflow_run_id, "WAITING_APPROVAL", 150);
await syncLive(connection);
const approval = db.approvals.find(
  (a) => a.status === "PENDING" && a.requested_by === submitted.workflow_run_id,
);
assert.ok(approval, "the sync view should contain a pending approval");
assert.match(approval.subject_digest, /^sha256:/);
const decided = await decideApproval(connection, {
  approval,
  decision: "APPROVED",
  reason: "admin app live-path smoke test",
  mfaCode: MFA,
});
assert.equal(decided.status, "APPROVED");
assert.ok(!JSON.stringify(decided).includes("eyJ"), "UI objects must not contain a plaintext JWT");
await waitWorkflow(submitted.workflow_run_id, "COMPLETED", 120);
await syncLive(connection);
assert.ok(db.approvals.some((a) => a.id === approval.id && a.status === "APPROVED"), "the approval state should be reflected in the list");
console.log(`ok - workflow ${submitted.workflow_run_id} COMPLETED，approval ${approval.id}`);

console.log("== Sensitive-data scan");
const blob = JSON.stringify(db);
assert.ok(!/"secret_value"|"password"\s*:|Bearer\s+eyJ/.test(blob), "the sync view must not contain secret values or Bearer JWTs");
assert.ok(!blob.includes(connection.adminToken), "the admin token must not reach UI data");
console.log("ok - the sync view contains no admin token, secret value, or JWT");

console.log("\nLIVE SMOKE OK");
