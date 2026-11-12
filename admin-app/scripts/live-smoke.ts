/**
 * 实时管理应用数据层冒烟测试（不进浏览器，直接调用 live/*）。
 *
 * 用法（测试机）：
 *   PCS_URL=http://127.0.0.1:7901 SCHEDULER_URL=http://127.0.0.1:7801 \
 *   PCS_ADMIN_TOKEN=$(cat admin.jwt) MFA_CODE=246810 tsx live-smoke.ts
 *
 * 注意：令牌只从环境变量读取，不打印、不落盘。
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
if (!connection.adminToken) throw new Error("缺少 PCS_ADMIN_TOKEN");

const MFA = process.env.MFA_CODE ?? "246810";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitWorkflow(runId: string, status: string, seconds: number) {
  for (let i = 0; i < seconds * 4; i++) {
    const out = await scheduler(connection, `/v1/workflows/${encodeURIComponent(runId)}`);
    if (out?.run?.status === status || out?.status === status) return out;
    await sleep(250);
  }
  throw new Error(`工作流 ${runId} 在 ${seconds}s 内没有变成 ${status}`);
}

console.log("== 连通性与首次同步");
await testConnection(connection);
let summary = await syncLive(connection);
assert.ok(summary.hosts >= 1, "应至少有一台主机");
assert.ok(summary.instances >= 2, "应能看到实例");
assert.ok(summary.tasks >= 1, "应能看到任务");
assert.ok(summary.approvals >= 1, "应能看到审批记录");
const host = db.hosts.find((h) => h.state === "ONLINE" || h.state === "WARNING");
assert.ok(host, "应有一台可部署主机");
assert.ok(db.apis.every((a) => a.secret_ref.startsWith("secret://") || a.secret_ref === "-"), "API 只应展示 secret_ref");
console.log(`ok - hosts=${summary.hosts} instances=${summary.instances} tasks=${summary.tasks} approvals=${summary.approvals}`);

console.log("== 部署计划预览与应用（管理应用动作）");
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
assert.ok(db.instances.some((i) => i.id === applied.instances[0].id), "新部署实例应出现在同步视图");
console.log(`ok - plan=${plan.plan_id} instances=${applied.instances.map((i) => i.id).join(",")}`);

console.log("== 任务事件与工作流列表");
const firstTask = db.tasks[0];
if (firstTask) {
  const events = await fetchTaskEvents(connection, firstTask.id);
  assert.ok(Array.isArray(events));
}
const runs = await fetchWorkflowRuns(connection);
assert.ok(Array.isArray(runs) && runs.length >= 1, "应有工作流运行");
console.log(`ok - task events / workflow runs=${runs.length}`);

console.log("== 审批：管理应用签发令牌并提交调度机");
const submitted = await submitWorkflow(connection, {
  workflow_template_id: "wft_standard_dev",
  priority: 2,
  payload_ref: `admin://live-smoke/${Date.now()}/approval`,
});
assert.ok(submitted.workflow_run_id, "应提交工作流");
await waitWorkflow(submitted.workflow_run_id, "WAITING_APPROVAL", 150);
await syncLive(connection);
const approval = db.approvals.find(
  (a) => a.status === "PENDING" && a.requested_by === submitted.workflow_run_id,
);
assert.ok(approval, "同步视图应出现待审批项");
assert.match(approval.subject_digest, /^sha256:/);
const decided = await decideApproval(connection, {
  approval,
  decision: "APPROVED",
  reason: "管理应用实时链路冒烟",
  mfaCode: MFA,
});
assert.equal(decided.status, "APPROVED");
assert.ok(!JSON.stringify(decided).includes("eyJ"), "界面对象不应包含 JWT 明文");
await waitWorkflow(submitted.workflow_run_id, "COMPLETED", 120);
await syncLive(connection);
assert.ok(db.approvals.some((a) => a.id === approval.id && a.status === "APPROVED"), "审批状态应回到列表");
console.log(`ok - workflow ${submitted.workflow_run_id} COMPLETED，approval ${approval.id}`);

console.log("== 敏感信息扫描");
const blob = JSON.stringify(db);
assert.ok(!/"secret_value"|"password"\s*:|Bearer\s+eyJ/.test(blob), "同步视图不应含密钥值或 Bearer JWT");
assert.ok(!blob.includes(connection.adminToken), "管理员令牌不应进入界面数据");
console.log("ok - 同步视图不含管理员令牌、密钥值或 JWT");

console.log("\nLIVE SMOKE OK");
