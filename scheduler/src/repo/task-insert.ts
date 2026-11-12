import type { Client } from "../db.js";
import { ApiError } from "../errors.js";
import { appendEvent } from "../events.js";
import { newId } from "../ids.js";
import { normalizeDifficulty } from "../capability.js";

/**
 * 任务写入的最小单元。
 *
 * 单独成文件是为了打破循环依赖：任务仓储要用工作流推进，工作流推进又要建任务。
 * 这里只依赖 db / errors / events / ids，工作流和任务仓储都可以引用它。
 */
export interface CreateTaskInput {
  task_type: string;
  priority_class?: 0 | 1 | 2 | 3;
  payload_ref?: string;
  payload_sha256?: string;
  payload_schema?: string;
  requirements?: {
    capabilities?: string[];
    host_constraints?: Record<string, unknown>;
    /** 工作流交接：上游已校验制品的引用（只读授权凭据） */
    upstream_artifacts?: unknown[];
    [k: string]: unknown;
  };
  resource_profile_id?: string;
  /** 任务难度 0–1000；0 表示不限制，只有 W >= D 的构建机可领取 */
  difficulty?: number;
  workflow_run_id?: string;
  parent_task_id?: string;
  max_attempts?: number;
  deadline_at?: string;
  trace_id?: string;
  /** 上游调度机中继过来时带上的标记；普通提交没有这个字段。 */
  relay?: {
    parent_task_id: string;
    parent_node_id?: string;
    depth?: number;
  };
}

/** 在调用方事务内创建任务：工作流推进要用同一个事务把“上一阶段成功 + 下一阶段入队”一起提交 */
export async function insertTask(c: Client, input: CreateTaskInput) {
  if (!input.task_type) throw new ApiError(400, "BAD_REQUEST", "task_type 必填");

  const def = await c.query(`SELECT * FROM task_definitions WHERE task_type = $1`, [
    input.task_type,
  ]);
  const d = def.rows[0];
  if (!d) throw new ApiError(422, "TASK_TYPE_UNKNOWN", `未定义的任务类型: ${input.task_type}`);

  const profile = input.resource_profile_id ?? d.default_profile;
  if (!profile) throw new ApiError(422, "PROFILE_UNKNOWN", "缺少资源画像");

  const taskId = newId("task");
  const priority = input.priority_class ?? 1;
  const difficulty = normalizeDifficulty(input.difficulty);
  const relayParent = input.relay?.parent_task_id?.trim() || null;
  const relayDepth = relayParent ? Math.max(0, Math.min(64, Number(input.relay?.depth) || 0)) : 0;

  // 上游重试投递时可能重复到达：同一个上游任务只落一条本地任务。
  if (relayParent) {
    const existing = await c.query(`SELECT * FROM tasks WHERE relay_parent_task_id = $1`, [
      relayParent,
    ]);
    if (existing.rows[0]) return existing.rows[0];
  }

  const res = await c.query(
    `INSERT INTO tasks (task_id, task_type, task_version, workflow_run_id, parent_task_id,
                        priority_class, status, payload_ref, payload_sha256, payload_schema,
                        requirements, resource_profile_id, max_attempts, difficulty, enqueued_at,
                        deadline_at, created_at, updated_at, relay_parent_task_id, relay_depth)
     VALUES ($1,$2,$3,$4,$5,$6,'QUEUED',$7,$8,$9,$10,$11,$12,$13, app_now(), $14, app_now(), app_now(), $15, $16)
     ON CONFLICT (relay_parent_task_id) WHERE relay_parent_task_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      taskId,
      input.task_type,
      d.task_version,
      input.workflow_run_id ?? null,
      input.parent_task_id ?? null,
      priority,
      input.payload_ref ?? null,
      input.payload_sha256 ?? null,
      input.payload_schema ?? "1.0",
      JSON.stringify(input.requirements ?? {}),
      profile,
      input.max_attempts ?? d.max_attempts ?? 3,
      difficulty,
      input.deadline_at ? new Date(input.deadline_at) : null,
      relayParent,
      relayDepth,
    ],
  );

  // 并发重复投递：另一个事务先插入了同一条上游任务，直接返回它。
  if (!res.rows[0]) {
    const existing = await c.query(`SELECT * FROM tasks WHERE relay_parent_task_id = $1`, [
      relayParent,
    ]);
    return existing.rows[0];
  }

  await appendEvent(c, {
    task_id: taskId,
    event_type: "TASK_CREATED",
    to_status: "QUEUED",
    actor: relayParent ? "relay" : "api",
    payload: {
      task_type: input.task_type,
      priority_class: priority,
      difficulty,
      ...(relayParent
        ? { relay_parent_task_id: relayParent, parent_node_id: input.relay?.parent_node_id ?? null }
        : {}),
    },
    trace_id: input.trace_id,
  });

  return res.rows[0];
}
