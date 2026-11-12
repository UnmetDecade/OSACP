import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { q, q1 } from "../db.js";
import { ApiError } from "../errors.js";
import { newId } from "../ids.js";

/**
 * 制品通道（§7.8）。
 *
 * 关键点：`complete` 时**服务端重算 SHA-256**，与上传方声明的摘要比对。
 * 审批绑定的是这个服务端算出来的摘要，而不是执行器自己写进 outputs 的字符串——
 * 否则“上报什么就批什么”，摘要校验形同虚设。
 *
 * 存储是本地目录（ARTIFACT_DIR）；生产应换成对象存储 + 预签名 URL，接口语义不变。
 */

const MAX_BYTES = 64 * 1024 * 1024;

export function artifactDir(): string {
  return path.resolve(process.env.ARTIFACT_DIR ?? "data/artifacts");
}

function ensureDir(): string {
  const dir = artifactDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function normalizeDigest(value: string): string {
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new ApiError(400, "BAD_REQUEST", "sha256 必须是 64 位十六进制");
  }
  return `sha256:${hex.toLowerCase()}`;
}

export function digestOf(data: Buffer): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export interface CreateArtifactInput {
  task_id: string;
  attempt_id?: string;
  sha256: string;
  size_bytes?: number;
  media_type?: string;
}

export async function createArtifact(input: CreateArtifactInput, instanceId?: string) {
  if (!input.task_id) throw new ApiError(400, "BAD_REQUEST", "task_id 必填");
  const declared = normalizeDigest(input.sha256);

  const task = await q1(`SELECT task_id FROM tasks WHERE task_id = $1`, [input.task_id]);
  if (!task) throw new ApiError(404, "NOT_FOUND", `任务不存在: ${input.task_id}`);

  let owner = instanceId;
  if (input.attempt_id) {
    const attempt = await q1<{ task_id: string; instance_id: string }>(
      `SELECT task_id, instance_id FROM task_attempts WHERE attempt_id = $1`,
      [input.attempt_id],
    );
    if (!attempt) throw new ApiError(404, "NOT_FOUND", `attempt 不存在: ${input.attempt_id}`);
    if (attempt.task_id !== input.task_id) {
      throw new ApiError(409, "STATE_CONFLICT", "attempt 不属于该任务");
    }
    if (instanceId && attempt.instance_id !== instanceId) {
      throw new ApiError(403, "ROLE_NOT_ALLOWED", "只能为自身的 attempt 上传制品");
    }
    owner = attempt.instance_id;
  }
  if (!owner) throw new ApiError(400, "BAD_REQUEST", "缺少 instance_id");

  const artifactId = newId("art");
  const row = (
    await q1(
      `INSERT INTO artifacts
         (artifact_id, task_id, attempt_id, instance_id, status, declared_sha256,
          size_bytes, media_type, storage_ref)
       VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$8)
       RETURNING *`,
      [
        artifactId,
        input.task_id,
        input.attempt_id ?? null,
        owner,
        declared,
        input.size_bytes ?? null,
        input.media_type ?? "application/octet-stream",
        `${artifactId}.bin`,
      ],
    )
  )!;

  return {
    ...row,
    upload: {
      method: "PUT",
      path: `/v1/artifacts/${artifactId}/content`,
      complete_path: `/v1/artifacts/${artifactId}/complete`,
    },
  };
}

function storagePath(storageRef: string): string {
  // storage_ref 由服务端生成（<id>.bin），不接受外部路径
  return path.join(ensureDir(), path.basename(storageRef));
}

export async function putArtifactContent(artifactId: string, data: Buffer, instanceId?: string) {
  if (data.length > MAX_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "制品超过 64MB");
  }
  const row = await q1<any>(`SELECT * FROM artifacts WHERE artifact_id = $1`, [artifactId]);
  if (!row) throw new ApiError(404, "NOT_FOUND", `制品不存在: ${artifactId}`);
  if (instanceId && row.instance_id !== instanceId) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "只能上传自身实例的制品");
  }
  if (row.status !== "PENDING") {
    throw new ApiError(409, "STATE_CONFLICT", `制品已是 ${row.status}`);
  }

  const file = storagePath(row.storage_ref);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);

  await q(`UPDATE artifacts SET size_bytes = $2 WHERE artifact_id = $1`, [artifactId, data.length]);
  return { artifact_id: artifactId, size_bytes: data.length };
}

export async function completeArtifact(artifactId: string, instanceId?: string) {
  const row = await q1<any>(`SELECT * FROM artifacts WHERE artifact_id = $1`, [artifactId]);
  if (!row) throw new ApiError(404, "NOT_FOUND", `制品不存在: ${artifactId}`);
  if (instanceId && row.instance_id !== instanceId) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "只能确认自身实例的制品");
  }

  // 幂等：重复 complete 直接返回结果
  if (row.status === "COMPLETE") {
    return { ...row, idempotent: true };
  }
  if (row.status !== "PENDING") {
    throw new ApiError(409, "STATE_CONFLICT", `制品已是 ${row.status}`);
  }

  const file = storagePath(row.storage_ref);
  if (!fs.existsSync(file)) {
    throw new ApiError(409, "ARTIFACT_NOT_UPLOADED", "制品内容尚未上传");
  }
  const actual = digestOf(fs.readFileSync(file));

  if (actual !== row.declared_sha256) {
    await q(`UPDATE artifacts SET status = 'FAILED', actual_sha256 = $2 WHERE artifact_id = $1`, [
      artifactId,
      actual,
    ]);
    throw new ApiError(422, "ARTIFACT_DIGEST_MISMATCH", "制品内容与声明摘要不一致", {
      declared: row.declared_sha256,
      actual,
    });
  }

  const updated = await q1(
    `UPDATE artifacts
        SET status = 'COMPLETE', actual_sha256 = $2, completed_at = app_now()
      WHERE artifact_id = $1
      RETURNING *`,
    [artifactId, actual],
  );
  return updated;
}

export async function getArtifact(artifactId: string) {
  const row = await q1(`SELECT * FROM artifacts WHERE artifact_id = $1`, [artifactId]);
  if (!row) throw new ApiError(404, "NOT_FOUND", `制品不存在: ${artifactId}`);
  return row;
}

/**
 * 读取制品内容。
 *
 * 授权只有两条路：
 *   1) 调用方是制品属主实例；
 *   2) 调用方在某个进行中的 attempt 上，且该任务的 `requirements.upstream_artifacts`
 *      引用了这个制品——也就是调度机在推进工作流时显式交接的。
 * 不允许按任务、按角色或按“都是同一工作流”放宽。
 * `instanceId` 为空只发生在未配置鉴权的本地开发模式。
 */
export async function readArtifactContent(artifactId: string, instanceId?: string) {
  const row = await q1<any>(`SELECT * FROM artifacts WHERE artifact_id = $1`, [artifactId]);
  if (!row) throw new ApiError(404, "NOT_FOUND", `制品不存在: ${artifactId}`);
  if (row.status !== "COMPLETE") {
    throw new ApiError(409, "STATE_CONFLICT", `制品尚未通过校验: ${row.status}`);
  }

  if (instanceId && row.instance_id !== instanceId) {
    const allowed = await q1(
      `SELECT 1
         FROM task_attempts a
         JOIN tasks t ON t.task_id = a.task_id
        WHERE a.instance_id = $2
          AND a.status IN ('CREATED','STARTED')
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements(
                     COALESCE(t.requirements->'upstream_artifacts', '[]'::jsonb)) e
             WHERE e->>'artifact_id' = $1)
        LIMIT 1`,
      [artifactId, instanceId],
    );
    if (!allowed) {
      throw new ApiError(403, "ROLE_NOT_ALLOWED", "只能读取本实例的制品，或调度机交接给当前任务的上游制品");
    }
  }

  const file = storagePath(row.storage_ref);
  if (!fs.existsSync(file)) throw new ApiError(409, "ARTIFACT_NOT_UPLOADED", "制品内容不存在");
  return {
    artifact_id: row.artifact_id,
    media_type: row.media_type ?? "application/octet-stream",
    sha256: row.actual_sha256,
    data: fs.readFileSync(file),
  };
}

/** 某个任务最近一次通过校验的制品——审批摘要取这个值 */
export async function latestCompleteArtifact(taskId: string) {
  return q1<{ artifact_id: string; actual_sha256: string; size_bytes: number | null }>(
    `SELECT artifact_id, actual_sha256, size_bytes FROM artifacts
      WHERE task_id = $1 AND status = 'COMPLETE'
      ORDER BY completed_at DESC, artifact_id DESC LIMIT 1`,
    [taskId],
  );
}
