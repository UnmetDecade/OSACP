import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../store";
import { defaultConnection, type LiveConnection } from "./config";
import {
  fetchFailureSignatures,
  fetchTaskAttempts,
  fetchTaskDetail,
  fetchTaskEvents,
  syncLive,
} from "./sync";

const connection: LiveConnection = {
  ...defaultConnection(),
  adminToken: "test-token",
  operator: "ops",
};

const GIB = 1024 ** 3;
const NOW = new Date().toISOString();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

type Route = unknown | (() => Response | Promise<Response>);

/**
 * Route by URL fragment. Fragments are matched in insertion order, so put the more specific one first.
 * An unknown URL returns an empty object, mirroring an endpoint with no rows.
 */
function routeFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((fragment) => url.includes(fragment));
    if (!key) return json({});
    const route = routes[key];
    return typeof route === "function" ? await route() : json(route);
  });
}

function fixtures() {
  return {
    hosts: {
      hosts: [
        {
          host_id: "h1",
          hostname: "devbox",
          status: "ONLINE",
          os: "linux",
          arch: "x86_64",
          runtime_version: "4.5.1",
          resources: {
            cpu_count: 8,
            cpu_usage: 0.25,
            mem_total_bytes: 32 * GIB,
            mem_available_bytes: 8 * GIB,
            disk: [
              { fs: "data", total_bytes: 100 * GIB, free_bytes: 100 * GIB },
              { fs: "root", total_bytes: 200 * GIB, free_bytes: 50 * GIB },
            ],
          },
          labels: { zone: "lab", gpu: 0 },
          tools: ["docker", "git"],
          enrolled_at: "2026-01-01T00:00:00Z",
          transport: "ssh",
          address: "10.0.0.8",
          ssh_port: 22,
          ssh_user: "root",
          parent_host_id: null,
          role_mode: "scheduler",
        },
        { host_id: "h2", hostname: "revoked", status: "REVOKED" },
      ],
    },
    fleet: {
      hosts: [
        {
          host_id: "h1",
          hostname: "devbox",
          status: "ONLINE",
          local_score: 800,
          subtree_score: 900,
          builder_count: 1,
          subtree_builder_count: 2,
          child_host_ids: ["h3"],
          depth: 0,
          is_root: true,
          role_mode: "scheduler",
        },
      ],
      total_score: 900,
      generated_at: NOW,
    },
    deployments: {
      deployments: [
        {
          deployment_id: "dep-root",
          instance_id: "sched-a",
          host_id: "h1",
          role_id: "scheduler",
          status: "HEALTHY",
          actual_state: "RUNNING",
          display_name: "root scheduler",
          scheduler_role: "root",
          image: "registry/scheduler@sha256:root",
          ports: [
            { container: 22, host: 2200 },
            { container: 8443, host: 8443 },
          ],
          env: { SCHEDULING_MODE: "dynamic" },
          resource_profile: { cpu_limit: 4, memory_limit_bytes: 6 * GIB },
          labels: { disk_gb: "64" },
          capability_detail: { disk_gb: 64 },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        {
          deployment_id: "dep-builder",
          instance_id: "builder-a",
          host_id: "h1",
          role_id: "builder",
          status: "HEALTHY",
          actual_state: "RUNNING",
          display_name: "builder-a",
          scheduler_deployment_id: "dep-root",
          image: "docker.io/library/ubuntu@sha256:abc",
          ports: [{ container: 2222, host: 2222 }],
          volumes: [
            { name: "state", mount: "/opt/platform/state" },
            { name: "workspace", mount: "/srv/workspace" },
          ],
          resource_profile: { cpu_limit: 2, memory_limit_bytes: 4 * GIB },
          labels: { disk_gb: "128" },
          capability_detail: { cores: 2, disk_gb: 128 },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        {
          deployment_id: "dep-old",
          instance_id: "old-builder",
          host_id: "h1",
          role_id: "builder",
          status: "REMOVED",
          updated_at: "2026-01-03T00:00:00Z",
        },
        {
          deployment_id: "dep-hidden",
          instance_id: "hidden-builder",
          host_id: "h2",
          role_id: "builder",
          status: "HEALTHY",
          updated_at: "2026-01-03T00:00:00Z",
        },
      ],
    },
    instances: {
      items: [
        {
          instance_id: "builder-a",
          host_id: "h1",
          role_id: "builder",
          state: "ONLINE",
          last_heartbeat_at: NOW,
          config_version: 5,
          capability_score: 700,
          scheduling_mode: "dynamic",
          allowed_task_types: ["task.build", "task.chat.builder"],
          capabilities: { os: "ubuntu24.04" },
        },
        {
          instance_id: "sched-a",
          host_id: "h1",
          role_id: "scheduler",
          state: "ONLINE",
          last_heartbeat_at: NOW,
          allowed_task_types: ["task.chat.scheduler"],
        },
        {
          instance_id: "old-builder",
          host_id: "h1",
          role_id: "builder",
          state: "OFFLINE",
          last_heartbeat_at: "2020-01-01T00:00:00Z",
        },
        {
          instance_id: "legacy-worker",
          host_id: "h1",
          role_id: "worker",
          state: "ONLINE",
          last_heartbeat_at: NOW,
        },
      ],
    },
    tasks: {
      items: [
        {
          task_id: "t1",
          task_type: "task.build",
          status: "ASSIGNED",
          current_instance_id: "builder-a",
          priority_class: 0,
          difficulty: 600,
          attempt_count: 3,
          enqueued_at: "2026-01-01T00:00:00Z",
          requirements: { build: { title: "  Build the firmware\nsecond line" } },
          payload_ref: "admin://builds/1",
          approval_mode: "auto",
        },
        {
          task_id: "t1",
          task_type: "task.build",
          status: "ASSIGNED",
          requirements: { build: { title: "duplicate" } },
        },
        {
          task_id: "t3",
          task_type: "task.console.builder",
          status: "SUCCEEDED",
          current_instance_id: "builder-a",
          requirements: { console: { command: "ls -la" } },
          payload_ref: "admin://builds/3",
        },
        {
          task_id: "t4",
          task_type: "task.build",
          status: "RUNNING",
          requirements: { build: { instruction: "x".repeat(120) } },
          payload_ref: "admin://builds/4",
        },
        {
          task_id: "t5",
          task_type: "task.chat.scheduler",
          status: "QUEUED",
          target_role: "scheduler",
          payload_ref: "admin://builds/1799",
        },
        {
          task_id: "t6",
          task_type: "task.build",
          status: "WAITING_CHILDREN",
          relay: {
            child_node_id: "node-1",
            child_task_id: "child-1",
            state: "RUNNING",
          },
          requirements: { chat: { message: "hello" } },
        },
        {
          task_id: "t7",
          task_type: "task.console.scheduler",
          status: "NEEDS_INPUT",
          requirements: { console: { command: "uptime" } },
        },
        { task_id: "", task_type: "task.build", status: "QUEUED" },
      ],
    },
    agents: {
      agent_profiles: [
        {
          agent_profile_id: "ag-builder",
          role_id: "builder",
          name: "Claude builder",
          version: "1.0.0",
          adapter: "stdio-jsonrpc",
          capabilities: ["build"],
          limits: { max_turns: 10 },
          enabled: true,
        },
        {
          agent_profile_id: "ag-sched",
          role_id: "scheduler",
          name: "Scheduler agent",
          adapter: "http-local",
        },
        {
          agent_profile_id: "ag-legacy",
          role_id: "worker",
          name: "Legacy worker",
        },
      ],
    },
    apis: {
      api_profiles: [
        {
          api_profile_id: "api-1",
          name: "DeepSeek",
          kind: "llm",
          base_url: "https://api.example",
          auth_type: "bearer",
          secret_ref: "secret://deepseek",
          scopes: ["chat"],
          quota: { rpm: 100, tpm: 20000 },
          egress: "internet",
          timeout_seconds: 60,
          updated_at: "2026-01-01T00:00:00Z",
          created_at: "2025-01-01T00:00:00Z",
        },
      ],
    },
    bindings: {
      bindings: [
        {
          host_id: "h1",
          instance_id: "builder-a",
          agent_profile_id: "ag-builder",
          api_profile_ids: ["api-1"],
        },
      ],
    },
    sideloads: {
      sideloads: [
        {
          sideload_id: "sdl-1",
          host_id: "h1",
          name: "CI",
          token_hint: "…abcd",
          scopes: ["tasks:read", "tasks:write"],
          created_by: "ops",
          created_at: "2026-01-01T00:00:00Z",
          expires_at: null,
          last_seen_at: NOW,
          last_ip: "10.0.0.9",
          revoked_at: null,
        },
      ],
    },
    audits: {
      audit_logs: [
        {
          audit_id: "a1",
          operator_id: "ops",
          action: "deploy",
          subject: "builder-a",
          detail: { error: "boom", plan: "p1" },
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          audit_id: "a2",
          operator_id: "ops",
          action: "bind",
          subject: "builder-a",
          detail: "plain text",
          created_at: "2026-01-01T00:01:00Z",
        },
        {
          audit_id: "a3",
          operator_id: "ops",
          action: "probe",
          subject: "devbox",
          detail: null,
          created_at: "2026-01-01T00:02:00Z",
        },
      ],
    },
  };
}

function routes(overrides: Record<string, Route> = {}): Record<string, Route> {
  const f = fixtures();
  return {
    "/api/v1/platform/hosts": f.hosts,
    "/api/v1/platform/deployments": f.deployments,
    "/api/v1/platform/agent-profiles": f.agents,
    "/api/v1/platform/api-profiles": f.apis,
    "/api/v1/platform/bindings": f.bindings,
    "/api/v1/platform/audit-logs": f.audits,
    "/api/v1/platform/fleet": f.fleet,
    "/api/v1/platform/sideloads": f.sideloads,
    "/v1/instances": f.instances,
    "/v1/tasks?limit=300": f.tasks,
    ...overrides,
  };
}

beforeEach(() => {
  db.hosts.length = 0;
  db.instances.length = 0;
  db.agents.length = 0;
  db.apis.length = 0;
  db.tasks.length = 0;
  db.logs.length = 0;
  db.fleet = { hosts: [], total_score: 0, generated_at: "" };
  db.sideloads.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncLive", () => {
  it("maps hosts, fleet, instances, tasks, profiles and logs", async () => {
    const fetchMock = routeFetch(routes());
    vi.stubGlobal("fetch", fetchMock);

    const summary = await syncLive(connection);

    expect(summary).toMatchObject({ builders: 1, tasks: 6, logs: 3 });
    expect(Date.parse(summary.at)).not.toBeNaN();
    expect(fetchMock).toHaveBeenCalledTimes(11);

    // Hosts: REVOKED rows disappear.
    expect(db.hosts).toHaveLength(1);
    expect(db.hosts[0]).toMatchObject({
      id: "h1",
      name: "devbox",
      os: "Linux",
      arch: "x86_64",
      state: "ONLINE",
      cpu: 25,
      mem: 75,
      disk: 75,
      cpu_total: 8,
      mem_total_mb: 32768,
      mem_available_mb: 8192,
      labels: { zone: "lab", gpu: "0" },
      capabilities: ["docker", "git"],
      transport: "ssh",
      address: "10.0.0.8",
      ssh_port: 22,
      ssh_user: "root",
      role_mode: "scheduler",
      local_score: 800,
      subtree_score: 900,
    });

    // Fleet keeps its aggregated score.
    expect(db.fleet.total_score).toBe(900);
    expect(db.fleet.hosts[0]).toMatchObject({
      host_id: "h1",
      subtree_builder_count: 2,
      child_host_ids: ["h3"],
      depth: 0,
      is_root: true,
    });

    // Instances: builder + scheduler, sorted by host/instance scope.
    expect(db.instances.map((i) => i.key)).toEqual(["h1/builder-a", "h1/sched-a"]);
    const builder = db.instances[0];
    expect(builder).toMatchObject({
      id: "builder-a",
      name: "builder-a",
      role: "builder",
      os: "ubuntu24.04",
      host_id: "h1",
      ssh_host: "10.0.0.8",
      ssh_port: 2222,
      ssh_user: "root",
      workspace: "/srv/workspace",
      agent_profile_id: "ag-builder",
      api_profile_ids: ["api-1"],
      task_types: ["task.build", "task.chat.builder"],
      resource_profile: "2C / 4096MiB",
      cpu_limit: 2,
      mem_limit_mb: 4096,
      disk_gb: 128,
      state: "ONLINE",
      config_version: 5,
      capability_score: 700,
      scheduling_mode: "dynamic",
      scheduler_id: "dep-root",
      scheduler_instance_id: "sched-a",
      scheduler_deployment_id: "dep-root",
      deployment_id: "dep-builder",
      execution: "container",
    });
    // The deployment detail is preferred when both sides carry one.
    expect(builder.capability_detail).toEqual({ cores: 2, disk_gb: 128 });

    const scheduler = db.instances[1];
    expect(scheduler).toMatchObject({
      id: "sched-a",
      name: "root scheduler",
      role: "scheduler",
      os: undefined,
      ssh_port: 2200,
      port: 8443,
      cpu_limit: 4,
      mem_limit_mb: 6144,
      disk_gb: 64,
      state: "ONLINE",
      scheduling_mode: "dynamic",
      scheduler_role: "root",
      parent_scheduler_id: null,
      parent_scheduler_instance_id: undefined,
      scheduler_instance_id: "sched-a",
      scheduler_deployment_id: "dep-root",
      task_types: ["task.chat.scheduler"],
    });

    // Tasks: deduplicated by id, mapped to page states and readable titles.
    expect(db.tasks.map((t) => t.id)).toEqual(["t1", "t3", "t4", "t5", "t6", "t7"]);
    const [t1, t3, t4, t5, t6, t7] = db.tasks;
    expect(t1).toMatchObject({
      title: "Build the firmware",
      type: "task.build",
      stage: "ASSIGNED",
      target_role: "builder",
      priority: 0,
      difficulty: 600,
      state: "RUNNING",
      instance_id: "builder-a",
      attempts: 3,
      approval_mode: "auto",
      scheduler_deployment_id: "dep-root",
      scheduler_instance_id: "sched-a",
    });
    expect(t3).toMatchObject({
      title: "ls -la",
      state: "SUCCEEDED",
      target_role: "builder",
    });
    expect(t4.title).toBe(`${"x".repeat(80)}…`);
    expect(t5).toMatchObject({
      title: "1799",
      state: "QUEUED",
      target_role: "scheduler",
    });
    expect(t6).toMatchObject({
      title: "hello",
      state: "WAITING_CHILDREN",
      relay: { child_node_id: "node-1", child_task_id: "child-1", state: "RUNNING" },
    });
    expect(t7).toMatchObject({ title: "uptime", state: "NEEDS_INPUT", target_role: "scheduler" });

    // Profiles: legacy roles are filtered out of the binding choices.
    expect(db.agents.map((a) => a.id)).toEqual(["ag-builder", "ag-sched"]);
    expect(db.agents[0]).toMatchObject({
      name: "Claude builder",
      role: "builder",
      adapter: "stdio-jsonrpc",
      capabilities: ["build"],
      limits: { max_turns: 10 },
      enabled: true,
    });
    expect(db.apis[0]).toMatchObject({
      id: "api-1",
      quota: "rpm=100 · tpm=20000",
      egress: "internet",
      timeout_seconds: 60,
      rotated_at: "2026-01-01T00:00:00Z",
    });

    expect(db.sideloads[0]).toMatchObject({
      sideload_id: "sdl-1",
      host_id: "h1",
      scopes: ["tasks:read", "tasks:write"],
      last_seen_at: NOW,
    });

    expect(db.logs.map((l) => l.id)).toEqual(["pcs_a1", "pcs_a2", "pcs_a3"]);
    expect(db.logs[0]).toMatchObject({ result: "FAILED", detail: "error=boom · plan=p1" });
    expect(db.logs[1]).toMatchObject({ result: "OK", detail: "plain text" });
    expect(db.logs[2]).toMatchObject({ result: "OK", detail: "" });
  });

  it("rejects when the control plane is unreachable and keeps the previous view", async () => {
    (db.hosts as Array<{ id: string }>).push({ id: "kept" });
    vi.stubGlobal(
      "fetch",
      routeFetch(
        routes({
          "/api/v1/platform/hosts": () => Promise.reject(new Error("pcs down")),
        }),
      ),
    );

    await expect(syncLive(connection)).rejects.toThrow("pcs down");
    expect(db.hosts).toHaveLength(1);
    expect(db.hosts[0].id).toBe("kept");
  });

  it("still builds instances from the control plane when the scheduler is down", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch(
        routes({
          "/v1/instances": () => Promise.reject(new Error("scheduler down")),
          "/v1/tasks?limit=300": () => Promise.reject(new Error("scheduler down")),
        }),
      ),
    );

    const summary = await syncLive(connection);

    expect(summary).toMatchObject({ builders: 1, tasks: 0 });
    expect(db.hosts).toHaveLength(1);
    expect(db.instances.map((i) => i.id)).toEqual(["builder-a", "sched-a"]);
    expect(db.tasks).toEqual([]);
  });

  it("falls back to the default scheduler when no deployment is known", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch(
        routes({
          "/api/v1/platform/deployments": { deployments: [] },
        }),
      ),
    );

    const summary = await syncLive(connection);

    // Without deployment records the removed-builder marker is unavailable, so the stale OFFLINE row remains visible.
    expect(summary).toMatchObject({ builders: 2, tasks: 6 });
    expect(db.instances.map((i) => i.id)).toEqual(["builder-a", "old-builder", "sched-a"]);
    expect(db.tasks[0]).toMatchObject({
      id: "t1",
      scheduler_deployment_id: null,
      scheduler_instance_id: null,
    });
  });
});

describe("task detail fetchers", () => {
  it("maps attempts and fan-out children", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/v1/tasks/t%2F1": {
          attempts: [
            {
              attempt_number: 1,
              status: "FAILED",
              error: { code: "BUILD_FAILED", message: "gcc not found" },
              failure_class: "permanent",
              failure_signature: "missing-gcc",
              started_at: "2026-01-01T00:00:00Z",
              finished_at: "2026-01-01T00:01:00Z",
            },
            { attempt_number: 2, status: "SUCCEEDED" },
          ],
          children: [
            {
              task_id: "child-1",
              task_type: "task.build",
              status: "ASSIGNED",
              outcome: "completed",
              title: "child",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:01:00Z",
            },
          ],
        },
      }),
    );

    const attempts = await fetchTaskAttempts(connection, "t/1", "dep-root");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      attempt_number: 1,
      status: "FAILED",
      error: { code: "BUILD_FAILED", message: "gcc not found" },
      failure_class: "permanent",
      failure_signature: "missing-gcc",
    });
    expect(attempts[1]).toMatchObject({ error: null, failure_class: null });

    const detail = await fetchTaskDetail(connection, "t/1", "dep-root");
    expect(detail.attempts).toHaveLength(2);
    expect(detail.children[0]).toMatchObject({
      task_id: "child-1",
      status: "RUNNING",
      outcome: "completed",
      title: "child",
    });
  });

  it("maps failure signatures and task events", async () => {
    const fetchMock = routeFetch({
      "/events": {
        items: [
          {
            created_at: "2026-01-01T00:00:00Z",
            event_type: "state",
            payload: { from: "QUEUED" },
          },
          {
            created_at: "2026-01-01T00:01:00Z",
            event_type: "state",
            payload: null,
            from_status: "QUEUED",
            to_status: "RUNNING",
          },
        ],
      },
      "/v1/failure-signatures": {
        items: [
          {
            signature: "missing-gcc",
            kind: "build",
            code: "BUILD_FAILED",
            sample: "gcc: not found",
            occurrences: 3,
            first_seen_at: "2026-01-01T00:00:00Z",
            last_seen_at: "2026-01-02T00:00:00Z",
          },
        ],
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const signatures = await fetchFailureSignatures(connection, "dep-root", 7);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("/v1/failure-signatures?limit=7");
    expect(signatures[0]).toMatchObject({
      signature: "missing-gcc",
      kind: "build",
      code: "BUILD_FAILED",
      occurrences: 3,
    });

    const events = await fetchTaskEvents(connection, "t1", "dep-root");
    expect(events).toEqual([
      { at: "2026-01-01T00:00:00Z", type: "state", message: '{"from":"QUEUED"}' },
      { at: "2026-01-01T00:01:00Z", type: "state", message: "QUEUED → RUNNING" },
    ]);
  });
});
