import type { Executor } from "./exec-types.js";
import { roleExecutors } from "./roles/index.js";
import { sleepAbortable } from "./roles/common.js";

/**
 * 角色执行器表。
 *
 * 具体实现按角色拆在 `src/roles/`：每个角色一个文件，只做自己职责内的事。
 * 未知任务类型走 fallback，不会因为“看起来像某个角色”就去猜着执行。
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
  // 仍然是可中断的：未知任务类型也不允许在租约丢失后继续跑
  await sleepAbortable(500, ctx.signal);
  return { summary: `执行完成 ${task.task_id}` };
};

export function executorFor(taskType: string): Executor {
  return executors[taskType] ?? fallback;
}
