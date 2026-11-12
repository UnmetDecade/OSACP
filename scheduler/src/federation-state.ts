import { config } from "./config.js";

/**
 * 联邦上级地址可以在运行时调整：主机并入 / 脱离只改 PCS 里的一行引用，
 * 不重启容器。部署时的 SCHEDULER_PARENT_URL 只是初始值。
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
