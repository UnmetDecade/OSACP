import type { Assignment } from "./client.js";

/** 执行器的中止与失败语义。单独成文件，避免 executor 与角色实现互相 import 成环。 */

export class TaskAborted extends Error {
  constructor(readonly reason: "cancelled" | "lease_lost" | "shutdown") {
    super(`task aborted: ${reason}`);
    this.name = "TaskAborted";
  }
}

export class TaskFailed extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "TaskFailed";
  }
}

export interface UploadedArtifact {
  artifact_id: string;
  sha256: string;
  size_bytes: number;
}

export interface DownloadedArtifact {
  data: Buffer;
  sha256: string;
  media_type: string;
}

export interface ExecContext {
  signal: AbortSignal;
  log: (msg: string) => void;
  progress: (percent: number, note?: string) => void;
  /** 当前角色实例 id，写进产物报告便于追溯 */
  instanceId: string;
  /** 本次 attempt 的独立工作目录（已创建），任务结束后由 Agent 清理 */
  workspaceDir: string;
  /** 上传制品并让调度机重算摘要；返回的 sha256 是服务端确认过的值 */
  uploadArtifact: (content: Buffer | string, mediaType?: string) => Promise<UploadedArtifact>;
  /** 下载调度机交接给本任务的上游制品 */
  downloadArtifact: (artifactId: string) => Promise<DownloadedArtifact>;
}

export interface ExecOutcome {
  summary: string;
  outputs?: Record<string, unknown>;
}

export type Executor = (task: Assignment, ctx: ExecContext) => Promise<ExecOutcome>;
