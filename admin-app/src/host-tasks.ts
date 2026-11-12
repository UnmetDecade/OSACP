import { db } from "./store";
import type { Host, Task } from "./types";

/**
 * 一台主机能看到哪些任务：
 * - 已经派到这台主机上实例的任务；
 * - 还没指派的目标实例的任务，归给这台主机的根调度机。
 */
export function tasksForHost(host: Host | undefined): Task[] {
  if (!host) return [];
  const instances = new Set(db.instances.filter((i) => i.host_id === host.id).map((i) => i.id));
  const hasScheduler = db.instances.some((i) => i.role === "scheduler" && i.host_id === host.id);
  return db.tasks.filter((t) => (t.instance_id ? instances.has(t.instance_id) : hasScheduler));
}
