import type { Executor } from "../exec-types.js";
import { taskBuild } from "./builder.js";
import { chatExecutorFor, consoleExecutorFor } from "./chat-console.js";

/** v4：只有构建机执行任务；调度机负责排队、租约与派发。 */
const CHAT_ROLES = ["builder", "scheduler"] as const;

/**
 * 按任务类型注册角色执行器。
 *
 * 每个任务类型只由一个角色实现；调度机负责按 target_role 派发，
 * 角色进程不根据 payload 自行决定“要不要做别人的活”。
 */
export const roleExecutors: Record<string, Executor> = {
  "task.build": taskBuild,

  // 对话与终端同样是受调度、受审计的普通任务
  ...Object.fromEntries(CHAT_ROLES.map((role) => [`task.chat.${role}`, chatExecutorFor(role)])),
  ...Object.fromEntries(CHAT_ROLES.map((role) => [`task.console.${role}`, consoleExecutorFor(role)])),
};
