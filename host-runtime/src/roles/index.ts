import type { Executor } from "../exec-types.js";
import { taskBuild } from "./builder.js";
import { chatExecutorFor, consoleExecutorFor } from "./chat-console.js";

/** v4: only the builder executes tasks; the scheduler handles queuing, leases and dispatch. */
const CHAT_ROLES = ["builder", "scheduler"] as const;

/**
 * Register role executors by task type.
 *
 * Each task type is implemented by exactly one role; the scheduler dispatches by target_role,
 * and a role process does not decide on its own from the payload whether to do someone else's work.
 */
export const roleExecutors: Record<string, Executor> = {
  "task.build": taskBuild,

  // Chat and console are likewise ordinary tasks that are scheduled and audited
  ...Object.fromEntries(CHAT_ROLES.map((role) => [`task.chat.${role}`, chatExecutorFor(role)])),
  ...Object.fromEntries(CHAT_ROLES.map((role) => [`task.console.${role}`, consoleExecutorFor(role)])),
};
