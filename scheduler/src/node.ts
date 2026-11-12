import { config } from "./config.js";

/**
 * The scheduler's node id in the federation tree.
 * PCS injects SCHEDULER_NODE_ID at deployment (recommended: host_id); local development without it uses host_id:root,
 * still guaranteeing only one root scheduler per host.
 */
export function selfNodeId(): string {
  return config.nodeId || `${config.hostId || "scheduler"}:root`;
}
