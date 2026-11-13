import type { AgentProfile, ApiProfile, Fleet, Host, Instance, LogEntry, Sideload, Task } from "./types";

/**
 * Runtime data store: pages read only; live sync writes to it.
 * The app no longer bundles demo data; the first render is empty and sync fills it in.
 */
export const db = {
  hosts: [] as Host[],
  instances: [] as Instance[],
  agents: [] as AgentProfile[],
  apis: [] as ApiProfile[],
  tasks: [] as Task[],
  logs: [] as LogEntry[],
  /** Control plane federation tree (ΣW / fold relationships); keep the last result when the control plane is unreachable. */
  fleet: { hosts: [], total_score: 0, generated_at: "" } as Fleet,
  /** Per-host curl tokens; the studio filters them to the current host and never shows another host's. */
  sideloads: [] as Sideload[],
};
