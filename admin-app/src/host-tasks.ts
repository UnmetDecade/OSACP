import { db } from "./store";
import type { Host, Task } from "./types";

/**
 * Which tasks a host can see:
 * - tasks already dispatched to instances on this host;
 * - tasks whose target instance is not yet assigned, attributed to this host's root scheduler.
 */
export function tasksForHost(host: Host | undefined): Task[] {
  if (!host) return [];
  const instances = new Set(db.instances.filter((i) => i.host_id === host.id).map((i) => i.id));
  const hasScheduler = db.instances.some((i) => i.role === "scheduler" && i.host_id === host.id);
  return db.tasks.filter((t) => (t.instance_id ? instances.has(t.instance_id) : hasScheduler));
}
