import { db } from "./store";
import type { Host } from "./types";

/**
 * 本机 + 全部并入本机的主机（递归）。
 * 调度台和构建机列表都按这棵子树看，才能在父主机上看到并入主机的资源。
 */
export function hostTreeIds(rootId: string | undefined): Set<string> {
  const ids = new Set<string>();
  if (!rootId) return ids;
  ids.add(rootId);
  const children = new Map<string, Host[]>();
  for (const h of db.hosts) {
    if (!h.parent_host_id) continue;
    const list = children.get(h.parent_host_id) ?? [];
    list.push(h);
    children.set(h.parent_host_id, list);
  }
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (ids.has(next.id)) continue;
    ids.add(next.id);
    stack.push(...(children.get(next.id) ?? []));
  }
  return ids;
}

export interface HostGroup<T> {
  hostId: string;
  name: string;
  /** 当前主机：排最前，默认展开；并入主机默认折叠。 */
  current: boolean;
  items: T[];
}

/**
 * 列表按主机分组，包括当前主机自己。每台主机一组、按主机名折叠：
 * 并入主机可能有几百台，列表里必须收得起来，不能一屏全是别人家的机器。
 */
export function groupByHost<T extends { host_id: string }>(
  items: T[],
  currentHostId: string | undefined,
): HostGroup<T>[] {
  const byHost = new Map<string, T[]>();
  for (const item of items) {
    const list = byHost.get(item.host_id) ?? [];
    list.push(item);
    byHost.set(item.host_id, list);
  }
  const names = new Map(db.hosts.map((h) => [h.id, h.name] as const));
  return [...byHost.entries()]
    .map(([hostId, list]) => ({
      hostId,
      name: names.get(hostId) ?? hostId,
      current: hostId === currentHostId,
      items: list,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
}
