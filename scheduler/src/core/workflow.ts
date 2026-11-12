import { q, q1, tx, type Client } from "../db.js";
import { ApiError } from "../errors.js";
import { insertTask, type CreateTaskInput } from "../repo/task-insert.js";
import { newId } from "../ids.js";
import { requireApprovalConfigured } from "../auth.js";
import { verifyApprovalToken } from "../jwt.js";

/**
 * 工作流推进（§7）。
 *
 * 规则很窄，故意不灵活：
 *   - 阶段成功 → 同一事务里创建下一阶段任务，parent_task_id 指向上一阶段
 *   - APPROVE 阶段不创建任务，工作流停在 WAITING_APPROVAL，等审批 API
 *   - 任务不可重试失败 / 取消 → 工作流 FAILED / CANCELLED，不自动跳阶段
 *
 * 模板由 PCS 维护（workflow_templates），调度机只读，不在这里做业务判断。
 */

export interface Phase {
  phase: string;
  task_type?: string;
  required?: boolean | string;
  action_scope?: string[];
  /** APPROVE 阶段要求上一阶段有通过服务端校验的制品 */
  artifact_required?: boolean;
}

export interface CreateWorkflowInput {
  workflow_template_id: string;
  priority_class?: 0 | 1 | 2 | 3;
  payload_ref?: string;
  payload_sha256?: string;
  payload_schema?: string;
  /** 创建方只能提普通要求；交接/审批字段由 sanitizeRequirements 剥除 */
  requirements?: Record<string, unknown>;
  deadline_at?: string;
  trace_id?: string;
}

/**
 * 工作流创建方只能提要求（能力、主机约束），不能自带交接或审批字段。
 *
 * `upstream_artifacts` 是制品读取授权凭据，必须由工作流推进时按上一阶段
 * 实际产出的 COMPLETE 制品生成；审批字段同理，只由 decideApproval 写入。
 * 否则任何能建工作流的人都能给下游角色“授权”读别人的制品。
 */
function sanitizeRequirements(raw: unknown): Record<string, unknown> {
  const req = { ...((raw ?? {}) as Record<string, unknown>) };
  delete req.upstream_artifacts;
  delete req.upstream_artifact_id;
  delete req.upstream_sha256;
  delete req.approval_id;
  delete req.approval_subject_digest;
  delete req.approved_action_scope;
  return req;
}

/** 阶段 → 工作流状态 */
const PHASE_STATUS: Record<string, string> = {
  EXECUTE: "RUNNING",
  REVIEW: "WAITING_REVIEW",
  APPROVE: "WAITING_APPROVAL",
  COMMIT: "READY_FOR_COMMIT",
  VERIFY: "VERIFYING",
  DELIVER: "RUNNING",
};

async function loadTemplate(c: Client, templateId: string) {
  const row = (
    await c.query(`SELECT * FROM workflow_templates WHERE workflow_template_id = $1`, [templateId])
  ).rows[0];
  if (!row) {
    throw new ApiError(404, "WORKFLOW_TEMPLATE_UNKNOWN", `工作流模板不存在: ${templateId}`);
  }
  const phases = row.phases as Phase[];
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new ApiError(422, "WORKFLOW_TEMPLATE_INVALID", "模板没有 phases");
  }
  return { ...row, phases };
}

/** 工作流事件只进 outbox：管理应用靠它刷新流程视图 */
async function appendWorkflowEvent(
  c: Client,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await c.query(
    `INSERT INTO outbox_events
       (event_type, schema_version, aggregate_type, aggregate_id, payload)
     VALUES ($1, '1.0', 'workflow', $2, $3)`,
    [eventType, runId, JSON.stringify({ workflow_run_id: runId, ...payload })],
  );
}

export async function createWorkflowRun(input: CreateWorkflowInput) {
  if (!input.workflow_template_id) {
    throw new ApiError(400, "BAD_REQUEST", "workflow_template_id 必填");
  }

  return tx(async (c) => {
    const tpl = await loadTemplate(c, input.workflow_template_id);
    const first = tpl.phases[0];
    if (!first.task_type) {
      throw new ApiError(422, "WORKFLOW_TEMPLATE_INVALID", "第一个阶段必须有 task_type");
    }

    const runId = newId("wfr");
    const context = {
      priority_class: input.priority_class ?? 1,
      payload_ref: input.payload_ref ?? null,
      payload_sha256: input.payload_sha256 ?? null,
      payload_schema: input.payload_schema ?? "1.0",
      requirements: sanitizeRequirements(input.requirements),
      deadline_at: input.deadline_at ?? null,
    };

    await c.query(
      `INSERT INTO workflow_runs
         (workflow_run_id, workflow_template_id, template_version, status, context)
       VALUES ($1,$2,$3,'PENDING',$4)`,
      [runId, tpl.workflow_template_id, tpl.version, JSON.stringify(context)],
    );

    const task = await insertTask(c, {
      task_type: first.task_type,
      workflow_run_id: runId,
      priority_class: context.priority_class as 0 | 1 | 2 | 3,
      payload_ref: context.payload_ref ?? undefined,
      payload_sha256: context.payload_sha256 ?? undefined,
      payload_schema: context.payload_schema,
      requirements: context.requirements,
      deadline_at: context.deadline_at ?? undefined,
      trace_id: input.trace_id,
    });

    const run = (
      await c.query(
        `UPDATE workflow_runs
            SET status = $2, current_phase = $3, root_task_id = $4, current_task_id = $4,
                updated_at = app_now()
          WHERE workflow_run_id = $1
          RETURNING *`,
        [runId, PHASE_STATUS[first.phase] ?? "RUNNING", first.phase, task.task_id],
      )
    ).rows[0];

    await appendWorkflowEvent(c, runId, "WORKFLOW_CREATED", {
      phase: first.phase,
      task_id: task.task_id,
    });

    return { run, task };
  });
}

/**
 * 任务终结时推进工作流。必须在提交任务结果的同一个事务里调用，
 * 否则会出现“任务已成功、下一阶段没入队”的状态缺口。
 */
export async function advanceWorkflow(
  c: Client,
  task: any,
  outcome: "SUCCEEDED" | "FAILED" | "CANCELLED",
): Promise<void> {
  if (!task.workflow_run_id) return;

  const run = (
    await c.query(`SELECT * FROM workflow_runs WHERE workflow_run_id = $1 FOR UPDATE`, [
      task.workflow_run_id,
    ])
  ).rows[0];
  if (!run) return;

  // 迟到的旧阶段任务不能推着工作流往前走
  if (run.current_task_id && run.current_task_id !== task.task_id) return;

  if (outcome === "CANCELLED") {
    await finishRun(c, run, "CANCELLED", "TASK_CANCELLED");
    return;
  }
  if (outcome === "FAILED") {
    await finishRun(c, run, "FAILED", "WORKFLOW_FAILED");
    return;
  }

  const tpl = await loadTemplate(c, run.workflow_template_id);
  const idx = tpl.phases.findIndex((p: Phase) => p.phase === run.current_phase);
  if (idx < 0) {
    throw new ApiError(500, "WORKFLOW_STATE_INVALID", `当前阶段不在模板里: ${run.current_phase}`);
  }

  const next = tpl.phases[idx + 1];
  if (!next) {
    await finishRun(c, run, "COMPLETED", "WORKFLOW_COMPLETED");
    return;
  }

  if (next.phase === "APPROVE") {
    await enterApproval(c, run, task, tpl, next);
    return;
  }

  const nextTask = await insertNextTask(c, run, task, next);
  await c.query(
    `UPDATE workflow_runs
        SET status = $2, current_phase = $3, current_task_id = $4, updated_at = app_now()
      WHERE workflow_run_id = $1`,
    [run.workflow_run_id, PHASE_STATUS[next.phase] ?? "RUNNING", next.phase, nextTask.task_id],
  );
  await appendWorkflowEvent(c, run.workflow_run_id, "WORKFLOW_PHASE_STARTED", {
    phase: next.phase,
    task_id: nextTask.task_id,
    parent_task_id: task.task_id,
  });
}

async function finishRun(c: Client, run: any, status: string, eventType: string) {
  await c.query(
    `UPDATE workflow_runs
        SET status = $2, current_task_id = NULL, updated_at = app_now()
      WHERE workflow_run_id = $1`,
    [run.workflow_run_id, status],
  );
  await appendWorkflowEvent(c, run.workflow_run_id, eventType, {
    phase: run.current_phase,
  });
}

/**
 * 建下一阶段任务。
 *
 * 交接只走 requirements：把上一阶段**已通过服务端校验**的制品累积成
 * `upstream_artifacts`，下游角色凭这个列表才能下载对应制品（调度机按它授权）。
 * 制品本体不复制、不进载荷。
 */
async function insertNextTask(
  c: Client,
  run: any,
  prev: any,
  phase: Phase,
  extra: Record<string, unknown> = {},
) {
  const ctx = run.context ?? {};
  const artifacts = (
    await c.query(
      `SELECT artifact_id, actual_sha256, media_type
         FROM artifacts
        WHERE task_id = $1 AND status = 'COMPLETE'
        ORDER BY completed_at DESC, artifact_id DESC`,
      [prev.task_id],
    )
  ).rows;

  const prevReq = (prev.requirements ?? {}) as Record<string, unknown>;
  const inherited = Array.isArray(prevReq.upstream_artifacts)
    ? (prevReq.upstream_artifacts as any[])
    : [];
  const refs = [
    ...inherited,
    ...artifacts.map((a: any) => ({
      artifact_id: a.artifact_id,
      sha256: a.actual_sha256,
      media_type: a.media_type,
      task_id: prev.task_id,
      task_type: prev.task_type,
    })),
  ]
    .filter((v, i, all) => all.findIndex((x) => x.artifact_id === v.artifact_id) === i)
    .slice(-50);

  const requirements: Record<string, unknown> = {
    ...(ctx.requirements ?? {}),
    ...prevReq,
    ...(refs.length
      ? {
          upstream_artifacts: refs,
          upstream_artifact_id: artifacts[0]?.artifact_id,
          upstream_sha256: artifacts[0]?.actual_sha256,
        }
      : {}),
    ...extra,
  };

  const input: CreateTaskInput = {
    task_type: phase.task_type!,
    workflow_run_id: run.workflow_run_id,
    parent_task_id: prev.task_id,
    priority_class: ctx.priority_class ?? prev.priority_class,
    payload_ref: ctx.payload_ref ?? prev.payload_ref ?? undefined,
    payload_sha256: ctx.payload_sha256 ?? prev.payload_sha256 ?? undefined,
    payload_schema: ctx.payload_schema ?? prev.payload_schema ?? "1.0",
    requirements,
    deadline_at: ctx.deadline_at ?? undefined,
  };
  return insertTask(c, input);
}

/**
 * 进入审批门。审批对象绑定上一阶段任务的输出摘要：
 * 受控提交前要重新计算并与这里存下的摘要比对（§7.3）。
 */
async function enterApproval(c: Client, run: any, prev: any, tpl: any, phase: Phase) {
  // 摘要优先取服务端校验过的制品；执行器上报的 outputs 只在没有制品时兜底。
  const artifact = (
    await c.query(
      `SELECT actual_sha256 FROM artifacts
        WHERE task_id = $1 AND status = 'COMPLETE'
        ORDER BY completed_at DESC, artifact_id DESC LIMIT 1`,
      [prev.task_id],
    )
  ).rows[0];

  if (phase.artifact_required && !artifact) {
    throw new ApiError(409, "ARTIFACT_REQUIRED", "该审批阶段要求上一阶段上传并通过校验的制品");
  }

  const attempt = (
    await c.query(
      `SELECT outputs FROM task_attempts
        WHERE task_id = $1 AND status = 'SUCCEEDED'
        ORDER BY attempt_number DESC LIMIT 1`,
      [prev.task_id],
    )
  ).rows[0];
  const outputs = attempt?.outputs;
  const subjectDigest =
    artifact?.actual_sha256 ??
    (outputs && typeof outputs === "object" && outputs.subject_digest) ??
    (outputs && typeof outputs === "object" && outputs.sha256) ??
    prev.payload_sha256 ??
    null;

  await c.query(
    `UPDATE workflow_runs
        SET status = 'WAITING_APPROVAL', current_phase = $2, updated_at = app_now()
      WHERE workflow_run_id = $1`,
    [run.workflow_run_id, phase.phase],
  );

  await c.query(
    `INSERT INTO approval_requests
       (approval_request_id, workflow_run_id, task_id, status, subject_digest,
        action_scope, policy_version)
     VALUES ($1,$2,$3,'PENDING',$4,$5,$6)`,
    [
      newId("aprq"),
      run.workflow_run_id,
      prev.task_id,
      subjectDigest,
      phase.action_scope ?? [],
      tpl.approval_policy_ref ?? null,
    ],
  );

  await appendWorkflowEvent(c, run.workflow_run_id, "WORKFLOW_WAITING_APPROVAL", {
    task_id: prev.task_id,
    subject_digest: subjectDigest,
  });
}

// ---------------------------------------------------------------- 审批（§7.3）

export interface ApprovalDecisionInput {
  task_id: string;
  decision: "APPROVED" | "REJECTED";
  operator_id: string;
  /** PCS 签发的审批 JWT；权限、对象摘要、操作范围都从令牌里取，不信任请求体 */
  approval_token: string;
  comment?: string;
  /** 可选：调用方回显摘要；与令牌不一致直接拒绝 */
  subject_digest?: string;
  action_scope?: string[];
  policy_version?: string;
}

/**
 * 记录人工审批决定。
 *
 * 安全边界：
 *   - 凭据是 PCS 签发的审批 JWT：验签、有效期、`typ=approval`、`approval:decide` scope；
 *     未配置 PCS 公钥直接 503（fail closed），不接受共享令牌降级；
 *   - 令牌必须绑定到**这一条**待决请求：approval_request_id / operator_id / subject_digest /
 *     action_scope 全部核对，任何一项不符都拒绝；
 *   - 不接受任何“聊天里说批准了”的输入——只有带签名令牌的结构化调用；
 *   - jti 落库唯一，同一个令牌不能批两次。
 *
 * 尚未实现：对象变更后自动批量 INVALIDATED 的扫描任务。
 */
export async function decideApproval(input: ApprovalDecisionInput) {
  requireApprovalConfigured();
  if (!input.approval_token || !input.operator_id) {
    throw new ApiError(400, "BAD_REQUEST", "approval_token / operator_id 必填");
  }
  if (input.decision !== "APPROVED" && input.decision !== "REJECTED") {
    throw new ApiError(400, "BAD_REQUEST", "decision 必须是 APPROVED / REJECTED");
  }

  const claims = verifyApprovalToken(input.approval_token);
  if (claims.operator_id !== input.operator_id) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "审批令牌的 operator 与调用方不一致", {
      token_operator: claims.operator_id,
      requested: input.operator_id,
    });
  }

  return tx(async (c) => {
    const req = (
      await c.query(
        `SELECT * FROM approval_requests WHERE task_id = $1 AND status = 'PENDING' FOR UPDATE`,
        [input.task_id],
      )
    ).rows[0];
    if (!req) throw new ApiError(404, "APPROVAL_NOT_FOUND", "没有待决审批请求");

    // ---- 令牌与这一条请求的绑定
    if (claims.approval_request_id !== req.approval_request_id) {
      throw new ApiError(403, "ROLE_NOT_ALLOWED", "审批令牌不是为这条请求签发的", {
        token_request: claims.approval_request_id,
        pending_request: req.approval_request_id,
      });
    }
    const tokenDigest = claims.subject_digest ?? null;
    if (req.subject_digest && tokenDigest !== req.subject_digest) {
      throw new ApiError(409, "APPROVAL_SUBJECT_CHANGED", "审批对象已变化，必须重新审批", {
        expected: req.subject_digest,
        got: tokenDigest,
      });
    }
    if (input.subject_digest && input.subject_digest !== tokenDigest) {
      throw new ApiError(409, "APPROVAL_SUBJECT_CHANGED", "请求体摘要与审批令牌不一致", {
        token: tokenDigest,
        body: input.subject_digest,
      });
    }
    const reqScope = [...(req.action_scope ?? [])].sort();
    const tokenScope = [...claims.action_scope].sort();
    if (reqScope.join(",") !== tokenScope.join(",")) {
      throw new ApiError(403, "ROLE_NOT_ALLOWED", "审批令牌的操作范围与请求不一致", {
        expected: reqScope,
        got: tokenScope,
      });
    }

    const run = (
      await c.query(`SELECT * FROM workflow_runs WHERE workflow_run_id = $1 FOR UPDATE`, [
        req.workflow_run_id,
      ])
    ).rows[0];
    if (!run) throw new ApiError(409, "STATE_CONFLICT", "审批对应的工作流不存在");

    // jti 单次使用：令牌就算被转发，也只能落一次库
    if (claims.jti) {
      const used = await q1(`SELECT 1 FROM approvals WHERE token_jti = $1`, [claims.jti]);
      if (used) throw new ApiError(409, "APPROVAL_TOKEN_USED", "审批令牌已被使用");
    }

    const approval = (
      await c.query(
        `INSERT INTO approvals
           (approval_id, task_id, workflow_run_id, decision, operator_id, comment,
            approval_token, token_jti, subject_digest, action_scope, policy_version, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, app_now())
         RETURNING *`,
        [
          newId("apr"),
          req.task_id,
          req.workflow_run_id,
          input.decision,
          input.operator_id,
          input.comment ?? null,
          input.approval_token,
          claims.jti ?? null,
          tokenDigest,
          req.action_scope ?? [],
          input.policy_version ?? req.policy_version,
        ],
      )
    ).rows[0];

    await c.query(
      `UPDATE approval_requests SET status = $2, decided_at = app_now()
        WHERE approval_request_id = $1`,
      [req.approval_request_id, input.decision],
    );

    await appendWorkflowEvent(c, run.workflow_run_id, "APPROVAL_DECIDED", {
      task_id: req.task_id,
      decision: input.decision,
      operator_id: input.operator_id,
      approval_id: approval.approval_id,
      subject_digest: approval.subject_digest,
    });

    if (input.decision === "REJECTED") {
      await finishRun(c, run, "FAILED", "WORKFLOW_FAILED");
      return { run: { ...run, status: "FAILED" }, approval, task: null };
    }

    const tpl = await loadTemplate(c, run.workflow_template_id);
    const idx = tpl.phases.findIndex((p: Phase) => p.phase === run.current_phase);
    const next = idx >= 0 ? tpl.phases[idx + 1] : undefined;
    if (!next) {
      await finishRun(c, run, "COMPLETED", "WORKFLOW_COMPLETED");
      return { run: { ...run, status: "COMPLETED" }, approval, task: null };
    }

    const prevTask = (
      await c.query(`SELECT * FROM tasks WHERE task_id = $1`, [req.task_id])
    ).rows[0];
    // 审批结论随任务下发：受控提交必须重新计算摘要并与它比对（§7.3）
    const nextTask = await insertNextTask(c, run, prevTask, next, {
      approval_id: approval.approval_id,
      approval_subject_digest: approval.subject_digest,
      approved_action_scope: approval.action_scope ?? [],
    });
    const updatedRun = (
      await c.query(
        `UPDATE workflow_runs
            SET status = $2, current_phase = $3, current_task_id = $4, updated_at = app_now()
          WHERE workflow_run_id = $1
          RETURNING *`,
        [run.workflow_run_id, PHASE_STATUS[next.phase] ?? "RUNNING", next.phase, nextTask.task_id],
      )
    ).rows[0];

    await appendWorkflowEvent(c, run.workflow_run_id, "WORKFLOW_PHASE_STARTED", {
      phase: next.phase,
      task_id: nextTask.task_id,
      parent_task_id: req.task_id,
      after_approval: true,
    });

    return { run: updatedRun, approval, task: nextTask };
  });
}

// ---------------------------------------------------------------- 查询

export async function getWorkflowRun(runId: string) {
  const run = await q1(`SELECT * FROM workflow_runs WHERE workflow_run_id = $1`, [runId]);
  if (!run) throw new ApiError(404, "NOT_FOUND", `工作流不存在: ${runId}`);
  const tasks = await q(
    `SELECT task_id, task_type, status, parent_task_id, current_attempt_id,
            attempt_count, enqueued_at, updated_at
       FROM tasks WHERE workflow_run_id = $1 ORDER BY enqueued_at, task_id`,
    [runId],
  );
  const approvals = await q(
    `SELECT approval_request_id, task_id, status, subject_digest, action_scope,
            policy_version, requested_at, decided_at
       FROM approval_requests WHERE workflow_run_id = $1 ORDER BY requested_at`,
    [runId],
  );
  return { ...run, tasks, approval_requests: approvals };
}

/** 管理应用审批中心：列出审批请求及其任务/工作流上下文。 */
export async function listApprovalRequests(filter: { status?: string; limit?: number } = {}) {
  const status = filter.status ?? null;
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  return q(
    `SELECT ar.approval_request_id, ar.workflow_run_id, ar.task_id, ar.status,
            ar.subject_digest, ar.action_scope, ar.policy_version,
            ar.requested_at, ar.decided_at,
            t.task_type, t.status AS task_status, t.payload_ref,
            t.payload_sha256, td.target_role,
            wr.status AS workflow_status, wr.current_phase,
            ap.approval_id, ap.decision, ap.operator_id AS decided_by,
            ap.comment AS decision_comment, ap.decided_at AS decision_at,
            ev.evidence
       FROM approval_requests ar
       JOIN tasks t ON t.task_id = ar.task_id
       JOIN task_definitions td ON td.task_type = t.task_type
       JOIN workflow_runs wr ON wr.workflow_run_id = ar.workflow_run_id
       LEFT JOIN LATERAL (
         SELECT approval_id, decision, operator_id, comment, decided_at
           FROM approvals
          WHERE task_id = ar.task_id AND workflow_run_id = ar.workflow_run_id
          ORDER BY decided_at DESC LIMIT 1
       ) ap ON TRUE
       LEFT JOIN LATERAL (
         SELECT array_agg(media_type || ':' || COALESCE(actual_sha256, 'pending')) AS evidence
           FROM artifacts
          WHERE task_id = ar.task_id AND status = 'COMPLETE'
       ) ev ON TRUE
      WHERE ($1::text IS NULL OR ar.status = $1)
      ORDER BY ar.requested_at DESC
      LIMIT $2`,
    [status, limit],
  );
}

export async function listWorkflowRuns(limit = 100) {
  return q(
    `SELECT workflow_run_id, workflow_template_id, template_version, status,
            current_phase, root_task_id, current_task_id, created_at, updated_at
       FROM workflow_runs ORDER BY created_at DESC, workflow_run_id
       LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
}
