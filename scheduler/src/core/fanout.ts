import { tx, type Client } from "../db.js";
import { ApiError } from "../errors.js";
import { appendEvent } from "../events.js";
import { insertTask } from "../repo/task-insert.js";
import { closeActiveLease } from "./lease.js";
import { assertTransition, type TaskStatus } from "../statemachine.js";
import type { LeaseProof } from "./attempts.js";

/**
 * Task fan-out.
 *
 * One task may hand its work to several child tasks that different builders run in parallel.
 * The parent does not poll: it parks in WAITING_CHILDREN, its lease is released, and it is
 * requeued when the last child reaches a terminal state, carrying every child's result and
 * verified artifacts. The resumed parent decides whether the combined outcome is good enough,
 * may split again, or reports the final result itself.
 *
 * Bounds are the point of this module. An agent that keeps splitting would otherwise create an
 * unbounded tree: children per split, tree depth and total resumes are all capped here.
 */

/** A child request as declared by the parent agent in its result file / result notification. */
export interface SplitChild {
  task_type?: string;
  title?: string;
  instruction?: string;
  requirements?: Record<string, unknown>;
  difficulty?: number;
  priority_class?: 0 | 1 | 2 | 3;
  max_attempts?: number;
  /** Parent artifacts the child needs to read; ids are resolved against this task's artifacts. */
  artifact_ids?: string[];
}

interface Config {
  max_fanout_children: number;
  max_fanout_depth: number;
  max_resume_rounds: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

async function loadConfig(c: Client): Promise<Config> {
  const row = (await c.query(`SELECT * FROM scheduler_config WHERE id = TRUE`)).rows[0] ?? {};
  return {
    max_fanout_children: Number(row.max_fanout_children) || 16,
    max_fanout_depth: Number(row.max_fanout_depth) || 4,
    max_resume_rounds: Number(row.max_resume_rounds) || 8,
  };
}

/**
 * Split a RUNNING task the caller's lease owns.
 *
 * Everything happens in one transaction: children are enqueued, the parent is parked, its lease
 * and resource reservation are released, and one event records the child ids. Either the whole
 * split exists or none of it does.
 */
export async function splitTask(taskId: string, proof: LeaseProof, children: SplitChild[]) {
  if (!Array.isArray(children) || children.length === 0) {
    throw new ApiError(422, "SPLIT_INVALID", "split requires at least one child");
  }

  return tx(async (c) => {
    const cfg = await loadConfig(c);
    if (children.length > cfg.max_fanout_children) {
      throw new ApiError(
        422,
        "SPLIT_TOO_WIDE",
        `split requested ${children.length} children; the limit is ${cfg.max_fanout_children}`,
      );
    }

    const task = (
      await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [taskId])
    ).rows[0];
    if (!task) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
    if (task.status !== "RUNNING") {
      throw new ApiError(409, "STATE_CONFLICT", `task is ${task.status}; only a RUNNING task can be split`);
    }

    const attempt = (
      await c.query(`SELECT * FROM task_attempts WHERE attempt_id = $1 FOR UPDATE`, [
        task.current_attempt_id,
      ])
    ).rows[0];
    const lease = (
      await c.query(`SELECT * FROM leases WHERE attempt_id = $1 AND released_at IS NULL FOR UPDATE`, [
        attempt?.attempt_id,
      ])
    ).rows[0];
    if (!attempt || !lease) {
      throw new ApiError(409, "LEASE_EXPIRED", "the attempt has no active lease; cannot split");
    }
    if (Number(lease.fencing_token) !== Number(proof.fencing_token)) {
      throw new ApiError(409, "FENCING_STALE", "fencing_token is stale; split rejected");
    }
    if (lease.lease_token !== proof.lease_token) {
      throw new ApiError(409, "LEASE_MISMATCH", "lease_token does not match the current attempt");
    }
    if (proof.auth_instance_id && proof.auth_instance_id !== lease.instance_id) {
      throw new ApiError(403, "ROLE_NOT_ALLOWED", "instance tokens cannot split attempts of other instances");
    }
    const now = (await c.query(`SELECT app_now() AS t`)).rows[0].t as Date;
    if (new Date(lease.expires_at).getTime() <= now.getTime()) {
      throw new ApiError(409, "LEASE_EXPIRED", "the lease has expired; cannot split");
    }

    if (Number(task.fanout_depth) + 1 > cfg.max_fanout_depth) {
      throw new ApiError(422, "SPLIT_TOO_DEEP", `fan-out depth limit (${cfg.max_fanout_depth}) reached`);
    }
    if (Number(task.fanout_rounds) + 1 > cfg.max_resume_rounds) {
      throw new ApiError(422, "SPLIT_TOO_MANY", `task already split ${task.fanout_rounds} times`);
    }

    const parentReq = isObject(task.requirements) ? task.requirements : {};
    const parentBuild = isObject(parentReq.build) ? parentReq.build : {};
    const attachments = Array.isArray(parentBuild.attachments) ? parentBuild.attachments : [];

    // Children may read artifacts the parent already produced; they cannot name artifacts of
    // other tasks, so the authorization list stays scoped to what this split actually owns.
    const requestedArtifacts = children.flatMap((ch) =>
      Array.isArray(ch.artifact_ids) ? ch.artifact_ids.map(String) : [],
    );
    const allowedArtifacts = requestedArtifacts.length
      ? (
          await c.query(
            `SELECT artifact_id, actual_sha256, media_type FROM artifacts
              WHERE task_id = $1 AND status = 'COMPLETE' AND artifact_id = ANY($2::text[])`,
            [taskId, requestedArtifacts],
          )
        ).rows
      : [];
    const inheritedUpstream = Array.isArray(parentReq.upstream_artifacts)
      ? (parentReq.upstream_artifacts as unknown[])
      : [];

    const created: string[] = [];
    for (let index = 0; index < children.length; index++) {
      const child = (children[index] ?? {}) as SplitChild;
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        throw new ApiError(422, "SPLIT_INVALID", `child ${index} is not an object`);
      }
      const childType = String(child.task_type ?? task.task_type);
      const childReq: Record<string, unknown> = { ...(isObject(child.requirements) ? child.requirements : {}) };
      const childBuild: Record<string, unknown> = isObject(childReq.build) ? { ...childReq.build } : {};
      if (typeof child.title === "string" && child.title.trim()) childBuild.title = child.title.trim();
      else if (typeof parentBuild.title === "string" && !childBuild.title) childBuild.title = parentBuild.title;
      if (typeof child.instruction === "string" && child.instruction.trim()) {
        childBuild.instruction = child.instruction.trim();
      } else if (!childBuild.instruction) {
        throw new ApiError(422, "SPLIT_INVALID", `child ${index} has no instruction`);
      }
      // Attachments are content refs (one-time URLs), not file bodies: sharing them is cheap and
      // usually required, while the rest of the parent's requirements may describe the whole job.
      if (!Array.isArray(childBuild.attachments) && attachments.length) {
        childBuild.attachments = attachments;
      }
      childReq.build = childBuild;
      childReq.fanout = { parent_task_id: taskId, index, total: children.length };

      const childArtifacts = child.artifact_ids?.length
        ? [
            ...inheritedUpstream,
            ...allowedArtifacts
              .filter((a: any) => child.artifact_ids!.map(String).includes(a.artifact_id))
              .map((a: any) => ({
                artifact_id: a.artifact_id,
                sha256: a.actual_sha256,
                media_type: a.media_type,
                task_id: taskId,
                task_type: task.task_type,
              })),
          ]
        : inheritedUpstream;
      if (childArtifacts.length) childReq.upstream_artifacts = childArtifacts;

      const row = await insertTask(c, {
        task_type: childType,
        parent_task_id: taskId,
        fanout_id: taskId,
        fanout_depth: Number(task.fanout_depth) + 1,
        priority_class: (child.priority_class ?? task.priority_class) as 0 | 1 | 2 | 3,
        payload_ref: task.payload_ref ?? undefined,
        payload_sha256: task.payload_sha256 ?? undefined,
        payload_schema: task.payload_schema ?? "1.0",
        requirements: childReq,
        approval_mode: task.approval_mode,
        difficulty: child.difficulty,
        max_attempts: child.max_attempts,
        deadline_at: task.deadline_at ? new Date(task.deadline_at).toISOString() : undefined,
        trace_id: task.trace_id ?? undefined,
      });
      created.push(row.task_id);
    }

    await c.query(
      `UPDATE task_attempts
          SET status = 'PARKED', park_reason = 'SPLIT', parked_at = app_now(),
              result_summary = $2
        WHERE attempt_id = $1`,
      [attempt.attempt_id, `split into ${created.length} child task(s)`],
    );
    await closeActiveLease(c, taskId, "TASK_SPLIT", "RELEASED");

    const updated = await c.query(
      `UPDATE tasks
          SET status = 'WAITING_CHILDREN', current_attempt_id = NULL,
              fanout_rounds = fanout_rounds + 1,
              version = version + 1, updated_at = app_now()
        WHERE task_id = $1 RETURNING *`,
      [taskId],
    );
    await appendEvent(c, {
      task_id: taskId,
      event_type: "TASK_SPLIT",
      from_status: "RUNNING",
      to_status: "WAITING_CHILDREN",
      actor: lease.instance_id,
      payload: { attempt_id: attempt.attempt_id, child_ids: created, depth: Number(task.fanout_depth) + 1 },
    });

    return { task: updated.rows[0], children: created };
  });
}

interface SiblingResult {
  task_id: string;
  status: TaskStatus;
  outcome: string | null;
  summary: string | null;
}

/**
 * Called from the same transaction that made a child terminal. If this was the last sibling,
 * the parent is requeued with every sibling's result and every verified artifact.
 *
 * A failed child does not fail the parent automatically: the parent agent is resumed with the
 * failure and decides (rework, partial delivery, or an explicit failure).
 */
export async function settleFanout(c: Client, child: { task_id: string; fanout_id?: string | null }) {
  const parentId = child.fanout_id;
  if (!parentId) return null;

  const siblings = (
    await c.query(
      `SELECT t.task_id, t.status, t.outcome, a.result_summary AS summary
         FROM tasks t
         LEFT JOIN LATERAL (
           SELECT result_summary FROM task_attempts
            WHERE task_id = t.task_id ORDER BY attempt_number DESC LIMIT 1
         ) a ON TRUE
        WHERE t.fanout_id = $1
        ORDER BY t.created_at, t.task_id`,
      [parentId],
    )
  ).rows as SiblingResult[];
  if (siblings.some((s) => !["SUCCEEDED", "FAILED", "CANCELLED"].includes(s.status))) return null;

  const parent = (
    await c.query(`SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE`, [parentId])
  ).rows[0];
  if (!parent || parent.status !== "WAITING_CHILDREN") return null;

  const cfg = await loadConfig(c);
  const summaries = siblings.map((s) => ({
    task_id: s.task_id,
    status: s.status,
    outcome: s.outcome,
    summary: s.summary ? String(s.summary).slice(0, 500) : null,
  }));

  if (Number(parent.resume_rounds) >= cfg.max_resume_rounds) {
    await c.query(
      `UPDATE tasks
          SET status = 'FAILED', current_attempt_id = NULL, dead_letter = TRUE, outcome = 'children_exhausted',
              version = version + 1, updated_at = app_now()
        WHERE task_id = $1`,
      [parentId],
    );
    await appendEvent(c, {
      task_id: parentId,
      event_type: "TASK_DEAD_LETTERED",
      from_status: "WAITING_CHILDREN",
      to_status: "FAILED",
      actor: "scheduler",
      payload: { outcome: "children_exhausted", resume_rounds: Number(parent.resume_rounds), children: summaries },
    });
    return parentId;
  }

  const artifacts = (
    await c.query(
      `SELECT artifact_id, actual_sha256, media_type, task_id, task_type
         FROM artifacts a JOIN tasks t USING (task_id)
        WHERE a.task_id = ANY($1::text[]) AND a.status = 'COMPLETE'
        ORDER BY a.completed_at DESC, a.artifact_id DESC
        LIMIT 100`,
      [siblings.map((s) => s.task_id)],
    )
  ).rows;

  const req = isObject(parent.requirements) ? parent.requirements : {};
  const inherited = Array.isArray(req.upstream_artifacts) ? (req.upstream_artifacts as any[]) : [];
  const refs = [
    ...inherited,
    ...artifacts.map((a: any) => ({
      artifact_id: a.artifact_id,
      sha256: a.actual_sha256,
      media_type: a.media_type,
      task_id: a.task_id,
      task_type: a.task_type,
    })),
  ].filter((v, i, all) => all.findIndex((x) => x.artifact_id === v.artifact_id) === i);
  const requirements = {
    ...req,
    fanout_results: summaries,
    ...(refs.length ? { upstream_artifacts: refs } : {}),
  };

  assertTransition(parent.status as TaskStatus, "QUEUED", "children_settled");
  const updated = await c.query(
    `UPDATE tasks
        SET status = 'QUEUED', current_attempt_id = NULL,
            requirements = $2,
            attempt_count = GREATEST(0, attempt_count - 1),
            resume_rounds = resume_rounds + 1,
            pending_question = NULL, needs_input_at = NULL, needs_input_expires_at = NULL,
            next_attempt_at = NULL, enqueued_at = app_now(),
            version = version + 1, updated_at = app_now()
      WHERE task_id = $1 RETURNING *`,
    [parentId, JSON.stringify(requirements)],
  );
  await appendEvent(c, {
    task_id: parentId,
    event_type: "TASK_CHILDREN_SETTLED",
    from_status: "WAITING_CHILDREN",
    to_status: "QUEUED",
    actor: "scheduler",
    payload: {
      children: summaries,
      artifacts: refs.slice(-50).map((r) => r.artifact_id),
      resume_rounds: Number(parent.resume_rounds) + 1,
    },
  });
  return updated.rows[0]?.task_id ?? parentId;
}

/**
 * Cancel every non-terminal descendant of a parent task.
 *
 * The parent is already terminal when this runs, so settling a descendant cannot resume it.
 * Depth is bounded by the fan-out depth limit enforced at split time.
 */
export async function cancelFanoutChildren(c: Client, parentId: string, actor: string): Promise<string[]> {
  const cancelled: string[] = [];
  const rows = (
    await c.query(
      `SELECT task_id, status FROM tasks
        WHERE fanout_id = $1 AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED')
        FOR UPDATE`,
      [parentId],
    )
  ).rows;
  for (const row of rows) {
    await closeActiveLease(c, row.task_id, "PARENT_CANCELLED", "RELEASED");
    await c.query(
      `UPDATE task_attempts
          SET status = CASE WHEN status IN ('SUCCEEDED','FAILED','CANCELLED','TIMEOUT','PARKED')
                            THEN status ELSE 'CANCELLED' END,
              finished_at = COALESCE(finished_at, app_now())
        WHERE task_id = $1`,
      [row.task_id],
    );
    await c.query(
      `UPDATE tasks SET status = 'CANCELLED', current_attempt_id = NULL,
                        pending_question = NULL, needs_input_at = NULL, needs_input_expires_at = NULL,
                        version = version + 1, updated_at = app_now()
        WHERE task_id = $1`,
      [row.task_id],
    );
    await appendEvent(c, {
      task_id: row.task_id,
      event_type: "TASK_CANCELLED",
      from_status: row.status,
      to_status: "CANCELLED",
      actor,
      payload: { reason: "PARENT_CANCELLED", parent_task_id: parentId },
    });
    cancelled.push(row.task_id);
    cancelled.push(...(await cancelFanoutChildren(c, row.task_id, actor)));
  }
  return cancelled;
}
