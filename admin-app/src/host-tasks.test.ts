import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./store";
import { studioScheduler, tasksForHost } from "./host-tasks";
import type { Host, Instance, Task } from "./types";

function host(id: string, overrides: Partial<Host> = {}): Host {
  return {
    id,
    name: id,
    os: "Linux",
    arch: "x86_64",
    runtime_version: "4.6.0",
    state: "ONLINE",
    cpu: 10,
    mem: 20,
    disk: 30,
    cpu_total: 8,
    mem_total_mb: 32768,
    mem_available_mb: 16384,
    labels: {},
    capabilities: [],
    registered_at: "2026-01-01T00:00:00Z",
    maintaining: false,
    role_mode: "containers",
    ...overrides,
  };
}

function instance(overrides: Partial<Instance>): Instance {
  return {
    key: `${overrides.host_id}/${overrides.id}`,
    id: "",
    name: "",
    role: "builder",
    host_id: "",
    state: "ONLINE",
    config_version: 1,
    last_heartbeat: "2026-01-01T00:00:00Z",
    image: "",
    task_types: [],
    resource_profile: "",
    cpu_limit: 1,
    mem_limit_mb: 1024,
    disk_gb: 10,
    api_profile_ids: [],
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Instance;
}

function task(overrides: Partial<Task>): Task {
  return {
    id: "t1",
    title: "queued task",
    state: "QUEUED",
    type: "task.build",
    workflow: "build",
    stage: "queued",
    target_role: "builder",
    priority: 2,
    attempt_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    payload: {},
    events: [],
    ...overrides,
  } as unknown as Task;
}

beforeEach(() => {
  db.hosts = [];
  db.instances = [];
  db.tasks = [];
});

describe("studioScheduler", () => {
  it("prefers the host's own root scheduler", () => {
    db.hosts = [host("h1")];
    db.instances = [
      instance({ id: "sched-own", role: "scheduler", host_id: "h1", scheduler_role: "root" }),
      instance({
        id: "sched-remote",
        role: "scheduler",
        host_id: "h2",
        scheduler_role: "root",
        deployment_id: "dep-remote",
      }),
      instance({ id: "b1", host_id: "h1", scheduler_deployment_id: "dep-remote" }),
    ];
    expect(studioScheduler(db.hosts[0])?.id).toBe("sched-own");
  });

  it("finds the scheduler that owns a builder-only host's builders", () => {
    db.hosts = [host("h1")];
    db.instances = [
      instance({
        id: "sched-remote",
        role: "scheduler",
        host_id: "h2",
        scheduler_role: "root",
        deployment_id: "dep-remote",
      }),
      instance({ id: "b1", host_id: "h1", scheduler_deployment_id: "dep-remote" }),
    ];
    expect(studioScheduler(db.hosts[0])?.id).toBe("sched-remote");
  });

  it("returns nothing when neither a local scheduler nor an owning one exists", () => {
    db.hosts = [host("h1")];
    db.instances = [instance({ id: "b1", host_id: "h1" })];
    expect(studioScheduler(db.hosts[0])).toBeUndefined();
  });

  it("finds the scheduler attached through a host merged under this one", () => {
    // Builders of a merged host are part of this studio, so their scheduler serves this host too.
    db.hosts = [host("h1"), host("h2", { parent_host_id: "h1" })];
    db.instances = [
      instance({
        id: "sched-remote",
        role: "scheduler",
        host_id: "h3",
        scheduler_role: "root",
        deployment_id: "dep-remote",
      }),
      instance({ id: "b2", host_id: "h2", scheduler_deployment_id: "dep-remote" }),
    ];
    expect(studioScheduler(db.hosts[0])?.id).toBe("sched-remote");
  });

  it("ignores a node scheduler as the studio entry point", () => {
    db.hosts = [host("h1")];
    db.instances = [
      instance({ id: "node-only", role: "scheduler", host_id: "h1", scheduler_role: "node" }),
    ];
    expect(studioScheduler(db.hosts[0])).toBeUndefined();
  });

  it("returns nothing without a host", () => {
    expect(studioScheduler(undefined)).toBeUndefined();
  });
});

describe("tasksForHost", () => {
  it("shows queued tasks on a builder-only host attached to a remote scheduler", () => {
    db.hosts = [host("h1")];
    db.instances = [
      instance({
        id: "sched-remote",
        role: "scheduler",
        host_id: "h2",
        scheduler_role: "root",
        deployment_id: "dep-remote",
      }),
      instance({ id: "b1", host_id: "h1", scheduler_deployment_id: "dep-remote" }),
    ];
    db.tasks = [task({ id: "t1" }), task({ id: "t2", instance_id: "b1", state: "RUNNING" })];
    // The queue lives on the remote scheduler; without this the task would vanish between submit and dispatch.
    expect(tasksForHost(db.hosts[0]).map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("keeps queued tasks hidden when no scheduler serves the host", () => {
    db.hosts = [host("h1")];
    db.instances = [instance({ id: "b1", host_id: "h1" })];
    db.tasks = [task({ id: "t1" })];
    expect(tasksForHost(db.hosts[0])).toEqual([]);
  });

  it("shows queued tasks when the host runs its own scheduler", () => {
    db.hosts = [host("h1")];
    db.instances = [
      instance({ id: "sched-local", role: "scheduler", host_id: "h1", scheduler_role: "root" }),
    ];
    db.tasks = [task({ id: "t1" })];
    expect(tasksForHost(db.hosts[0]).map((t) => t.id)).toEqual(["t1"]);
  });

  it("returns nothing without a host", () => {
    db.tasks = [task({ id: "t1" })];
    expect(tasksForHost(undefined)).toEqual([]);
  });
});
