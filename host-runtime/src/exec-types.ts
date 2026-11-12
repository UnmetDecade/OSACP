import type { Assignment } from "./client.js";

/** Executor abort and failure semantics. Kept in its own file to avoid an import cycle between executor and role implementations. */

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
  /** Current role instance id, written into artifact reports for traceability */
  instanceId: string;
  /** Per-attempt working directory (already created), cleaned up by the agent after the task ends */
  workspaceDir: string;
  /** Upload an artifact and have the scheduler recompute its digest; the returned sha256 is the value confirmed by the server */
  uploadArtifact: (content: Buffer | string, mediaType?: string) => Promise<UploadedArtifact>;
  /** Download an upstream artifact handed to this task by the scheduler */
  downloadArtifact: (artifactId: string) => Promise<DownloadedArtifact>;
}

export interface ExecOutcome {
  summary: string;
  outputs?: Record<string, unknown>;
}

export type Executor = (task: Assignment, ctx: ExecContext) => Promise<ExecOutcome>;
