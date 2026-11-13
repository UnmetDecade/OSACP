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
 * Table-driven transitions. The transition table from §4.3 is spelled out here entry by entry;
 * any transition not in the table is always 409 STATE_CONFLICT, not scattered ifs in services.
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
      `illegal state transition ${from} → ${to}${cause ? ` (cause: ${cause})` : ""}`,
      { from, to, allowed: Object.keys(TRANSITIONS[from] ?? {}) },
    );
  }
}
