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
  /** Original file name (workspace-relative for collected files); used by the download endpoint. */
  name?: string;
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
  /**
   * Report an outward action (push / upload / deploy / publish) the moment the executor is
   * about to attempt it. The scheduler persists it before the attempt can end, so a crash
   * cannot turn into a silent rerun that repeats the side effect.
   */
  outward?: (action: string) => void;
  /** Current role instance id, written into artifact reports for traceability */
  instanceId: string;
  /** Per-attempt working directory (already created), cleaned up by the agent after the task ends */
  workspaceDir: string;
  /** Upload an artifact and have the scheduler recompute its digest; the returned sha256 is the value confirmed by the server */
  uploadArtifact: (
    content: Buffer | string,
    mediaType?: string,
    name?: string,
  ) => Promise<UploadedArtifact>;
  /** Download an upstream artifact handed to this task by the scheduler */
  downloadArtifact: (artifactId: string) => Promise<DownloadedArtifact>;
}

export interface ExecOutcome {
  summary: string;
  outputs?: Record<string, unknown>;
  /** The executor is blocked on a human decision; the attempt parks instead of succeeding/failing. */
  question?: string;
  /** The executor asks the scheduler to split this task into child tasks and park the parent. */
  split?: Array<{ task_type?: string; title?: string; instruction?: string; requirements?: Record<string, unknown> }>;
  /** Outward actions observed during the attempt. */
  outward?: string[];
}

export type Executor = (task: Assignment, ctx: ExecContext) => Promise<ExecOutcome>;
