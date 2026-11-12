/**
 * Error codes from the spec. HTTP status is returned along with code; callers branch on code and never parse the message.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const err = {
  notFound: (what: string, id: string) =>
    new ApiError(404, "NOT_FOUND", `${what} 不存在: ${id}`),
  stateConflict: (from: string, to: string, why = "") =>
    new ApiError(409, "STATE_CONFLICT", `非法状态迁移 ${from} → ${to}${why ? "：" + why : ""}`),
  fencingStale: (taskId: string) =>
    new ApiError(409, "FENCING_STALE", `fencing 已过期，该 attempt 的写入被拒绝（task ${taskId}）`),
  leaseExpired: () =>
    new ApiError(409, "LEASE_EXPIRED", "租约已过期或已被回收"),
  leaseMismatch: () =>
    new ApiError(409, "LEASE_MISMATCH", "lease_token 与当前 attempt 不匹配"),
  notEligible: (why: string) =>
    new ApiError(409, "INSTANCE_NOT_ELIGIBLE", why),
  invalid: (why: string) => new ApiError(400, "BAD_REQUEST", why),
};
