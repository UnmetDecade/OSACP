import type { Executor } from "./exec-types.js";
import { roleExecutors } from "./roles/index.js";
import { sleepAbortable } from "./roles/common.js";

/**
 * Role executor table.
 *
 * Implementations are split by role under `src/roles/`: one file per role, each doing only what falls within its remit.
 * Unknown task types go to the fallback; it never guesses at execution just because something "looks like" a role.
 */
export {
  TaskAborted,
  TaskFailed,
  type DownloadedArtifact,
  type ExecContext,
  type ExecOutcome,
  type Executor,
  type UploadedArtifact,
} from "./exec-types.js";

export const executors: Record<string, Executor> = roleExecutors;

const fallback: Executor = async (task, ctx) => {
  ctx.progress(50, "generic");
  // Still abortable: even unknown task types must not keep running after the lease is lost
  await sleepAbortable(500, ctx.signal);
  return { summary: `执行完成 ${task.task_id}` };
};

export function executorFor(taskType: string): Executor {
  return executors[taskType] ?? fallback;
}
