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
    new ApiError(404, "NOT_FOUND", `${what} not found: ${id}`),
  stateConflict: (from: string, to: string, why = "") =>
    new ApiError(409, "STATE_CONFLICT", `illegal state transition ${from} → ${to}${why ? ": " + why : ""}`),
  fencingStale: (taskId: string) =>
    new ApiError(409, "FENCING_STALE", `fencing token is stale; write for this attempt was rejected (task ${taskId})`),
  leaseExpired: () =>
    new ApiError(409, "LEASE_EXPIRED", "lease has expired or been reclaimed"),
  leaseMismatch: () =>
    new ApiError(409, "LEASE_MISMATCH", "lease_token does not match the current attempt"),
  notEligible: (why: string) =>
    new ApiError(409, "INSTANCE_NOT_ELIGIBLE", why),
  invalid: (why: string) => new ApiError(400, "BAD_REQUEST", why),
};
