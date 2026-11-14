import { beforeEach, describe, expect, it } from "vitest";
import { tasksForHost } from "./host-tasks";
import { db } from "./store";
import type { Host, Instance, Task } from "./types";

function host(id: string, parent: string | null = null): Host {
  return {
    id,
    name: id,
    os: "Linux",
    arch: "x86_64",
    runtime_version: "1.0.0",
    state: "ONLINE",
    cpu: 0,
    mem: 0,
    disk: 0,
    cpu_total: 1,
    mem_total_mb: 1024,
    mem_available_mb: 512,
    labels: {},
    capabilities: [],
    registered_at: "2026-01-01T00:00:00Z",
    maintaining: false,
    parent_host_id: parent,
  };
}

function instance(
  id: string,
  hostId: string,
  role: Instance["role"] = "builder",
): Instance {
  return {
    key: `${hostId}/${id}`,
    id,
    name: id,
    role,
    host_id: hostId,
    agent_profile_id: "",
    api_profile_ids: [],
    task_types: [],
    resource_profile: "-",
    cpu_limit: 1,
    mem_limit_mb: 1024,
    disk_gb: 20,
    state: "ONLINE",
    config_version: 1,
    last_heartbeat: "2026-01-01T00:00:00Z",
    image: "",
    created_at: "2026-01-01T00:00:00Z",
  };
}

function task(id: string, instanceId?: string): Task {
  return {
    id,
    title: id,
    type: "task.build",
    workflow: "-",
    stage: "RUNNING",
    target_role: "builder",
    priority: 2,
    state: "RUNNING",
    instance_id: instanceId,
    attempts: 0,
    created_at: "2026-01-01T00:00:00Z",
    payload: {},
    events: [],
  };
}

beforeEach(() => {
  db.hosts.length = 0;
  db.instances.length = 0;
  db.tasks.length = 0;
});

describe("tasksForHost", () => {
  it("returns nothing without a host", () => {
    expect(tasksForHost(undefined)).toEqual([]);
  });

  it("includes tasks on this host and on hosts merged below it", () => {
    db.hosts.push(host("root"), host("child", "root"), host("other"));
    db.instances.push(
      instance("builder-root", "root"),
      instance("builder-child", "child"),
      instance("builder-other", "other"),
      instance("scheduler-root", "root", "scheduler"),
    );
    db.tasks.push(
      task("t-root", "builder-root"),
      task("t-child", "builder-child"),
      task("t-other", "builder-other"),
      task("t-unassigned"),
    );

    expect(tasksForHost(db.hosts[0]).map((t) => t.id)).toEqual([
      "t-root",
      "t-child",
      "t-unassigned",
    ]);
  });

  it("does not attribute unassigned tasks without a scheduler in the subtree", () => {
    db.hosts.push(host("root"), host("child", "root"));
    db.instances.push(instance("builder-child", "child"));
    db.tasks.push(task("t-child", "builder-child"), task("t-unassigned"));

    expect(tasksForHost(db.hosts[0]).map((t) => t.id)).toEqual(["t-child"]);
  });

  it("filters out tasks on unrelated hosts and instances that no longer exist", () => {
    db.hosts.push(host("root"), host("other"));
    db.instances.push(instance("builder-root", "root"), instance("scheduler-root", "root", "scheduler"));
    db.tasks.push(
      task("t-root", "builder-root"),
      task("t-other", "builder-other"),
      task("t-stale", "deleted-builder"),
    );

    expect(tasksForHost(db.hosts[0]).map((t) => t.id)).toEqual(["t-root"]);
  });
});
