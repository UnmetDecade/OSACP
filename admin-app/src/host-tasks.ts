import { db } from "./store";
import type { Host, Task } from "./types";

/**
 * Hosts merged under this one are part of the same studio: the overview counts their builders and the
 * scheduler dispatches their tasks, so their tasks must be visible here too.
 */
function subtreeHostIds(rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const h of db.hosts) {
      if (!ids.has(h.id) && h.parent_host_id && ids.has(h.parent_host_id)) {
        ids.add(h.id);
        changed = true;
      }
    }
  }
  return ids;
}

/**
 * Which tasks a host can see:
 * - tasks already dispatched to instances on this host or a host merged under it;
 * - tasks whose target instance is not yet assigned, attributed to this studio's scheduler.
 */
export function tasksForHost(host: Host | undefined): Task[] {
  if (!host) return [];
  const hosts = subtreeHostIds(host.id);
  const instances = new Set(
    db.instances.filter((i) => hosts.has(i.host_id)).map((i) => i.id),
  );
  const hasScheduler = db.instances.some((i) => i.role === "scheduler" && hosts.has(i.host_id));
  return db.tasks.filter((t) => (t.instance_id ? instances.has(t.instance_id) : hasScheduler));
}
