import { db } from "./store";
import type { Host } from "./types";

/**
 * This host plus every host folded into it (recursive).
 * The scheduler and builder lists both scope to this subtree, so resources of folded hosts are visible on the parent host.
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
  /** Current host: first in the list and expanded by default; folded hosts are collapsed by default. */
  current: boolean;
  items: T[];
}

/**
 * The list is grouped by host, including the current host itself. One group per host, collapsed by host name:
 * there may be hundreds of folded hosts, so the list must stay collapsible rather than fill the screen with other machines.
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
