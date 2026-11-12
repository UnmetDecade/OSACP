import { config } from "./config.js";

/**
 * The federation parent URL can change at runtime: joining/leaving changes only a single reference in PCS,
 * without restarting the container. SCHEDULER_PARENT_URL at deploy time is only the initial value.
 */
let parentUrl = config.parentUrl;

export function getFederationParentUrl(): string {
  return parentUrl;
}

export function setFederationParentUrl(value: unknown): string {
  const next = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  parentUrl = next;
  return parentUrl;
}
