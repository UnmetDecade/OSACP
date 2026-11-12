import { ApiError } from "./errors.js";

export type TaskStatus =
  | "QUEUED"
  | "ASSIGNED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";

/**
 * 表驱动迁移。§4.3 的迁移表逐条落在这里；
 * 任何不在表里的迁移一律 409 STATE_CONFLICT，不靠 service 里散落的 if。
 */
export const TRANSITIONS: Record<TaskStatus, Partial<Record<TaskStatus, string>>> = {
  QUEUED: {
    ASSIGNED: "claim",
    RUNNING: "relay_started",
    SUCCEEDED: "relay_result_succeeded",
    FAILED: "relay_result_failed_retry_exhausted",
    BLOCKED: "external_dependency_unavailable",
    CANCELLED: "operator_cancel",
  },
  ASSIGNED: {
    RUNNING: "start_ack",
    QUEUED: "start_timeout | lease_expired | admission_rejected",
    SUCCEEDED: "relay_result_succeeded",
    FAILED: "relay_result_failed_retry_exhausted",
    CANCELLED: "cancel_ack | forced_cancel",
  },
  RUNNING: {
    SUCCEEDED: "result_succeeded",
    FAILED: "result_failed_retry_exhausted",
    QUEUED: "result_failed_retryable | lease_expired",
    BLOCKED: "external_dependency_unavailable",
    CANCELLED: "cancel_ack | forced_cancel",
  },
  BLOCKED: {
    QUEUED: "dependency_recovered",
    CANCELLED: "operator_cancel",
  },
  SUCCEEDED: {},
  FAILED: {},
  CANCELLED: {},
};

export const TERMINAL: TaskStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED"];

export function isTerminal(s: TaskStatus): boolean {
  return TERMINAL.includes(s);
}

export function assertTransition(from: TaskStatus, to: TaskStatus, cause?: string): void {
  if (from === to) return;
  if (!TRANSITIONS[from]?.[to]) {
    throw new ApiError(
      409,
      "STATE_CONFLICT",
      `非法状态迁移 ${from} → ${to}${cause ? `（触发：${cause}）` : ""}`,
      { from, to, allowed: Object.keys(TRANSITIONS[from] ?? {}) },
    );
  }
}
