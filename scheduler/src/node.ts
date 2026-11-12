import { config } from "./config.js";

/**
 * 调度机在联邦树里的节点 id。
 * PCS 部署时会注入 SCHEDULER_NODE_ID（建议用 host_id）；本地开发没注入时用 host_id:root，
 * 仍然保证同一台主机上只有一个根调度机。
 */
export function selfNodeId(): string {
  return config.nodeId || `${config.hostId || "scheduler"}:root`;
}
