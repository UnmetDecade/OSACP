import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerTask,
  bindAgentProfile,
  cancelTask,
  createAgentProfile,
  createApiProfile,
  createBuilder,
  createScheduler,
  instanceAction,
  retryTask,
  setApiProfileSecret,
  submitBuild,
  testConnection,
  unbindAgentProfile,
  uploadTaskAttachment,
} from "./actions";
import { defaultConnection, type LiveConnection } from "./config";

const connection: LiveConnection = {
  ...defaultConnection(),
  adminToken: "test-token",
  operator: "ops",
};

const MIB = 1024 ** 2;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** Default control-plane responses: every plan creation is followed by applying plan-1. */
function plans(overrides: Array<[string, unknown]> = []): Handler {
  return (url) => {
    for (const [fragment, body] of overrides) {
      if (url.includes(fragment)) return json(body);
    }
    if (url.includes("/deployment-plans/") && url.endsWith("/apply")) return json({ ok: true });
    if (url.endsWith("/deployment-plans")) {
      return json({ plan_id: "plan-1", plan_digest: "digest-1" });
    }
    return json({});
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connection and host actions", () => {
  it("treats the control plane as optional during connection test", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes("/healthz")) return json({ ok: true });
      return json({ error: { message: "pcs down" } }, 503);
    });
    await expect(testConnection(connection)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails the connection test when the scheduler is unreachable", async () => {
    stubFetch(() => json({ error: { message: "nope" } }, 503));
    await expect(testConnection(connection)).rejects.toThrow("nope");
  });
});

describe("createScheduler", () => {
  it("plans a root scheduler and applies the plan digest", async () => {
    const fetchMock = stubFetch(plans());
    await createScheduler(connection, {
      host_id: "h1",
      name: "root scheduler",
      role: "root",
      agent_profile_id: "ag-sched",
      api_profile_ids: ["api-1"],
      port: 8443,
      ssh_port: 2200,
      cpus: 4,
      mem_mb: 6144,
      scheduling_mode: "dynamic",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [planUrl, planInit] = fetchMock.mock.calls[0];
    expect(String(planUrl)).toBe("/api/pcs/api/v1/platform/deployment-plans");
    expect(planInit?.method).toBe("POST");
    const body = bodyOf(planInit!);
    expect(body).toMatchObject({
      host_id: "h1",
      role_id: "scheduler",
      scheduler_role: "root",
      count: 1,
      display_name: "root scheduler",
      agent_profile_id: "ag-sched",
      api_profile_ids: ["api-1"],
      ports: [
        { container: 22, host: 2200 },
        { container: 8443, host: 8443 },
      ],
      env: { HOST: "0.0.0.0", PORT: "8443", SCHEDULER_HOST_ID: "h1" },
      resource_profile: { cpu_limit: 4, memory_limit_bytes: 6144 * MIB, pids_limit: 512 },
      network_policy: "default",
      labels: { role: "scheduler" },
      scheduling_mode: "dynamic",
    });
    expect(body).not.toHaveProperty("parent_scheduler_id");

    const [applyUrl, applyInit] = fetchMock.mock.calls[1];
    expect(String(applyUrl)).toBe(
      "/api/pcs/api/v1/platform/deployment-plans/plan-1/apply",
    );
    expect(applyInit?.method).toBe("POST");
    expect(bodyOf(applyInit!)).toEqual({ plan_digest: "digest-1" });
  });

  it("links a node scheduler to its parent and inherits the mode", async () => {
    const fetchMock = stubFetch(plans());
    await createScheduler(connection, {
      host_id: "h1",
      name: "node-a",
      role: "node",
      parent_scheduler_id: "dep-root",
      agent_profile_id: "ag-sched",
      api_profile_ids: [],
      port: 8543,
      ssh_port: 2300,
      cpus: 2,
      mem_mb: 2048,
      scheduling_mode: "dynamic",
    });

    const body = bodyOf(fetchMock.mock.calls[0][1]!);
    expect(body).toMatchObject({
      scheduler_role: "node",
      parent_scheduler_id: "dep-root",
    });
    expect(body).not.toHaveProperty("scheduling_mode");
  });

  it("refuses to plan without a control plane", async () => {
    await expect(
      createScheduler(
        { ...connection, pcsUrl: "" },
        {
          host_id: "h1",
          name: "root",
          role: "root",
          agent_profile_id: "",
          api_profile_ids: [],
          port: 8443,
          ssh_port: 2200,
          cpus: 2,
          mem_mb: 2048,
        },
      ),
    ).rejects.toThrow();
  });
});

describe("createBuilder", () => {
  it("clamps the count and persists the runtime volumes and capability detail", async () => {
    const fetchMock = stubFetch(plans());
    await createBuilder(connection, {
      host_id: "h1",
      os: "ubuntu24.04",
      count: 9,
      tier: "large",
      cpus: 8,
      mem_mb: 8192,
      disk_gb: 256,
      agent_profile_id: "ag-builder",
      api_profile_ids: ["api-1"],
      image: "ubuntu@sha256:abc",
      scheduler_id: "dep-root",
      ports: [{ container: 2222, host: 2222 }],
      capability_detail: { cores: 8, mem_gb: 8, disk_gb: 256 },
    });

    const body = bodyOf(fetchMock.mock.calls[0][1]!);
    expect(body).toMatchObject({
      host_id: "h1",
      role_id: "builder",
      count: 4,
      agent_profile_id: "ag-builder",
      api_profile_ids: ["api-1"],
      image: "ubuntu@sha256:abc",
      builder_os: "ubuntu24.04",
      scheduler_id: "dep-root",
      ports: [{ container: 2222, host: 2222 }],
      volumes: [
        { name: "state", mount: "/opt/platform/state" },
        { name: "shared-apt-cache", mount: "/opt/platform/apt-cache" },
      ],
      resource_profile: {
        cpu_limit: 8,
        memory_limit_bytes: 8192 * MIB,
        pids_limit: 1024,
      },
      labels: { os: "ubuntu24.04", disk_gb: "256", tier: "large" },
      capability_detail: { cores: 8, mem_gb: 8, disk_gb: 256 },
    });
    expect(body).not.toHaveProperty("display_name");
  });

  it("omits optional fields and uses the smaller pids limit", async () => {
    const fetchMock = stubFetch(plans());
    await createBuilder(connection, {
      host_id: "h1",
      name: "builder-a",
      os: "ubuntu22.04",
      count: 0,
      cpus: 2,
      mem_mb: 2048,
      disk_gb: 40,
      agent_profile_id: "",
      api_profile_ids: [],
      image: "ubuntu@sha256:abc",
    });

    const body = bodyOf(fetchMock.mock.calls[0][1]!);
    expect(body).toMatchObject({
      display_name: "builder-a",
      count: 1,
      resource_profile: { pids_limit: 512 },
    });
    expect(body).not.toHaveProperty("scheduler_id");
    expect(body).not.toHaveProperty("capability_detail");
  });
});

describe("task submission and lifecycle", () => {
  it("clamps priority and difficulty and submits through the owning scheduler", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes("/v1/tasks")) return json({ task_id: "task-1" });
      return json({});
    });
    const attachments = [
      {
        attachment_id: "att-1",
        name: "data.csv",
        media_type: "text/csv",
        size: 3,
        url: "https://pcs/att-1",
      },
    ];

    const out = await submitBuild(connection, {
      title: "Build",
      instruction: "make",
      target_instance_id: "builder-a",
      priority: 9,
      difficulty: 5000,
      schedulerDeploymentId: "dep/root",
      attachments,
      approval_mode: "auto",
    });

    expect(out).toEqual({ task_id: "task-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "/api/pcs/api/v1/platform/schedulers/dep%2Froot/proxy/v1/tasks",
    );
    const body = bodyOf(init!);
    expect(body).toMatchObject({
      task_type: "task.build",
      priority_class: 3,
      difficulty: 1000,
      max_attempts: 2,
      approval_mode: "auto",
      requirements: {
        target_instance_id: "builder-a",
        build: {
          title: "Build",
          instruction: "make",
          attachments,
        },
      },
    });
    expect(String(body.trace_id)).toMatch(/^build_/);
    expect(String(body.payload_ref)).toMatch(/^admin:\/\/builds\//);
    expect(Date.parse(String(body.deadline_at))).toBeGreaterThan(Date.now());
  });

  it("omits difficulty when it is zero and falls back to the default scheduler", async () => {
    const fetchMock = stubFetch(() => json({ task_id: "task-2" }));
    await submitBuild(connection, {
      title: "T",
      instruction: "I",
      priority: -1,
      difficulty: 0,
      schedulerDeploymentId: null,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/scheduler/v1/tasks");
    const body = bodyOf(init!);
    expect(body.priority_class).toBe(0);
    expect(body).not.toHaveProperty("difficulty");
    expect(body).not.toHaveProperty("approval_mode");
    expect(body.requirements).not.toHaveProperty("target_instance_id");
  });

  it("sends the operator with cancel, retry and answer", async () => {
    const fetchMock = stubFetch(() => json({ ok: true }));

    await cancelTask(connection, "t/1", "dep-root");
    await retryTask(connection, "t/1", "dep-root");
    await answerTask(connection, "t/1", "yes", "dep-root");

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: bodyOf(init!),
    }));
    expect(calls).toEqual([
      {
        url: "/api/pcs/api/v1/platform/schedulers/dep-root/proxy/v1/tasks/t%2F1/cancel",
        method: "POST",
        body: { actor: "ops" },
      },
      {
        url: "/api/pcs/api/v1/platform/schedulers/dep-root/proxy/v1/tasks/t%2F1/retry",
        method: "POST",
        body: { actor: "ops" },
      },
      {
        url: "/api/pcs/api/v1/platform/schedulers/dep-root/proxy/v1/tasks/t%2F1/answer",
        method: "POST",
        body: { answer: "yes", actor: "ops" },
      },
    ]);
  });
});

describe("attachments", () => {
  it("uploads content and normalizes the returned reference", async () => {
    const fetchMock = stubFetch(() =>
      json({
        attachment_id: "att-1",
        name: "diagram.png",
        media_type: "image/png",
        size: 12,
        url: "https://pcs/att-1",
      }),
    );

    const ref = await uploadTaskAttachment(connection, {
      name: "diagram.png",
      media_type: "image/png",
      size: 12,
      data_base64: "aGVsbG8=",
    });

    expect(ref).toEqual({
      attachment_id: "att-1",
      name: "diagram.png",
      media_type: "image/png",
      size: 12,
      url: "https://pcs/att-1",
    });
    expect(bodyOf(fetchMock.mock.calls[0][1]!)).toEqual({
      name: "diagram.png",
      media_type: "image/png",
      data_base64: "aGVsbG8=",
    });
  });

  it("falls back to local fields when the control plane omits them", async () => {
    stubFetch(() => json({}));
    const ref = await uploadTaskAttachment(connection, {
      name: "note.txt",
      media_type: "text/plain",
      size: 5,
      data_base64: "aGVsbG8=",
    });
    expect(ref).toEqual({
      attachment_id: "",
      name: "note.txt",
      media_type: "text/plain",
      size: 5,
      url: "",
    });
  });
});

describe("instanceAction", () => {
  const deployments = {
    deployments: [
      {
        deployment_id: "dep-old",
        instance_id: "builder-a",
        host_id: "h1",
        status: "HEALTHY",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        deployment_id: "dep-new",
        instance_id: "builder-a",
        host_id: "h1",
        status: "HEALTHY",
        updated_at: "2026-01-02T00:00:00Z",
      },
      {
        deployment_id: "dep-other-host",
        instance_id: "builder-a",
        host_id: "h2",
        status: "HEALTHY",
        updated_at: "2026-01-03T00:00:00Z",
      },
      {
        deployment_id: "dep-removed",
        instance_id: "builder-a",
        host_id: "h1",
        status: "REMOVED",
        updated_at: "2026-01-04T00:00:00Z",
      },
    ],
  };

  it("acts on the newest live deployment for the requested host", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith("/api/v1/platform/deployments")) return json(deployments);
      return json({ ok: true });
    });

    await instanceAction(connection, "builder-a", "restart", "h1");

    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "/api/pcs/api/v1/platform/deployments/dep-new/restart",
    );
  });

  it("maps drain to stop", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith("/api/v1/platform/deployments")) return json(deployments);
      return json({ ok: true });
    });

    await instanceAction(connection, "builder-a", "drain", "h1");

    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "/api/pcs/api/v1/platform/deployments/dep-new/stop",
    );
  });

  it("clears a stale scheduler registration when only a remove is requested", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith("/api/v1/platform/deployments")) return json({ deployments: [] });
      return json({ error: { message: "unknown instance", code: "INSTANCE_UNKNOWN" } }, 404);
    });

    await expect(instanceAction(connection, "gone", "remove", "h1")).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[1][0])).toBe("/api/scheduler/v1/instances/gone");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
  });

  it("refuses other actions when there is no deployment", async () => {
    stubFetch(() => json({ deployments: [] }));
    await expect(instanceAction(connection, "gone", "start", "h1")).rejects.toThrow(
      /gone/,
    );
  });
});

describe("profiles", () => {
  it("creates an agent profile with the role task types", async () => {
    const fetchMock = stubFetch(() => json({ agent_profile_id: "ag-new" }));
    const out = await createAgentProfile(connection, {
      role_id: "builder",
      name: "Builder agent",
      version: "1.0.0",
      adapter: "stdio-jsonrpc",
      capabilities: ["build"],
      entrypoint: ["agent"],
    });

    expect(out).toEqual({ agent_profile_id: "ag-new" });
    const body = bodyOf(fetchMock.mock.calls[0][1]!);
    expect(body).toMatchObject({
      role_id: "builder",
      name: "Builder agent",
      adapter: "stdio-jsonrpc",
      task_types: ["task.build", "task.chat.builder", "task.console.builder"],
      entrypoint: ["agent"],
      args: [],
      artifact_image: "",
      model_api_profile_id: null,
      limits: {},
    });
  });

  it("creates an API profile with defaults", async () => {
    const fetchMock = stubFetch(() => json({ api_profile_id: "api-new" }));
    await createApiProfile(connection, {
      name: "DeepSeek",
      kind: "llm",
      base_url: "https://api.example",
      secret_ref: "secret://deepseek",
    });

    expect(bodyOf(fetchMock.mock.calls[0][1]!)).toEqual({
      name: "DeepSeek",
      kind: "llm",
      base_url: "https://api.example",
      auth_type: "bearer",
      secret_ref: "secret://deepseek",
      scopes: [],
      egress: null,
    });
  });

  it("writes a secret and binds/unbinds profiles by host scope", async () => {
    const fetchMock = stubFetch(() => json({ ok: true, secret_ref: "secret://api-1" }));

    const out = await setApiProfileSecret(connection, "api-1", "value");
    await bindAgentProfile(connection, "h1", "builder-a", "ag-1", "builder");
    await unbindAgentProfile(connection, "h1", "builder-a");

    expect(out).toEqual({ ok: true, secret_ref: "secret://api-1" });
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: init?.body ? bodyOf(init) : undefined,
    }));
    expect(calls).toEqual([
      {
        url: "/api/pcs/api/v1/platform/api-profiles/api-1/secret",
        method: "PUT",
        body: { value: "value" },
      },
      {
        url: "/api/pcs/api/v1/platform/instances/builder-a/bind-agent",
        method: "POST",
        body: { host_id: "h1", agent_profile_id: "ag-1", role_id: "builder" },
      },
      {
        url: "/api/pcs/api/v1/platform/instances/builder-a/bind-agent?host_id=h1",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });
});
