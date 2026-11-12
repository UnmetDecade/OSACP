import { q, q1, tx, type Client } from "../db.js";
import { config } from "../config.js";
import { appendEvent } from "../events.js";
import { assertTransition, isTerminal, type TaskStatus } from "../statemachine.js";
import { selfNodeId } from "../node.js";
import type { CreateTaskInput } from "../repo/task-insert.js";

/**
 * Cross-scheduler task relay (architecture rule: root → node → grandchild).
 *
 * Rules:
 *   - Push down only, never copy. The parent keeps the task row locally as QUEUED but excludes it from claim candidates;
 *     actual execution happens in the child's own database.
 *   - Target "tasks the root cannot handle": carries target_instance_id but this machine has no such instance,
 *     or this machine has no online builder capable of difficulty D.
 *   - The parent periodically pulls the child's task row and mirrors its state back; cancellation is forwarded downward too.
 *   - When the whole subtree lacks capability, the task stays queued on the parent and never vanishes.
 */

const MAX_RELAY_DEPTH = 8;
const RELAY_FETCH_TIMEOUT_MS = 8_000;
const RELAY_NODE_FRESH_SECONDS = Math.max(
  90,
  Math.ceil(config.federationIntervalMs / 1000) * 3,
);

type RelayNode = {
  node_id: string;
  url: string;
  max_builder_score: number;
  idle_builder_count: number;
};

type TaskRow = {
  task_id: string;
  task_type: string;
  status: TaskStatus;
  requirements: Record<string, unknown> | null;
  difficulty: number;
  workflow_run_id?: string | null;
  parent_task_id?: string | null;
  relay_depth?: number;
};

function logRelay(message: string, extra?: unknown): void {
  if (extra === undefined) console.warn(`[relay] ${message}`);
  else console.warn(`[relay] ${message}`, extra);
}

/**
 * Called after task creation: if this machine cannot handle it, pick a direct child and push it down.
 * Failure is only logged; the task stays in the local queue and normal submission is unaffected.
 */
export async function maybeRelayTask(
  task: TaskRow,
  input: CreateTaskInput,
): Promise<{ node_id: string; child_task_id: string } | null> {
  if (!config.federationToken) return null;
  const depth = Number(input.relay?.depth ?? task.relay_depth ?? 0);
  if (depth >= MAX_RELAY_DEPTH) return null;
  // Workflow child tasks must advance in the same database; cross-database relay would split the state machine.
  if (task.workflow_run_id || task.parent_task_id) return null;
  // A task already pushed down is not moved to another node, avoiding duplicate delivery and running on both sides.
  const relayed = await q1(`SELECT 1 AS ok FROM task_relays WHERE parent_task_id = $1`, [
    task.task_id,
  ]);
  if (relayed) return null;

  const def = await q1<{ target_role: string }>(
    `SELECT target_role FROM task_definitions WHERE task_type = $1`,
    [task.task_type],
  );
  if (def?.target_role !== "builder") return null;

  const requirements = (task.requirements ?? {}) as Record<string, unknown>;
  const targetInstance = String(requirements.target_instance_id ?? "").trim();
  const node = targetInstance
    ? await relayNodeForInstance(targetInstance)
    : await relayNodeForCapacity(task.task_type, task.difficulty, task.task_id);
  if (!node?.url) return null;

  try {
    return await relayToNode(node, task, input, depth);
  } catch (e) {
    logRelay(`下推失败 ${task.task_id} → ${node.node_id}`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** When the target instance is not local, find the direct child whose instance roster contains it. */
async function relayNodeForInstance(instanceId: string): Promise<RelayNode | null> {
  const local = await q1(`SELECT 1 AS ok FROM role_instances WHERE instance_id = $1 LIMIT 1`, [
    instanceId,
  ]);
  if (local) return null;
  return q1<RelayNode>(
    `SELECT node_id, url, max_builder_score, idle_builder_count
       FROM scheduler_nodes
      WHERE parent_node_id = $1
        AND url IS NOT NULL AND url <> ''
        AND updated_at > app_now() - make_interval(secs => $2)
        AND instances @> $3::jsonb
      ORDER BY node_id
      LIMIT 1`,
    [selfNodeId(), RELAY_NODE_FRESH_SECONDS, JSON.stringify([{ instance_id: instanceId }])],
  );
}

/**
 * Build task with no target instance: keep it local if an online builder can handle it;
 * otherwise find a direct child that can handle difficulty D (the higher the difficulty, the more we prefer one just capable enough,
 * and when difficulty is unrestricted, prefer the idler one).
 */
async function relayNodeForCapacity(
  taskType: string,
  difficulty: number,
  parentTaskId: string,
): Promise<RelayNode | null> {
  const d = Number(difficulty) || 0;
  const local = await q1<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM role_instances r
      WHERE r.role_id = 'builder'
        AND r.state = 'ONLINE'
        AND $1 = ANY(r.allowed_task_types)
        AND $2 = ANY(r.payload_schemas)
        AND ($3 <= 0 OR r.capability_score >= $3)`,
    [taskType, "1.0", d],
  );
  if (Number(local?.n ?? 0) > 0) return null;

  // A task already pushed down is not moved to another node, avoiding running on both sides.
  const relayed = await q1(`SELECT 1 AS ok FROM task_relays WHERE parent_task_id = $1`, [
    parentTaskId,
  ]);
  if (relayed) return null;

  const order =
    d > 0
      ? "max_builder_score ASC, idle_builder_count DESC, node_id"
      : "idle_builder_count DESC, max_builder_score DESC, node_id";
  return q1<RelayNode>(
    `SELECT node_id, url, max_builder_score, idle_builder_count
       FROM scheduler_nodes
      WHERE parent_node_id = $1
        AND url IS NOT NULL AND url <> ''
        AND builder_count > 0
        AND updated_at > app_now() - make_interval(secs => $2)
        AND ($3 <= 0 OR max_builder_score >= $3)
      ORDER BY ${order}
      LIMIT 1`,
    [selfNodeId(), RELAY_NODE_FRESH_SECONDS, d],
  );
}

async function relayToNode(
  node: RelayNode,
  task: TaskRow,
  input: CreateTaskInput,
  depth: number,
): Promise<{ node_id: string; child_task_id: string }> {
  const body = {
    task_type: input.task_type,
    priority_class: input.priority_class,
    payload_ref: input.payload_ref,
    payload_sha256: input.payload_sha256,
    payload_schema: input.payload_schema,
    requirements: input.requirements,
    resource_profile_id: input.resource_profile_id,
    difficulty: input.difficulty,
    max_attempts: input.max_attempts,
    deadline_at: input.deadline_at,
    trace_id: input.trace_id,
    relay: {
      parent_task_id: task.task_id,
      parent_node_id: selfNodeId(),
      depth: depth + 1,
    },
  };

  const res = await fetch(`${node.url.replace(/\/+$/, "")}/v1/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-federation-token": config.federationToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`子结点返回 ${res.status}: ${text.slice(0, 200)}`);
  }
  let out: any = null;
  try {
    out = JSON.parse(text);
  } catch {
    throw new Error("子结点返回的不是 JSON");
  }
  const childTaskId = String(out?.task_id ?? "").trim();
  if (!childTaskId) throw new Error("子结点没有返回 task_id");

  await tx(async (c) => {
    const inserted = await c.query(
      `INSERT INTO task_relays
         (parent_task_id, child_node_id, child_url, child_task_id, state)
       VALUES ($1,$2,$3,$4,'ACTIVE')
       ON CONFLICT (parent_task_id) DO NOTHING
       RETURNING *`,
      [task.task_id, node.node_id, node.url.replace(/\/+$/, ""), childTaskId],
    );
    if (!inserted.rows[0]) return;
    await appendEvent(c, {
      task_id: task.task_id,
      event_type: "TASK_RELAYED",
      to_status: "QUEUED",
      actor: selfNodeId(),
      payload: {
        child_node_id: node.node_id,
        child_task_id: childTaskId,
        child_url: node.url,
        depth: depth + 1,
      },
    });
  });

  return { node_id: node.node_id, child_task_id: childTaskId };
}

type RelayRow = {
  parent_task_id: string;
  child_node_id: string;
  child_url: string;
  child_task_id: string;
  state: string;
  cancel_sent: boolean;
  sync_failures: number;
  parent_status: TaskStatus;
  cancel_requested_at: string | null;
};

function latestAttempt(child: any): Record<string, any> | null {
  const attempts = Array.isArray(child?.attempts) ? child.attempts : [];
  return attempts.length ? attempts[attempts.length - 1] : null;
}

function childSummary(child: any): string {
  const attempt = latestAttempt(child);
  return String(child?.result_summary ?? attempt?.result_summary ?? "");
}

function childOutputs(child: any): Record<string, unknown> {
  const attempt = latestAttempt(child);
  // Multi-level relay: the intermediate node has no attempt of its own; outputs hang off the child task it pushed down,
  // so the nested child_result.outputs must be lifted up verbatim, or the root only gets the summary.
  const raw = attempt?.outputs ?? child?.relay?.child_result?.outputs;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

async function mirrorStatus(
  parentTaskId: string,
  target: TaskStatus,
  childStatus: string,
  summary: string,
): Promise<boolean> {
  if (!["QUEUED", "ASSIGNED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(target)) {
    return false;
  }
  return tx(async (c) => {
    const row = (
      await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [parentTaskId])
    ).rows[0];
    if (!row) return false;
    const from = row.status as TaskStatus;
    if (isTerminal(from) || from === target) return false;
    assertTransition(from, target, "relay_sync");
    await c.query(
      `UPDATE tasks
          SET status = $2,
              result_summary = CASE WHEN $3 <> '' THEN $3 ELSE result_summary END,
              version = version + 1,
              updated_at = app_now()
        WHERE task_id = $1`,
      [parentTaskId, target, summary],
    );
    await appendEvent(c, {
      task_id: parentTaskId,
      event_type: `TASK_RELAY_${target}`,
      from_status: from,
      to_status: target,
      actor: "relay",
      payload: { child_status: childStatus, summary: summary || null },
    });
    return true;
  });
}

async function markRelay(
  parentTaskId: string,
  state: "DONE" | "CANCELLED" | "ERROR",
  childState?: string,
  childResult?: unknown,
): Promise<void> {
  await q(
    `UPDATE task_relays
        SET state = $2,
            child_state = COALESCE($3, child_state),
            child_result = COALESCE($4::jsonb, child_result),
            updated_at = app_now()
      WHERE parent_task_id = $1`,
    [
      parentTaskId,
      state,
      childState ?? null,
      childResult === undefined ? null : JSON.stringify(childResult),
    ],
  );
}

async function recordRelayFailure(parentTaskId: string, message: string): Promise<void> {
  await q(
    `UPDATE task_relays
        SET sync_failures = sync_failures + 1,
            last_error = $2,
            updated_at = app_now()
      WHERE parent_task_id = $1`,
    [parentTaskId, message.slice(0, 500)],
  );
}

async function sendChildCancel(row: RelayRow): Promise<void> {
  try {
    const res = await fetch(
      `${row.child_url.replace(/\/+$/, "")}/v1/tasks/${encodeURIComponent(row.child_task_id)}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "relay:operator" }),
        signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok && res.status !== 409) {
      throw new Error(`子结点取消返回 ${res.status}`);
    }
    await q(
      `UPDATE task_relays SET cancel_sent = TRUE, updated_at = app_now()
        WHERE parent_task_id = $1`,
      [row.parent_task_id],
    );
  } catch (e) {
    await recordRelayFailure(
      row.parent_task_id,
      `取消转发失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Called on cancel: once the parent is cancelled, the child must stop too. */
export async function requestRelayCancel(parentTaskId: string): Promise<void> {
  const row = await q1<RelayRow>(
    `SELECT r.*, t.status AS parent_status, t.cancel_requested_at
       FROM task_relays r JOIN tasks t ON t.task_id = r.parent_task_id
      WHERE r.parent_task_id = $1 AND r.state = 'ACTIVE'`,
    [parentTaskId],
  );
  if (row && !row.cancel_sent) await sendChildCancel(row);
}

/**
 * Periodic mirror: pull the child task for each ACTIVE relay and write its state/result back to the parent task.
 * When a child is unreachable, only count the error and leave the task as is: slower is better than duplicate execution.
 */
export async function syncRelays(limit = 50): Promise<{ checked: number; updated: number }> {
  const rows = await q<RelayRow>(
    `SELECT r.parent_task_id, r.child_node_id, r.child_url, r.child_task_id, r.state,
            r.cancel_sent, r.sync_failures,
            t.status AS parent_status, t.cancel_requested_at
       FROM task_relays r
       JOIN tasks t ON t.task_id = r.parent_task_id
      WHERE r.state = 'ACTIVE'
      ORDER BY r.updated_at
      LIMIT $1`,
    [limit],
  );

  let updated = 0;
  for (const row of rows) {
    if (isTerminal(row.parent_status)) {
      await markRelay(
        row.parent_task_id,
        row.parent_status === "CANCELLED" ? "CANCELLED" : "DONE",
      );
      continue;
    }
    if (row.cancel_requested_at && !row.cancel_sent) {
      await sendChildCancel(row);
    }

    let child: any;
    try {
      const res = await fetch(
        `${row.child_url.replace(/\/+$/, "")}/v1/tasks/${encodeURIComponent(row.child_task_id)}`,
        { signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS) },
      );
      if (!res.ok) throw new Error(`子结点返回 ${res.status}`);
      child = await res.json();
    } catch (e) {
      await recordRelayFailure(
        row.parent_task_id,
        e instanceof Error ? e.message : String(e),
      );
      continue;
    }

    const childStatus = String(child?.status ?? "").toUpperCase();
    const summary = childSummary(child);
    if (!childStatus) {
      await recordRelayFailure(row.parent_task_id, "子结点任务缺少 status");
      continue;
    }

    if (childStatus === "SUCCEEDED" || childStatus === "FAILED" || childStatus === "CANCELLED") {
      const terminal = childStatus as TaskStatus;
      const changed = await mirrorStatus(row.parent_task_id, terminal, childStatus, summary);
      if (changed) updated++;
      await markRelay(
        row.parent_task_id,
        terminal === "CANCELLED" ? "CANCELLED" : "DONE",
        childStatus,
        { summary, outputs: childOutputs(child) },
      );
      continue;
    }

    if (childStatus === "ASSIGNED" || childStatus === "RUNNING" || childStatus === "QUEUED") {
      if (await mirrorStatus(row.parent_task_id, childStatus as TaskStatus, childStatus, summary)) {
        updated++;
      }
    }
  }
  return { checked: rows.length, updated };
}

/** For getTask display: which node the task was pushed down to. */
export async function relayInfo(taskId: string): Promise<Record<string, any> | null> {
  return q1(
    `SELECT child_node_id, child_url, child_task_id, state, child_state,
            child_result, sync_failures, last_error, created_at, updated_at
       FROM task_relays WHERE parent_task_id = $1`,
    [taskId],
  );
}

export async function relayCounts(): Promise<{ active: number; errors: number }> {
  const row = await q1<{ active: number; errors: number }>(
    `SELECT count(*) FILTER (WHERE state = 'ACTIVE')::int AS active,
            count(*) FILTER (WHERE state = 'ACTIVE' AND sync_failures > 0)::int AS errors
       FROM task_relays`,
  );
  return { active: Number(row?.active ?? 0), errors: Number(row?.errors ?? 0) };
}
