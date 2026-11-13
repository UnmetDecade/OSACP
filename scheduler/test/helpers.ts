import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pool, q } from "../src/db.js";
import { claim, type Assignment } from "../src/core/claim.js";
import { startAck, submitResult } from "../src/core/attempts.js";
import { createArtifact, completeArtifact, putArtifactContent } from "../src/core/artifacts.js";
import { createTask, type CreateTaskInput } from "../src/repo/tasks.js";

// Test artifacts land in a temp directory to avoid polluting the working directory
process.env.ARTIFACT_DIR ??= path.join(os.tmpdir(), "scheduler-test-artifacts");

const TABLES = [
  "outbox_events",
  "artifacts",
  "approval_requests",
  "approvals",
  "task_events",
  "leases",
  "resource_grants",
  "host_resource_pools",
  "resource_reservations",
  "task_attempts",
  "tasks",
  "task_relays",
  "workflow_runs",
  "workflow_templates",
  "scheduler_nodes",
  "role_instances",
  "hosts",
  "task_definitions",
  "resource_profiles",
];

export async function reset(): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  await pool.query(`UPDATE _clock SET offset_ms = 0`);
  // Every test starts from the same scheduler parameters so cases do not affect each other
  await pool.query(
    `UPDATE scheduler_config SET global_limit = 100, role_pool_limit = 20, instance_limit = 1,
            task_type_limit = 10, aging_after_seconds = 600, lease_seconds = 300,
            start_window_seconds = 30, suspect_after_seconds = 45, offline_after_seconds = 90,
            retry_backoff_seconds = ARRAY[300, 900, 2700],
            dynamic_policy = '{}'::jsonb`,
  );

  await q(
    `INSERT INTO resource_profiles (profile_id, cpu_millicores, memory_bytes, disk_bytes, timeout_seconds)
     VALUES ('rp_small', 2000, 2147483648, 0, 3600)`,
  );
  await q(
    `INSERT INTO task_definitions (task_type, task_version, target_role, capabilities, default_profile, max_attempts)
     VALUES ('task.build','1.0','worker',ARRAY['code.edit','shell'],'rp_small',3),
            ('task.commit','1.0','reviewer',ARRAY['svn.write'],'rp_small',1),
            ('task.review.snapshot','1.0','reviewer',ARRAY['svn.read'],'rp_small',3),
            ('task.test.run','1.0','tester',ARRAY['shell'],'rp_small',3)`,
  );
  await q(
    `INSERT INTO workflow_templates (workflow_template_id, name, version, phases, approval_policy_ref)
     VALUES ('wft_test','Test Workflow','1.0',
       '[{"phase":"EXECUTE","task_type":"task.build"},
         {"phase":"REVIEW","task_type":"task.review.snapshot"},
         {"phase":"APPROVE","action_scope":["svn.commit"],"artifact_required":true},
         {"phase":"COMMIT","task_type":"task.commit"},
         {"phase":"VERIFY","task_type":"task.test.run"}]'::jsonb,
       'policy.test.v1')`,
  );
  await q(
    `INSERT INTO hosts (host_id, name, os, arch, host_state, cpu_total, mem_total_bytes, mem_available_bytes)
     VALUES ('host-a','build-01','Linux','x86_64','NORMAL',8,549755813888,549755813888)`,
  );
  await q(
    `INSERT INTO role_instances (instance_id, role_id, host_id, state, agent_profile_id,
                                 allowed_task_types, capabilities, last_heartbeat_at)
     VALUES ('worker-a','worker','host-a','ONLINE','agent-w1',ARRAY['task.build'],
             '{"healthy":["code.edit","shell"]}', app_now()),
            ('worker-b','worker','host-a','ONLINE','agent-w1',ARRAY['task.build'],
             '{"healthy":["code.edit","shell"]}', app_now()),
            ('reviewer-a','reviewer','host-a','ONLINE','agent-r1',
             ARRAY['task.review.snapshot','task.commit'],
             '{"healthy":["svn.read","svn.write"]}', app_now()),
            ('tester-a','tester','host-a','ONLINE','agent-t1',
             ARRAY['task.test.run'], '{"healthy":["shell"]}', app_now())`,
  );
}

/** Time travel: advance(31) expires the start window, advance(301) expires the lease */
export async function advance(seconds: number): Promise<void> {
  await pool.query(`UPDATE _clock SET offset_ms = offset_ms + $1`, [seconds * 1000]);
}

export async function newTask(input: Partial<CreateTaskInput> = {}) {
  return createTask({
    task_type: "task.build",
    resource_profile_id: "rp_small",
    priority_class: 1,
    ...input,
  });
}

export async function claimOrFail(instanceId: string): Promise<Assignment> {
  const a = await claim({ instance_id: instanceId });
  if (!a) throw new Error(`${instanceId} did not claim a task`);
  return a;
}

/** Walk the full artifact channel: declare digest → upload → server recompute → COMPLETE. Returns the server-confirmed digest. */
export async function uploadArtifactFor(
  taskId: string,
  content: string,
  instanceId = "reviewer-a",
): Promise<string> {
  const buf = Buffer.from(content);
  const sha = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
  const meta = await createArtifact(
    { task_id: taskId, sha256: sha, size_bytes: buf.length, media_type: "text/plain" },
    instanceId,
  );
  await putArtifactContent(meta.artifact_id as string, buf, instanceId);
  await completeArtifact(meta.artifact_id as string, instanceId);
  return sha;
}

export async function runToSuccess(instanceId: string, taskId: string) {
  const a = await claimOrFail(instanceId);
  await startAck(a.attempt_id, {
    lease_token: a.lease_token,
    fencing_token: a.fencing_token,
    instance_id: instanceId,
  });
  const r = await submitResult(a.attempt_id, {
    lease_token: a.lease_token,
    fencing_token: a.fencing_token,
    instance_id: instanceId,
    status: "SUCCEEDED",
    summary: "ok",
  });
  return { assignment: a, result: r, taskId };
}
