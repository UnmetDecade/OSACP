import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { AgentProfile, ApiProfile } from "../src/agent-runtime/types.js";
import {
  assertEnvelopeAllowed,
  ProfileRejected,
  resolveInstanceProfiles,
  type RuntimeProfiles,
} from "../src/agent-runtime/profiles.js";
import { assertEgressAllowed, EgressDenied, isBlockedIp } from "../src/agent-runtime/egress.js";
import { ToolDenied, ToolGuard, type ToolAuditRecord } from "../src/agent-runtime/tool-policy.js";
import { ApiAdapter, ApiAdapterError } from "../src/agent-runtime/api-adapter.js";
import { runAgentTask } from "../src/agent-runtime/agent-executor.js";
import { TaskFailed, type ExecContext } from "../src/exec-types.js";
import type { Assignment } from "../src/client.js";
import { SecretDenied, type SecretClient } from "../src/agent-runtime/secret-client.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-test-"));
// Use the repo's agents/ by default; set AGENT_FILE to override when the test machine syncs it elsewhere
const AGENT_FILE =
  process.env.AGENT_FILE ?? path.resolve(process.cwd(), "..", "agents", "demo-agent.mjs");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function agentProfile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agent_profile_id: "agp_test",
    role_id: "builder",
    name: "test-agent",
    version: "1.0.0",
    adapter: "stdio-jsonrpc",
    entrypoint: [process.execPath, AGENT_FILE, "--marker=alpha"],
    args: [],
    allowed_tools: ["demo.echo", "api.call", "workspace.write", "workspace.read"],
    task_types: ["task.agent.probe"],
    limits: { max_wall_seconds: 20, max_turns: 10 },
    ...over,
  };
}

function apiProfile(over: Partial<ApiProfile> = {}): ApiProfile {
  return {
    api_profile_id: "api_test",
    name: "test-api",
    kind: "http",
    base_url: "https://api.example",
    auth_type: "bearer",
    secret_ref: "secret://apis/test",
    scopes: ["probe.read"],
    quota: {},
    timeout_seconds: 5,
    egress: "egress-test",
    fallback: [],
    ...over,
  };
}

function runtimeProfiles(over: Partial<RuntimeProfiles> = {}): RuntimeProfiles {
  const agent = over.agent ?? agentProfile();
  const api = over.api ?? new Map([["api_test", apiProfile()]]);
  return { agent, api, boundApiIds: new Set(api.keys()) };
}

function assignment(over: Partial<Assignment> = {}): Assignment {
  return {
    task_id: "task_p4",
    task_type: "task.agent.probe",
    attempt_id: "att_p4",
    attempt_number: 1,
    lease_token: "lease",
    fencing_token: 1,
    lease_expires_at: "",
    grant_id: "rgr",
    payload_ref: null,
    payload_schema: "1.0",
    resource_profile_id: "rp",
    deadline_at: null,
    requirements: {},
    agent: { profile_id: "agp_test", version: "1.0.0" },
    api_profiles: ["api_test"],
    ...over,
  };
}

function ctxFor(workspace: string): {
  ctx: ExecContext;
  uploads: Array<{ name: string; data: Buffer }>;
} {
  const uploads: Array<{ name: string; data: Buffer }> = [];
  return {
    uploads,
    ctx: {
      signal: new AbortController().signal,
      log: () => {},
      progress: () => {},
      instanceId: "builder-a",
      workspaceDir: workspace,
      uploadArtifact: async (content) => {
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
        const sha256 = `sha256:${"0".repeat(64)}`;
        uploads.push({ name: String(uploads.length), data });
        return { artifact_id: `art_${uploads.length}`, sha256, size_bytes: data.length };
      },
      downloadArtifact: async () => {
        throw new Error("not used");
      },
    },
  };
}

function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; seen: http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const fakeSecret = {
  resolve: async () => ({ credential: "s3cr3t-token", expiresAt: Date.now() + 60_000 }),
  invalidate: () => {},
} as unknown as SecretClient;

// ---------------------------------------------------------------- profiles

describe("Profile binding validation", () => {
  it("only bound Agents and APIs are allowed, and the envelope version must match", () => {
    const file = {
      agent_profiles: [agentProfile()],
      api_profiles: [apiProfile()],
      bindings: { "builder-a": { agent_profile_id: "agp_test", api_profile_ids: ["api_test"] } },
    };
    const p = resolveInstanceProfiles(file as any, {
      instance_id: "builder-a",
      role_id: "builder",
      host_id: "host-a",
      agent_profile_id: "agp_test",
      api_profile_ids: ["api_test"],
      task_types: ["task.agent.probe"],
      capabilities: { healthy: [] },
    });
    assertEnvelopeAllowed(p, { agent: { profile_id: "agp_test", version: "1.0.0" }, api_profiles: ["api_test"] });

    assert.throws(
      () => assertEnvelopeAllowed(p, { agent: { profile_id: "agp_other", version: "1.0.0" } }),
      (e: any) => e instanceof ProfileRejected && e.code === "AGENT_PROFILE_NOT_ALLOWED",
    );
    assert.throws(
      () => assertEnvelopeAllowed(p, { agent: { profile_id: "agp_test", version: "2.0.0" } }),
      (e: any) => e.code === "AGENT_PROFILE_NOT_ALLOWED",
    );
    assert.throws(
      () => assertEnvelopeAllowed(p, { agent: { profile_id: "agp_test", version: "1.0.0" }, api_profiles: ["api_other"] }),
      (e: any) => e.code === "API_PROFILE_NOT_ALLOWED",
    );
  });

  it("cross-role, invalid Adapter, and instance loading of an unbound API are all rejected", () => {
    const file = {
      agent_profiles: [agentProfile({ role_id: "scheduler", adapter: "http-local" as const })],
      api_profiles: [apiProfile()],
    };
    const base = {
      instance_id: "builder-a",
      role_id: "builder",
      host_id: "host-a",
      agent_profile_id: "agp_test",
      api_profile_ids: [] as string[],
      task_types: ["task.agent.probe"],
      capabilities: { healthy: [] },
    };
    assert.throws(
      () => resolveInstanceProfiles(file as any, base),
      (e: any) => e.code === "AGENT_PROFILE_NOT_ALLOWED",
    );
    assert.throws(
      () =>
        resolveInstanceProfiles(
          {
            agent_profiles: [agentProfile({ tool_api_profile_ids: ["api_missing"] })],
            api_profiles: [apiProfile()],
          } as any,
          { ...base, api_profile_ids: ["api_test"] },
        ),
      (e: any) => e.code === "API_PROFILE_NOT_ALLOWED",
    );
  });
});

// ---------------------------------------------------------------- egress

describe("outbound traffic is denied by default", () => {
  it("metadata, private networks, unlisted destinations, and invalid protocols are blocked", async () => {
    assert.equal(isBlockedIp("169.254.169.254"), true);
    assert.equal(isBlockedIp("10.1.2.3"), true);
    assert.equal(isBlockedIp("127.0.0.1"), true);
    assert.equal(isBlockedIp("127.0.0.1", true), false);
    assert.equal(isBlockedIp("93.184.216.34"), false);

    const opts = { policies: { egress: ["93.184.216.34", "*.trusted.test"] }, allowLoopback: false };
    await assert.doesNotReject(() =>
      assertEgressAllowed(new URL("https://93.184.216.34/v1"), "egress", opts),
    );
    await assert.rejects(
      () => assertEgressAllowed(new URL("https://evil.example/v1"), "egress", opts),
      (e: any) => e instanceof EgressDenied && e.code === "EGRESS_HOST_NOT_ALLOWED",
    );
    await assert.rejects(
      () => assertEgressAllowed(new URL("https://93.184.216.34/v1"), null, opts),
      (e: any) => e.code === "EGRESS_POLICY_REQUIRED",
    );
    await assert.rejects(
      () => assertEgressAllowed(new URL("http://93.184.216.34/v1"), "egress", opts),
      (e: any) => e.code === "EGRESS_SCHEME_DENIED",
    );
    await assert.rejects(
      () => assertEgressAllowed(new URL("https://169.254.169.254/latest"), "egress", { policies: { egress: ["169.254.169.254"] } }),
      (e: any) => e.code === "EGRESS_IP_BLOCKED",
    );
  });
});

// ---------------------------------------------------------------- tool policy

describe("the Tool Policy Guard has a fixed seven-step flow", () => {
  function guard(over: Partial<ConstructorParameters<typeof ToolGuard>[0]> = {}) {
    const audits: ToolAuditRecord[] = [];
    const g = new ToolGuard({
      instanceId: "builder-a",
      attemptId: "att_p4",
      taskId: "task_p4",
      workspace: TMP,
      profile: agentProfile(),
      apiProfiles: new Map([["api_test", apiProfile()]]),
      phase: "EXECUTE",
      approvedActionScope: [],
      toolToken: "tok",
      audit: (r) => audits.push(r),
      maxTurns: 20,
      ...over,
    });
    return { g, audits };
  }

  it("identity, allowlist, unknown tool, stage, path, idempotency, audit", async () => {
    const { g, audits } = guard();
    await assert.rejects(
      () => g.call({ tool_id: "demo.echo", args: { text: "x" }, tool_token: "wrong" }),
      (e: any) => e instanceof ToolDenied && e.code === "TOOL_IDENTITY_MISMATCH",
    );
    await assert.rejects(
      () => g.call({ tool_id: "demo.forbidden", args: {}, tool_token: "tok" }),
      (e: any) => e.code === "TOOL_NOT_ALLOWED",
    );
    await assert.rejects(
      () => g.call({ tool_id: "demo.echo", args: { text: 1 }, tool_token: "tok" }),
      (e: any) => e.code === "TOOL_INPUT_INVALID",
    );
    const ok = await g.call({ tool_id: "demo.echo", args: { text: "hi" }, tool_token: "tok" });
    assert.equal((ok as any).echo, "hi");

    await assert.rejects(
      () => g.call({ tool_id: "api.call", args: { api_profile_id: "api_other", method: "GET", path: "/" }, tool_token: "tok" }),
      (e: any) => e.code === "API_PROFILE_NOT_ALLOWED",
    );
    assert.ok(audits.some((a) => a.decision === "ALLOW" && a.tool_id === "demo.echo"));
    assert.ok(audits.some((a) => a.decision === "DENY" && a.code === "TOOL_NOT_ALLOWED"));
    assert.ok(audits.every((a) => !JSON.stringify(a).includes("hi")));
  });

  it("empty permissions mean all tools; an explicit list allows only the listed tools", async () => {
    const open = guard({ profile: { ...agentProfile(), allowed_tools: [] } });
    const ok = await open.g.call({ tool_id: "demo.echo", args: { text: "hi" }, tool_token: "tok" });
    assert.equal((ok as any).echo, "hi");

    const restricted = guard({
      profile: { ...agentProfile(), allowed_tools: ["workspace.read"] },
    });
    await assert.rejects(
      () => restricted.g.call({ tool_id: "demo.echo", args: { text: "hi" }, tool_token: "tok" }),
      (e: any) => e.code === "TOOL_NOT_ALLOWED",
    );
  });

  it("workspace path escapes are rejected", async () => {
    const { g } = guard();
    for (const p of ["../escape", "/etc/passwd", "a/../../b"]) {
      await assert.rejects(
        () => g.call({ tool_id: "workspace.write", args: { path: p, content: "x" }, tool_token: "tok" }),
        (e: any) => e.code === "WORKSPACE_PATH_DENIED" || e.code === "TOOL_INPUT_INVALID",
      );
    }
  });

  it("an idempotency key is reused for identical arguments and rejected for different ones", async () => {
    const { g } = guard();
    const a = await g.call({ tool_id: "demo.echo", args: { text: "a" }, tool_token: "tok", idempotency_key: "k1" });
    const b = await g.call({ tool_id: "demo.echo", args: { text: "a" }, tool_token: "tok", idempotency_key: "k1" });
    assert.deepEqual(a, b);
    await assert.rejects(
      () => g.call({ tool_id: "demo.echo", args: { text: "b" }, tool_token: "tok", idempotency_key: "k1" }),
      (e: any) => e.code === "TOOL_IDEMPOTENCY_CONFLICT",
    );
  });

  it("exceeding max_turns is rejected", async () => {
    const { g } = guard({ maxTurns: 1 });
    await g.call({ tool_id: "demo.echo", args: { text: "1" }, tool_token: "tok" });
    await assert.rejects(
      () => g.call({ tool_id: "demo.echo", args: { text: "2" }, tool_token: "tok" }),
      (e: any) => e.code === "TOOL_TURN_LIMIT",
    );
  });
});

// ---------------------------------------------------------------- API adapter

describe("API Adapter local proxy", () => {
  it("auth headers are injected, Agent-supplied auth headers are dropped, and bodies are not logged", async () => {
    const up = await startUpstream((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
    });
    const audits: any[] = [];
    const adapter = new ApiAdapter({
      instanceId: "builder-a",
      profiles: new Map([
        ["api_test", apiProfile({ base_url: up.url, egress: "egress-local", quota: {} })],
      ]),
      secretClient: fakeSecret,
      egress: { policies: { "egress-local": ["127.0.0.1"] }, allowLoopback: true },
      port: 0,
      audit: (r) => audits.push(r),
    });
    await adapter.start();
    const out = await adapter.call("api_test", "GET", "/whoami", {
      headers: { authorization: "Bearer attacker-token", cookie: "x=y" },
    });
    assert.equal(out.status, 200);
    assert.equal(JSON.parse(out.body.toString()).auth, "Bearer s3cr3t-token");
    assert.ok(up.seen[0].authorization === "Bearer s3cr3t-token");
    assert.equal(up.seen[0].cookie, undefined);
    assert.ok(audits.length === 1);
    assert.ok(!JSON.stringify(audits).includes("s3cr3t-token"));
    await adapter.close();
    await up.close();
  });

  it("an unbound API returns 403, unauthorized egress is rejected, and quota returns 429", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    const adapter = new ApiAdapter({
      instanceId: "builder-a",
      profiles: new Map([
        [
          "api_test",
          apiProfile({ base_url: up.url, egress: "egress-local", quota: { rpm: 1 } }),
        ],
      ]),
      secretClient: fakeSecret,
      egress: { policies: { "egress-local": ["127.0.0.1"] }, allowLoopback: true },
      port: 0,
    });
    await adapter.start();
    await assert.rejects(
      () => adapter.call("api_missing", "GET", "/", {}),
      (e: any) => e instanceof ApiAdapterError && e.status === 403,
    );
    // First succeeds; the second is rejected by rpm=1
    const first = await adapter.call("api_test", "GET", "/first", {});
    assert.equal(first.status, 200);
    let second: any = null;
    try {
      await adapter.call("api_test", "GET", "/second", {});
    } catch (e) {
      second = e;
    }
    assert.ok(second instanceof ApiAdapterError && second.status === 429);
    await adapter.close();

    const blocked = new ApiAdapter({
      instanceId: "builder-a",
      profiles: new Map([["api_test", apiProfile({ base_url: up.url, egress: "egress-other" })]]),
      secretClient: fakeSecret,
      egress: { policies: { "egress-other": ["example.com"] }, allowLoopback: true },
      port: 0,
    });
    await blocked.start();
    await assert.rejects(
      () => blocked.call("api_test", "GET", "/", {}),
      (e: any) => e.status === 403 && /EGRESS/.test(e.code),
    );
    await blocked.close();
    await up.close();
  });

  it("retryable failures switch to the fallback and are audited", async () => {
    const bad = await startUpstream((_req, res) => {
      res.writeHead(503);
      res.end("down");
    });
    const good = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fallback-ok");
    });
    const audits: any[] = [];
    const adapter = new ApiAdapter({
      instanceId: "builder-a",
      profiles: new Map([
        ["api_primary", apiProfile({ api_profile_id: "api_primary", base_url: bad.url, egress: "egress-local", fallback: ["api_backup"] })],
        ["api_backup", apiProfile({ api_profile_id: "api_backup", base_url: good.url, egress: "egress-local" })],
      ]),
      secretClient: fakeSecret,
      egress: { policies: { "egress-local": ["127.0.0.1"] }, allowLoopback: true },
      port: 0,
      audit: (r) => audits.push(r),
    });
    await adapter.start();
    const out = await adapter.call("api_primary", "GET", "/x", { idempotencyKey: "idem-1" });
    assert.equal(out.body.toString(), "fallback-ok");
    assert.ok(audits.some((a) => String(a.error_code ?? "").startsWith("FALLBACK:")));
    await adapter.close();
    await bad.close();
    await good.close();
  });

  it("a denied Secret fails closed without leaking credentials from the error to the caller", async () => {
    const denied = {
      resolve: async () => {
        throw new SecretDenied("SECRET_NOT_ALLOWED", "this instance is not allowed to read this secret_ref");
      },
      invalidate: () => {},
    } as unknown as SecretClient;
    const up = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end("should-not-reach");
    });
    const adapter = new ApiAdapter({
      instanceId: "worker-b",
      profiles: new Map([["api_test", apiProfile({ base_url: up.url, egress: "e" })]]),
      secretClient: denied,
      egress: { policies: { e: ["127.0.0.1"] }, allowLoopback: true },
      port: 0,
    });
    await assert.rejects(
      () => adapter.call("api_test", "GET", "/", {}),
      (e: any) => e instanceof ApiAdapterError && e.code === "SECRET_NOT_ALLOWED" && e.status === 502,
    );
    await adapter.close();
    await up.close();
  });
});

// ---------------------------------------------------------------- runner

describe("Agent executor", () => {
  it("executes through the stdio Adapter; unauthorized tools are rejected; artifacts are uploaded by role-agent", async () => {
    const ws = fs.mkdtempSync(path.join(TMP, "ws-"));
    const { ctx, uploads } = ctxFor(ws);
    const audits: ToolAuditRecord[] = [];
    const result = await runAgentTask(
      assignment({ requirements: { message: "hello p4", probe_forbidden: true, probe_api: false } }),
      ctx,
      { profiles: runtimeProfiles(), toolAudit: (r) => audits.push(r) },
    );
    assert.match(result.summary, /agent-marker=alpha/);
    assert.equal((result.outputs as any).agent_profile_id, "agp_test");
    assert.equal(uploads.length, 1);
    const body = JSON.parse(uploads[0].data.toString());
    assert.equal(body.marker, "alpha");
    assert.ok(String(body.forbidden).includes("TOOL_NOT_ALLOWED"));
    assert.ok(audits.some((a) => a.decision === "DENY" && a.code === "TOOL_NOT_ALLOWED"));
    assert.ok(audits.some((a) => a.decision === "ALLOW" && a.tool_id === "demo.echo"));
  });

  it("switching Agents within a role only swaps the Profile; Adapter crashes report as retryable failures", async () => {
    const wsBeta = fs.mkdtempSync(path.join(TMP, "ws-beta-"));
    const beta = runtimeProfiles({
      agent: agentProfile({
        agent_profile_id: "agp_beta",
        entrypoint: [process.execPath, AGENT_FILE, "--marker=beta"],
      }),
    });
    const out = await runAgentTask(
      assignment({
        requirements: { message: "swap", probe_forbidden: false },
        agent: { profile_id: "agp_beta", version: "1.0.0" },
      }),
      ctxFor(wsBeta).ctx,
      { profiles: beta, toolAudit: () => {} },
    );
    assert.match(out.summary, /agent-marker=beta/);

    const wsCrash = fs.mkdtempSync(path.join(TMP, "ws-crash-"));
    await assert.rejects(
      () =>
        runAgentTask(assignment({ requirements: { crash: true } }), ctxFor(wsCrash).ctx, {
          profiles: runtimeProfiles(),
          toolAudit: () => {},
        }),
      (e: any) => e instanceof TaskFailed && e.code === "AGENT_CRASHED",
    );
  });

  it("downloads handed-over upstream artifacts into the workspace before the Agent starts", async () => {
    const ws = fs.mkdtempSync(path.join(TMP, "ws-upstream-"));
    const data = Buffer.from("child build output\n");
    const sha256 = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    const requests: string[] = [];
    const { ctx } = ctxFor(ws);
    ctx.downloadArtifact = async (artifactId) => {
      requests.push(artifactId);
      return { data, sha256, media_type: "text/plain" };
    };

    await runAgentTask(
      assignment({
        requirements: {
          message: "combine the children",
          probe_forbidden: true,
          upstream_artifacts: [
            {
              artifact_id: "art_child",
              sha256,
              media_type: "text/plain",
              task_id: "task_child",
              task_type: "task.build",
            },
          ],
        },
      }),
      ctx,
      { profiles: runtimeProfiles(), toolAudit: () => {} },
    );

    assert.deepEqual(requests, ["art_child"]);
    const dir = path.join(ws, "upstream");
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /\.txt$/);
    assert.equal(fs.readFileSync(path.join(dir, files[0]), "utf8"), "child build output\n");
    // The Agent runs as root in the container; the file should not be world-readable by accident.
    assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
  });

  it("refuses an upstream artifact whose content does not match the handoff digest", async () => {
    const ws = fs.mkdtempSync(path.join(TMP, "ws-upstream-bad-"));
    const { ctx } = ctxFor(ws);
    ctx.downloadArtifact = async () => ({ data: Buffer.from("tampered"), sha256: "sha256:deadbeef", media_type: "text/plain" });

    await assert.rejects(
      () =>
        runAgentTask(
          assignment({
            requirements: {
              message: "merge",
              probe_forbidden: true,
              upstream_artifacts: [
                { artifact_id: "art_bad", sha256: `sha256:${"0".repeat(64)}`, media_type: "text/plain" },
              ],
            },
          }),
          ctx,
          { profiles: runtimeProfiles(), toolAudit: () => {} },
        ),
      (e: any) => e instanceof TaskFailed && e.code === "UPSTREAM_ARTIFACT_DIGEST_MISMATCH",
    );
    const dir = path.join(ws, "upstream");
    assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
  });
});
