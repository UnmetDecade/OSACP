import { q, q1, tx, type Client } from "../db.js";
import { ApiError } from "../errors.js";
import { newId } from "../ids.js";
import { insertTask, type CreateTaskInput } from "./task-insert.js";

/**
 * Threads are an index over tasks and messages, not an execution unit.
 *
 * A thread owns tasks (owner / followup / context) and a linear message log. Posting a message
 * creates a follow-up task that inherits the previous task's target, profile and autonomy, so a
 * conversation continues without resubmitting the whole configuration. Subscriptions keep a
 * cursor into the outbox; polling returns only events for tasks linked to the thread.
 */

interface ThreadRow {
  thread_id: string;
  title: string | null;
  source: string;
  created_by: string | null;
  status: "OPEN" | "ARCHIVED";
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ThreadMessageInput {
  body: string;
  actor?: string;
  role?: "user" | "agent" | "system";
  title?: string;
  /** Skip task creation when false; a message is then only a note in the log. */
  create_task?: boolean;
  task_type?: string;
  target_instance_id?: string;
  approval_mode?: CreateTaskInput["approval_mode"];
  requirements?: Record<string, unknown>;
}

function requireText(value: unknown, field: string, max = 16000): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ApiError(422, "BAD_REQUEST", `${field} must not be empty`);
  return text.slice(0, max);
}

function firstLine(text: string, max = 120): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.slice(0, max) || text.slice(0, max);
}

async function requireThread(c: Client, threadId: string): Promise<ThreadRow> {
  const row = (await c.query(`SELECT * FROM threads WHERE thread_id = $1`, [threadId]))
    .rows[0] as ThreadRow | undefined;
  if (!row) throw new ApiError(404, "NOT_FOUND", `thread not found: ${threadId}`);
  return row;
}

export async function createThread(input: {
  title?: string;
  source?: string;
  created_by?: string;
  task_id?: string;
  metadata?: Record<string, unknown>;
}) {
  return tx(async (c) => {
    const threadId = newId("thr");
    const row = (
      await c.query(
        `INSERT INTO threads (thread_id, title, source, created_by, metadata)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          threadId,
          input.title?.trim().slice(0, 200) || null,
          input.source?.trim().slice(0, 40) || "api",
          input.created_by?.trim().slice(0, 80) || null,
          JSON.stringify(input.metadata ?? {}),
        ],
      )
    ).rows[0];
    if (input.task_id) {
      const exists = await c.query(`SELECT 1 FROM tasks WHERE task_id = $1`, [input.task_id]);
      if (!exists.rowCount) throw new ApiError(404, "NOT_FOUND", `task not found: ${input.task_id}`);
      await c.query(
        `INSERT INTO thread_tasks (thread_id, task_id, relation) VALUES ($1, $2, 'owner')
         ON CONFLICT DO NOTHING`,
        [threadId, input.task_id],
      );
    }
    return row as ThreadRow;
  });
}

export async function listThreads(limit = 50) {
  return q(
    `SELECT th.*,
            (SELECT count(*) FROM thread_tasks tt WHERE tt.thread_id = th.thread_id) AS task_count,
            (SELECT max(tt.created_at) FROM thread_tasks tt WHERE tt.thread_id = th.thread_id) AS last_task_at
       FROM threads th
      ORDER BY th.updated_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
}

export async function getThread(threadId: string) {
  const thread = await q1<ThreadRow>(`SELECT * FROM threads WHERE thread_id = $1`, [threadId]);
  if (!thread) throw new ApiError(404, "NOT_FOUND", `thread not found: ${threadId}`);

  const tasks = await q(
    `SELECT t.task_id, t.task_type, t.status, t.outcome, t.created_at, t.updated_at,
            tt.relation,
            t.requirements->'build'->>'title' AS title,
            CASE
              WHEN t.status = 'NEEDS_INPUT' THEN 'answer'
              WHEN t.status = 'BLOCKED' THEN 'blocked'
              WHEN t.status = 'WAITING_CHILDREN' THEN 'waiting'
              WHEN wr.status = 'WAITING_APPROVAL' THEN 'review'
              ELSE 'none'
            END AS attention
       FROM thread_tasks tt
       JOIN tasks t ON t.task_id = tt.task_id
       LEFT JOIN workflow_runs wr ON wr.workflow_run_id = t.workflow_run_id
      WHERE tt.thread_id = $1
      ORDER BY tt.created_at, t.task_id`,
    [threadId],
  );
  const messages = await q(
    `SELECT message_id, role, actor, body, task_id, created_at
       FROM thread_messages WHERE thread_id = $1 ORDER BY created_at, message_id`,
    [threadId],
  );
  const subscriptions = await q(
    `SELECT subscription_id, subscriber, kind, cursor, created_at, last_seen_at
       FROM thread_subscriptions WHERE thread_id = $1 ORDER BY created_at`,
    [threadId],
  );
  return { ...thread, tasks, messages, subscriptions };
}

export async function attachThreadTask(threadId: string, taskId: string, relation = "owner") {
  const thread = await q1(`SELECT 1 FROM threads WHERE thread_id = $1`, [threadId]);
  if (!thread) throw new ApiError(404, "NOT_FOUND", `thread not found: ${threadId}`);
  const task = await q1(`SELECT 1 FROM tasks WHERE task_id = $1`, [taskId]);
  if (!task) throw new ApiError(404, "NOT_FOUND", `task not found: ${taskId}`);
  await q(
    `INSERT INTO thread_tasks (thread_id, task_id, relation) VALUES ($1, $2, $3)
     ON CONFLICT (thread_id, task_id) DO UPDATE SET relation = EXCLUDED.relation`,
    [threadId, taskId, relation],
  );
  await q(`UPDATE threads SET updated_at = now() WHERE thread_id = $1`, [threadId]);
  return { thread_id: threadId, task_id: taskId, relation };
}

interface BaseTask {
  task_id: string;
  task_type: string;
  priority_class: NonNullable<CreateTaskInput["priority_class"]>;
  difficulty: number | null;
  approval_mode: CreateTaskInput["approval_mode"];
  resource_profile_id: string;
  max_attempts: number;
  requirements: Record<string, unknown>;
}

/**
 * The follow-up task inherits the target and resource configuration of the latest builder task
 * in the thread, but not its transient runtime state: answers, mandates, attachments and upstream
 * artifact references stay with the task that produced them.
 */
function followUpInput(
  base: BaseTask,
  input: ThreadMessageInput,
  threadId: string,
  messageId: string,
): CreateTaskInput {
  const text = requireText(input.body, "body");
  const baseReq = (base.requirements && typeof base.requirements === "object" ? base.requirements : {}) as Record<
    string,
    unknown
  >;
  const targetInstanceId =
    input.target_instance_id ?? (typeof baseReq.target_instance_id === "string" ? baseReq.target_instance_id : undefined);
  const taskType = input.task_type ?? (base.task_type.startsWith("task.chat.") ? base.task_type : "task.build");
  const requirements: Record<string, unknown> = {
    ...(targetInstanceId ? { target_instance_id: targetInstanceId } : {}),
    thread: { thread_id: threadId, message_id: messageId, previous_task_id: base.task_id },
    ...(input.requirements ?? {}),
  };
  if (taskType.startsWith("task.chat.")) {
    requirements.chat = { message: text };
  } else {
    requirements.build = { title: input.title?.trim().slice(0, 200) || firstLine(text), instruction: text };
  }
  return {
    task_type: taskType,
    priority_class: base.priority_class,
    difficulty: base.difficulty ?? 0,
    approval_mode: input.approval_mode ?? base.approval_mode,
    resource_profile_id: base.resource_profile_id,
    max_attempts: base.max_attempts,
    requirements,
    trace_id: `thread_${threadId}`,
  };
}

/**
 * Append a message and, unless the caller opts out, create the continuation task in the same
 * transaction: the message row and its task are either both visible or both rolled back.
 */
export async function addThreadMessage(threadId: string, input: ThreadMessageInput) {
  const text = requireText(input.body, "body");
  return tx(async (c) => {
    const thread = await requireThread(c, threadId);

    const base = (
      await c.query(
        `SELECT t.task_id, t.task_type, t.priority_class, t.difficulty, t.approval_mode,
                t.resource_profile_id, t.max_attempts, t.requirements
           FROM thread_tasks tt
           JOIN tasks t ON t.task_id = tt.task_id
          WHERE tt.thread_id = $1
            AND t.task_type NOT LIKE 'task.console.%'
            AND t.task_type NOT LIKE 'task.chat.scheduler'
          ORDER BY tt.created_at DESC, t.created_at DESC
          LIMIT 1`,
        [threadId],
      )
    ).rows[0] as BaseTask | undefined;

    const messageId = newId("tmsg");
    let task = null as Awaited<ReturnType<typeof insertTask>> | null;
    let followup: CreateTaskInput | null = null;
    if (input.create_task !== false && base) {
      followup = followUpInput(base, { ...input, body: text }, threadId, messageId);
      task = await insertTask(c, followup);
      await c.query(
        `INSERT INTO thread_tasks (thread_id, task_id, relation) VALUES ($1, $2, 'followup')
         ON CONFLICT DO NOTHING`,
        [threadId, task.task_id],
      );
    }

    const message = (
      await c.query(
        `INSERT INTO thread_messages (message_id, thread_id, role, actor, body, task_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          messageId,
          threadId,
          input.role ?? "user",
          input.actor?.trim().slice(0, 80) || null,
          text,
          task?.task_id ?? null,
        ],
      )
    ).rows[0];
    await c.query(`UPDATE threads SET updated_at = now() WHERE thread_id = $1`, [threadId]);
    return { thread: { ...thread, updated_at: new Date() }, message, task, followup };
  });
}

export async function subscribeThread(threadId: string, subscriber: string, kind: "poll" | "outbox" = "poll") {
  const who = requireText(subscriber, "subscriber", 80);
  const exists = await q1(`SELECT 1 FROM threads WHERE thread_id = $1`, [threadId]);
  if (!exists) throw new ApiError(404, "NOT_FOUND", `thread not found: ${threadId}`);
  const row = await q1(
    `INSERT INTO thread_subscriptions (subscription_id, thread_id, subscriber, kind)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (thread_id, subscriber) DO UPDATE SET kind = EXCLUDED.kind
     RETURNING *`,
    [newId("sub"), threadId, who, kind],
  );
  return row;
}

export async function unsubscribeThread(threadId: string, subscriptionId: string) {
  const row = await q1(
    `DELETE FROM thread_subscriptions WHERE subscription_id = $1 AND thread_id = $2 RETURNING *`,
    [subscriptionId, threadId],
  );
  if (!row) throw new ApiError(404, "NOT_FOUND", `subscription not found: ${subscriptionId}`);
  return row;
}

/**
 * Deliver the thread's outbox events after the subscription cursor (or an explicit `after`).
 * `ack` advances the stored cursor to the last delivered event, so the next poll starts after it.
 */
export async function pollSubscription(
  threadId: string,
  subscriptionId: string,
  opts: { after?: number; limit?: number; ack?: boolean } = {},
) {
  return tx(async (c) => {
    const sub = (
      await c.query(
        `SELECT * FROM thread_subscriptions WHERE subscription_id = $1 AND thread_id = $2 FOR UPDATE`,
        [subscriptionId, threadId],
      )
    ).rows[0];
    if (!sub) throw new ApiError(404, "NOT_FOUND", `subscription not found: ${subscriptionId}`);
    const after = Number.isFinite(opts.after) && Number(opts.after) >= 0 ? Number(opts.after) : Number(sub.cursor);
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
    const items = (
      await c.query(
        `SELECT o.*
           FROM outbox_events o
           JOIN thread_tasks tt ON tt.task_id = o.aggregate_id
          WHERE tt.thread_id = $1 AND o.event_id > $2
          ORDER BY o.event_id
          LIMIT $3`,
        [threadId, after, limit],
      )
    ).rows;
    const nextCursor = items.length ? Number(items[items.length - 1].event_id) : after;
    if (opts.ack && items.length) {
      await c.query(
        `UPDATE thread_subscriptions SET cursor = $2, last_seen_at = now() WHERE subscription_id = $1`,
        [subscriptionId, nextCursor],
      );
    } else {
      await c.query(`UPDATE thread_subscriptions SET last_seen_at = now() WHERE subscription_id = $1`, [
        subscriptionId,
      ]);
    }
    return { subscription_id: subscriptionId, after, next_cursor: nextCursor, items };
  });
}
