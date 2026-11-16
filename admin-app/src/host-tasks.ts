import { db } from "./store";
import type { Host, Instance, Task } from "./types";

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
 * The scheduler that serves this studio: the host's own root scheduler, or — for a bare-metal builder
 * host that joined a scheduler elsewhere — the scheduler that dispatches to this host's builders.
 * A builder-only host therefore gets a working task entry without deploying a local scheduler.
 */
export function studioScheduler(host: Host | undefined): Instance | undefined {
  if (!host) return undefined;
  const own = db.instances.find(
    (i) =>
      i.role === "scheduler" &&
      i.host_id === host.id &&
      (i.scheduler_role ?? "root") === "root",
  );
  if (own) return own;
  const hosts = subtreeHostIds(host.id);
  const ownerIds = new Set(
    db.instances
      .filter((i) => i.role === "builder" && hosts.has(i.host_id) && i.scheduler_deployment_id)
      .map((i) => i.scheduler_deployment_id),
  );
  return db.instances.find(
    (i) => i.role === "scheduler" && i.deployment_id && ownerIds.has(i.deployment_id),
  );
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
  // Any scheduler in the subtree (node schedulers included) still owns its queue; otherwise a bare-metal
  // builder host counts as served once its builder is attached to a scheduler elsewhere.
  const hasScheduler =
    db.instances.some((i) => i.role === "scheduler" && hosts.has(i.host_id)) ||
    Boolean(studioScheduler(host));
  return db.tasks.filter((t) => (t.instance_id ? instances.has(t.instance_id) : hasScheduler));
}
