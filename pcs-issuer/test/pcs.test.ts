import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { verifyCommandSignature } from "../src/commands.js";
import { loadConfig, type PcsConfig } from "../src/config.js";
import { SCHEDULER_AUDIENCE, verifyJwt } from "../src/jwt.js";
import { pool, query } from "../src/db.js";
import { PcsService } from "../src/service.js";

const PINNED = `registry.test/platform/builder@sha256:${"a".repeat(64)}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pcs-test-"));
let svc: PcsService;
let cfg: PcsConfig;

function writePair(name: string, pair: { privateKey: KeyObject; publicKey: KeyObject }) {
  const priv = path.join(tmp, `${name}-private.pem`);
  const pub = path.join(tmp, `${name}-public.pem`);
  fs.writeFileSync(priv, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(pub, pair.publicKey.export({ type: "spki", format: "pem" }));
  return { priv, pub };
}

before(async () => {
  // Deployment plans attach a deployment payload to built-in roles; the test uses a temp directory instead of the real app/.
  for (const role of ["scheduler", "builder"]) {
    const dir = path.join(tmp, `${role}-app`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "entrypoint.sh"), "#!/bin/bash\nexit 0\n");
  }
  const jwt = writePair("jwt", generateKeyPairSync("ec", { namedCurve: "P-256" }));
  const cmd = writePair("cmd", generateKeyPairSync("ed25519"));
  cfg = loadConfig({
    jwtPrivateKeyFile: jwt.priv,
    jwtPublicKeyFile: jwt.pub,
    commandPrivateKeyFile: cmd.priv,
    commandPublicKeyFile: cmd.pub,
    imageAllowlist: ["registry.test/"],
    networkPolicies: ["default"],
    approvalMfaCode: "123456",
    schedulerAppDir: path.join(tmp, "scheduler-app"),
    builderAppDir: path.join(tmp, "builder-app"),
    // Builder deployments need a resolvable local scheduler address; the test pins a loopback address.
    schedulerUrl: "http://127.0.0.1:8443",
    schedulerDatabaseUrl: "postgres://postgres:sched_dev_pw@127.0.0.1:5432/scheduler_test",
  });
  await query(
    `TRUNCATE pcs_commands, pcs_deployments, pcs_host_reports,
              pcs_host_runtimes, pcs_enrollment_tokens, pcs_hosts,
              role_api_bindings, role_agent_bindings, api_profiles, agent_profiles,
              deployment_plans
       CASCADE`,
  );
  await query(`TRUNCATE pcs_audit_logs`);
  svc = new PcsService(cfg);
});

after(async () => {
  await pool.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function enrolledHost(name = "test-host"): Promise<{
  host_id: string;
  host_token: string;
  command_public_key: string;
  enrollment_token: string;
}> {
  const created = await svc.createHost({ name });
  const out = await svc.enroll({
    enrollment_token: created.enrollment_token,
    hostname: name,
    os: "linux",
    arch: "x64",
    fingerprint: `fp-${name}`,
    container_runtime: "docker",
    runtime_version: "0.2.0",
  });
  return { ...out, enrollment_token: created.enrollment_token };
}

test("a registration token is single-use and registration returns the command public key", async () => {
  const host = await svc.createHost({ name: "one-shot" });
  const input = {
    enrollment_token: host.enrollment_token,
    hostname: "one-shot",
    os: "linux",
    arch: "x64",
    fingerprint: "fp-one-shot",
    container_runtime: "docker",
    runtime_version: "0.2.0",
  };
  const first = await svc.enroll(input);
  assert.equal(first.host_id, host.host_id);
  assert.match(first.command_public_key, /BEGIN PUBLIC KEY/);
  assert.ok(first.host_token.split(".").length === 3);

  await assert.rejects(
    () => svc.enroll(input),
    (e: any) => e.code === "ENROLLMENT_TOKEN_USED",
  );
  await assert.rejects(
    () => svc.enroll({ ...input, enrollment_token: "enr_not_a_token" }),
    (e: any) => e.code === "ENROLLMENT_TOKEN_INVALID",
  );
});

test("an expired registration token is rejected", async () => {
  const host = await svc.createHost({ name: "expired" });
  await query(
    `UPDATE pcs_enrollment_tokens SET expires_at = now() - interval '1 second' WHERE host_id=$1`,
    [host.host_id],
  );
  await assert.rejects(
    () =>
      svc.enroll({
        enrollment_token: host.enrollment_token,
        hostname: "expired",
        os: "linux",
        arch: "x64",
        fingerprint: "fp-expired",
        container_runtime: "docker",
        runtime_version: "0.2.0",
      }),
    (e: any) => e.code === "ENROLLMENT_TOKEN_EXPIRED",
  );
});

test("host tokens authenticate while admin tokens are rejected per scope", async () => {
  const host = await enrolledHost("auth-host");
  const row = await svc.authenticateHost(host.host_token);
  assert.equal(row.host_id, host.host_id);
  assert.equal(row.status, "ENROLLED");

  const readOnly = svc.issueAdminToken("tester", 1, ["host:read"]);
  assert.equal(svc.authenticateAdmin(readOnly, "host:read").operator_id, "tester");
  assert.throws(() => svc.authenticateAdmin(readOnly, "deployment:write"));
  await assert.rejects(
    () => svc.authenticateHost(svc.issueAdminToken("tester")),
    (e: any) => e.code === "AUDIENCE_MISMATCH" || e.code === "TOKEN_INVALID",
  );
});

test("deploy commands are signed and carry a pinned image and grant, and cannot be fetched twice", async () => {
  const host = await enrolledHost("deploy-host");
  const { deployment, command_id } = await svc.createDeployment({
    host_id: host.host_id,
    role_id: "builder",
    image: PINNED,
    resource_profile: { cpu_limit: 0.5, memory_limit_bytes: 128 * 1024 ** 2, pids_limit: 64 },
    env: { ROLE_ID: "builder" },
    volumes: [{ name: "workspace", mount: "/opt/platform/workspace" }],
    ports: [{ container: 2222, host: 2222 }],
    network_policy: "default",
    command: ["sleep", "3600"],
    created_by: "operator:tester",
  });
  assert.equal(deployment.status, "PLANNED");
  assert.equal(deployment.desired_state, "RUNNING");
  assert.equal(Number(deployment.generation), 1);

  const cmd = await svc.nextCommand(host.host_id, 0);
  assert.ok(cmd);
  assert.equal(cmd.command_id, command_id);
  assert.equal(cmd.command_type, "DEPLOY");
  assert.equal(cmd.payload.generation, 1);
  assert.ok(cmd.payload.resource_grant?.grant_id.startsWith("rgr_"));
  assert.equal(cmd.payload.instance?.image, PINNED);
  assert.deepEqual(cmd.payload.instance?.ports, [{ container: 2222, host: 2222 }]);
  assert.deepEqual(deployment.ports, [{ container: 2222, host: 2222 }]);
  assert.equal(verifyCommandSignature(cmd.payload, host.command_public_key), true);
  assert.equal(
    verifyCommandSignature({ ...cmd.payload, generation: 99 }, host.command_public_key),
    false,
  );

  assert.equal(await svc.nextCommand(host.host_id, 0), null);

  const acked = await svc.ackCommand(host.host_id, cmd.command_id, true, { action: "created" });
  assert.equal(acked.state, "ACKED");
  const again = await svc.ackCommand(host.host_id, cmd.command_id, true, {});
  assert.equal(again.idempotent, true);
  const dep = await svc.getDeployment(deployment.deployment_id);
  assert.equal(dep?.actual_state, "STARTING");
});

test("a host report advances the deployment to HEALTHY, while absence marks it MISSING", async () => {
  const host = await enrolledHost("report-host");
  const { deployment } = await svc.createDeployment({
    host_id: host.host_id,
    role_id: "builder",
    image: PINNED,
    resource_profile: { cpu_limit: 0.5, memory_limit_bytes: 128 * 1024 ** 2, pids_limit: 64 },
    created_by: "operator:tester",
  });
  const cmd = await svc.nextCommand(host.host_id, 0);
  await svc.ackCommand(host.host_id, cmd!.command_id, true, {});
  const row = await svc.authenticateHost(host.host_token);

  await svc.storeReport(row, {
    host_state: "NORMAL",
    runtime: { version: "0.2.0", container_runtime: "docker" },
    resources: { mem_total_bytes: 8 * 1024 ** 3 },
    containers: [
      {
        instance_id: deployment.instance_id,
        state: "running",
        health: "healthy",
        image_id: PINNED.split("@")[1],
      },
    ],
  });
  let dep = await svc.getDeployment(deployment.deployment_id);
  assert.equal(dep?.actual_state, "RUNNING");
  assert.equal(dep?.status, "HEALTHY");
  assert.equal((await svc.getHost(host.host_id))?.status, "ONLINE");

  await svc.storeReport(row, { host_state: "NORMAL", containers: [] });
  dep = await svc.getDeployment(deployment.deployment_id);
  assert.equal(dep?.actual_state, "MISSING");
});

test("a revoked host cannot authenticate with a token, be deployed, or receive commands", async () => {
  const host = await enrolledHost("revoked-host");
  const { deployment } = await svc.createDeployment({
    host_id: host.host_id,
    role_id: "builder",
    image: PINNED,
    created_by: "operator:tester",
  });
  await svc.revokeHost(host.host_id, "operator:tester");
  await assert.rejects(
    () => svc.authenticateHost(host.host_token),
    (e: any) => e.code === "HOST_REVOKED",
  );
  await assert.rejects(
    () =>
      svc.createDeployment({
        host_id: host.host_id,
        role_id: "builder",
        image: PINNED,
        created_by: "operator:tester",
      }),
    (e: any) => e.code === "HOST_REVOKED",
  );
  await assert.rejects(
    () => svc.enqueueAction(deployment.deployment_id, "restart", "operator:tester"),
    (e: any) => e.code === "HOST_REVOKED",
  );
});

test("deployment input validation: image, env, network policy", async () => {
  const host = await enrolledHost("validate-host");
  const base = { host_id: host.host_id, role_id: "builder", created_by: "operator:tester" };

  await assert.rejects(
    () => svc.createDeployment({ ...base, image: "registry.test/platform/builder:latest" }),
    (e: any) => e.code === "IMAGE_NOT_PINNED",
  );
  await assert.rejects(
    () => svc.createDeployment({ ...base, image: PINNED.replace("registry.test/", "evil.test/") }),
    (e: any) => e.code === "IMAGE_NOT_ALLOWED",
  );
  await assert.rejects(
    () => svc.createDeployment({ ...base, image: PINNED, env: { API_TOKEN: "x" } }),
    (e: any) => e.code === "SECRET_IN_ENVELOPE",
  );
  await assert.rejects(
    () => svc.createDeployment({ ...base, image: PINNED, network_policy: "host" }),
    (e: any) => e.code === "NETWORK_POLICY_NOT_ALLOWED",
  );
  await assert.rejects(
    () =>
      svc.createDeployment({
        ...base,
        image: PINNED,
        volumes: [{ name: "workspace", mount: "/etc" }],
      }),
    (e: any) => e.code === "INVALID_VOLUME",
  );
});

test("commands are isolated per host; other hosts cannot fetch or acknowledge them", async () => {
  const a = await enrolledHost("iso-a");
  const b = await enrolledHost("iso-b");
  const { deployment, command_id } = await svc.createDeployment({
    host_id: a.host_id,
    role_id: "builder",
    image: PINNED,
    created_by: "operator:tester",
  });

  assert.equal(await svc.nextCommand(b.host_id, 0), null);
  const cmd = await svc.nextCommand(a.host_id, 0);
  assert.equal(cmd?.command_id, command_id);
  await assert.rejects(
    () => svc.ackCommand(b.host_id, command_id, true, {}),
    (e: any) => e.code === "COMMAND_NOT_FOUND",
  );
  assert.equal((await svc.getDeployment(deployment.deployment_id))?.actual_state, "PENDING");
});

// ---------------------------------------------------------------- P4 Profiles

const AGENT_IMAGE = `registry.test/agents/builder@sha256:${"b".repeat(64)}`;

test("Agent Profiles validate the role/Adapter matrix and pinned digest", async () => {
  const base = {
    role_id: "builder",
    name: "builder-agent",
    version: "1.0.0",
    adapter: "stdio-jsonrpc",
    artifact_image: AGENT_IMAGE,
    allowed_tools: ["demo.echo"],
    task_types: ["task.agent.probe"],
  };
  const p = await svc.createAgentProfile({ ...base, agent_profile_id: "agp_test_ok" }, "alice");
  assert.equal(p.role_id, "builder");
  assert.deepEqual(p.allowed_tools, ["demo.echo"]);

  // v4 has only the builder / scheduler roles left, and scheduler is equally valid
  const sched = await svc.createAgentProfile(
    { ...base, role_id: "scheduler", adapter: "http-local", agent_profile_id: "agp_sched_ok" },
    "alice",
  );
  assert.equal(sched.role_id, "scheduler");
  assert.equal(sched.adapter, "http-local");

  // Removed roles are no longer accepted
  await assert.rejects(
    () => svc.createAgentProfile({ ...base, role_id: "reviewer", agent_profile_id: "agp_rev" }, "alice"),
    (e: any) => e.code === "ROLE_AGENT_NOT_ALLOWED",
  );
  // The role is valid but the Adapter is not in the matrix
  await assert.rejects(
    () =>
      svc.createAgentProfile(
        { ...base, adapter: "wasm" as any, agent_profile_id: "agp_bad_adapter" },
        "alice",
      ),
    (e: any) => e.code === "ADAPTER_NOT_ALLOWED",
  );
  await assert.rejects(
    () => svc.createAgentProfile({ ...base, agent_profile_id: "agp_unpinned", artifact_image: "registry.test/agents/builder:latest" }, "alice"),
    (e: any) => e.code === "IMAGE_NOT_PINNED",
  );
});

test("API Profiles store only secret references and reject plaintext and http", async () => {
  const p = await svc.createApiProfile(
    {
      api_profile_id: "api_llm_test",
      name: "LLM",
      kind: "llm",
      base_url: "https://llm.example/v1/",
      auth_type: "bearer",
      secret_ref: "secret://apis/llm",
      quota: { rpm: 60 },
      timeout_seconds: 30,
    },
    "alice",
  );
  assert.equal(p.secret_ref, "secret://apis/llm");
  assert.equal(p.base_url, "https://llm.example/v1");
  assert.ok(!JSON.stringify(p).includes("s3cr3t"));

  await assert.rejects(
    () =>
      svc.createApiProfile(
        {
          name: "bad",
          kind: "http",
          base_url: "http://evil.example",
          auth_type: "bearer",
          secret_ref: "secret://x",
        },
        "alice",
      ),
    (e: any) => e.code === "INSECURE_API_URL",
  );
  await assert.rejects(
    () =>
      svc.createApiProfile(
        {
          name: "bad-ref",
          kind: "http",
          base_url: "https://evil.example",
          auth_type: "bearer",
          secret_ref: "Bearer abcdef",
        },
        "alice",
      ),
    (e: any) => e.code === "INVALID_SECRET_REF",
  );
});

test("cross-role bindings are rejected; resolution omits secret values and writes an audit record", async () => {
  const host = await svc.createHost({ name: "bind-host" });
  const agent = await svc.createAgentProfile(
    {
      agent_profile_id: "agp_bind_builder",
      role_id: "builder",
      name: "bind-builder",
      version: "1.0.0",
      adapter: "stdio-jsonrpc",
      artifact_image: AGENT_IMAGE,
      allowed_tools: ["demo.echo"],
      task_types: ["task.agent.probe"],
    },
    "alice",
  );
  await svc.createApiProfile(
    {
      api_profile_id: "api_bind",
      name: "bind-api",
      kind: "tool",
      base_url: "https://api.example",
      auth_type: "bearer",
      secret_ref: "secret://apis/bind",
    },
    "alice",
  );

  await assert.rejects(
    () =>
      svc.bindAgent(host.host_id, "scheduler-x", agent.agent_profile_id, "scheduler", "alice"),
    (e: any) => e.code === "ROLE_AGENT_NOT_ALLOWED",
  );
  const b = await svc.bindAgent(
    host.host_id,
    "builder-p4",
    agent.agent_profile_id,
    "builder",
    "alice",
  );
  assert.equal(b.agent_profile_id, "agp_bind_builder");
  await svc.bindApi(host.host_id, "builder-p4", "api_bind", "alice");

  const resolved = await svc.resolveInstance(host.host_id, "builder-p4");
  assert.equal(resolved?.agent.allowed_tools[0], "demo.echo");
  assert.equal(resolved?.api_profiles[0]?.secret_ref, "secret://apis/bind");
  assert.ok(!JSON.stringify(resolved).includes("s3cr3t"));

  const logs = (await svc.listAudit(20)) as any[];
  assert.ok(logs.some((l) => l.action === "role_agent_binding.set" && l.instance_id === "builder-p4"));
  assert.ok(logs.some((l) => l.action === "role_api_binding.add" && l.instance_id === "builder-p4"));
});

test("an instance with the same name on different hosts has separate bindings that resolve independently", async () => {
  const hostA = await svc.createHost({ name: "bind-scope-a" });
  const hostB = await svc.createHost({ name: "bind-scope-b" });
  for (const [id, host] of [
    ["agp_scope_a", hostA],
    ["agp_scope_b", hostB],
  ] as const) {
    await svc.createAgentProfile(
      {
        agent_profile_id: id,
        role_id: "builder",
        name: id,
        version: "1.0.0",
        adapter: "stdio-jsonrpc",
        artifact_image: AGENT_IMAGE,
        allowed_tools: ["demo.echo"],
        task_types: ["task.agent.probe"],
      },
      "alice",
    );
    await svc.bindAgent(host.host_id, "builder-a", id, "builder", "alice");
  }

  const a = await svc.resolveInstance(hostA.host_id, "builder-a");
  const b = await svc.resolveInstance(hostB.host_id, "builder-a");
  assert.equal(a?.agent.agent_profile_id, "agp_scope_a");
  assert.equal(b?.agent.agent_profile_id, "agp_scope_b");

  const rows = (await svc.listBindings()).filter((x) => x.instance_id === "builder-a");
  assert.deepEqual(
    rows.map((x) => `${x.host_id}:${x.agent_profile_id}`).sort(),
    [
      `${hostA.host_id}:agp_scope_a`,
      `${hostB.host_id}:agp_scope_b`,
    ].sort(),
  );
});

test("the deployment plan digest is verifiable; insufficient resources, digest mismatch, and expiry are all rejected", async () => {
  const host = await enrolledHost("plan-host");
  await query(
    `UPDATE pcs_hosts
        SET status='ONLINE', resources='{"mem_available_bytes":8589934592}'::jsonb
      WHERE host_id=$1`,
    [host.host_id],
  );
  const input = {
    host_id: host.host_id,
    role_id: "builder",
    count: 1,
    image: PINNED,
    resource_profile: { cpu_limit: 0.5, memory_limit_bytes: 256 * 1024 ** 2, pids_limit: 64 },
    ports: [{ container: 2222, host: 2300 }],
    network_policy: "default",
  };
  const plan = await svc.previewDeploymentPlan(input, "alice");
  assert.match(plan.plan_digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(plan.names, ["builder-a"]);
  assert.equal(plan.limits.mem_mb, 256);
  assert.ok(new Date(plan.expires_at).getTime() - Date.now() <= 10 * 60 * 1000);

  await assert.rejects(
    () =>
      svc.applyDeploymentPlan(
        plan.plan_id,
        { plan_digest: `sha256:${"0".repeat(64)}` },
        "alice",
      ),
    (e: any) => e.code === "PLAN_CHANGED",
  );

  const applied = await svc.applyDeploymentPlan(
    plan.plan_id,
    { plan_digest: plan.plan_digest },
    "alice",
  );
  assert.equal(applied.deployments.length, 1);
  assert.equal(applied.deployments[0].instance_id, "builder-a");
  assert.deepEqual(applied.deployments[0].ports, [{ container: 2222, host: 2300 }]);
  const resolved = await svc.resolveInstance(host.host_id, "builder-a");
  assert.equal(resolved, null);

  await assert.rejects(
    () => svc.applyDeploymentPlan(plan.plan_id, { plan_digest: plan.plan_digest }, "alice"),
    (e: any) => e.code === "PLAN_ALREADY_APPLIED",
  );

  const expired = await svc.previewDeploymentPlan({ ...input, count: 2 }, "alice");
  await query(`UPDATE deployment_plans SET expires_at = now() - interval '1 second' WHERE plan_id=$1`, [
    expired.plan_id,
  ]);
  await assert.rejects(
    () => svc.applyDeploymentPlan(expired.plan_id, { plan_digest: expired.plan_digest }, "alice"),
    (e: any) => e.code === "PLAN_EXPIRED",
  );

  const tooBig = await svc.previewDeploymentPlan(
    {
      ...input,
      instance_id: "builder-big",
      resource_profile: { cpu_limit: 1, memory_limit_bytes: 64 * 1024 ** 3, pids_limit: 64 },
    },
    "alice",
  ).catch((e) => e);
  assert.equal(tooBig.code, "DEPLOYMENT_CHECK_FAILED");
});

test("a new deployment on the same host after preview makes apply return PLAN_CHANGED", async () => {
  const host = await enrolledHost("plan-tamper");
  await query(
    `UPDATE pcs_hosts
        SET status='ONLINE', resources='{"mem_available_bytes":8589934592}'::jsonb
      WHERE host_id=$1`,
    [host.host_id],
  );
  const plan = await svc.previewDeploymentPlan(
    {
      host_id: host.host_id,
      role_id: "builder",
      count: 1,
      instance_id: "builder-tamper",
      image: PINNED,
      resource_profile: { cpu_limit: 0.5, memory_limit_bytes: 128 * 1024 ** 2, pids_limit: 32 },
    },
    "alice",
  );
  await svc.createDeployment({
    host_id: host.host_id,
    instance_id: "builder-tamper",
    role_id: "builder",
    image: PINNED,
    created_by: "mallory",
  });
  await assert.rejects(
    () => svc.applyDeploymentPlan(plan.plan_id, { plan_digest: plan.plan_digest }, "alice"),
    (e: any) => e.code === "PLAN_CHANGED",
  );
});

test("applying a plan automatically writes Agent / API bindings", async () => {
  const host = await enrolledHost("plan-bind");
  await query(
    `UPDATE pcs_hosts
        SET status='ONLINE', resources='{"mem_available_bytes":8589934592}'::jsonb
      WHERE host_id=$1`,
    [host.host_id],
  );
  await svc.createAgentProfile(
    {
      agent_profile_id: "agp_plan_builder",
      role_id: "builder",
      name: "plan-builder",
      version: "1.0.0",
      adapter: "stdio-jsonrpc",
      artifact_image: AGENT_IMAGE,
      allowed_tools: ["demo.echo"],
      task_types: ["task.agent.probe"],
    },
    "alice",
  );
  await svc.createApiProfile(
    {
      api_profile_id: "api_plan",
      name: "plan-api",
      kind: "tool",
      base_url: "https://api.example",
      auth_type: "bearer",
      secret_ref: "secret://apis/plan",
    },
    "alice",
  );
  const plan = await svc.previewDeploymentPlan(
    {
      host_id: host.host_id,
      role_id: "builder",
      count: 1,
      agent_profile_id: "agp_plan_builder",
      api_profile_ids: ["api_plan"],
      resource_profile: { cpu_limit: 0.5, memory_limit_bytes: 128 * 1024 ** 2, pids_limit: 32 },
    },
    "alice",
  );
  await svc.applyDeploymentPlan(plan.plan_id, { plan_digest: plan.plan_digest }, "alice");
  const resolved = await svc.resolveInstance(host.host_id, plan.names[0]);
  assert.equal(resolved?.agent.agent_profile_id, "agp_plan_builder");
  assert.equal(resolved?.api_profiles[0]?.api_profile_id, "api_plan");
  const logs = (await svc.listAudit(50)) as any[];
  assert.ok(logs.some((l) => l.action === "deployment.plan.preview"));
  assert.ok(logs.some((l) => l.action === "deployment.plan.apply"));
});

test("approval token issuance requires MFA, binds the operator, and carries the approval:decide scope", async () => {
  const adminToken = svc.issueAdminToken("approver");
  const claims = svc.authenticateAdmin(adminToken, "approval:issue");
  const input = {
    approval_request_id: "aprq_test_1",
    subject_digest: `sha256:${"a".repeat(64)}`,
    action_scope: ["svn.commit"],
    task_id: "task_test_1",
  };
  await assert.rejects(
    () => Promise.resolve().then(() => svc.issueApprovalToken({ ...input, mfa_code: "000000" }, claims)),
    (e: any) => e.code === "MFA_REQUIRED",
  );
  await assert.rejects(
    () =>
      Promise.resolve().then(() =>
        svc.issueApprovalToken({ ...input, mfa_code: "123456", operator_id: "mallory" }, claims),
      ),
    (e: any) => e.code === "ROLE_NOT_ALLOWED",
  );

  const out = svc.issueApprovalToken({ ...input, mfa_code: "123456" }, claims);
  assert.equal(out.operator_id, "approver");
  assert.equal(out.approval_request_id, "aprq_test_1");
  const verified = verifyJwt(out.approval_token, fs.readFileSync(cfg.jwtPublicKeyFile, "utf8"), {
    audience: SCHEDULER_AUDIENCE,
    typ: "approval",
  });
  assert.equal(verified.operator_id, "approver");
  assert.deepEqual(verified.action_scope, ["svn.commit"]);
  assert.equal(verified.subject_digest, input.subject_digest);
  assert.ok((verified.scopes as string[]).includes("approval:decide"));

  const noMfa = new PcsService({ ...cfg, approvalMfaCode: null });
  assert.throws(
    () => noMfa.issueApprovalToken({ ...input, mfa_code: "123456" }, claims),
    (e: any) => e.code === "MFA_NOT_CONFIGURED",
  );
});

// ---------------------------------------------------------------------------
// Capability score W / task difficulty / host federation (architecture rules 1–4)
// ---------------------------------------------------------------------------

async function onlineHost(name: string, memBytes = 8589934592): Promise<string> {
  const host = await enrolledHost(name);
  await query(
    `UPDATE pcs_hosts
        SET status='ONLINE', resources=jsonb_build_object('mem_available_bytes', $2::bigint)
      WHERE host_id=$1`,
    [host.host_id, memBytes],
  );
  return host.host_id;
}

test("builder deployments freeze W and inject CAPABILITY_SCORE / CAPABILITY_DETAIL", async () => {
  const hostId = await onlineHost("cap-host");
  const detail = { cores: 8, freq_ghz: 4, mem_gb: 32, disk_gb: 256, model: 10, api: 10 };
  const plan = await svc.previewDeploymentPlan(
    {
      host_id: hostId,
      role_id: "builder",
      count: 1,
      instance_id: "cap-full",
      image: PINNED,
      capability_detail: detail,
      resource_profile: { cpu_limit: 1, memory_limit_bytes: 512 * 1024 ** 2, pids_limit: 64 },
      network_policy: "default",
    },
    "alice",
  );
  const applied = await svc.applyDeploymentPlan(
    plan.plan_id,
    { plan_digest: plan.plan_digest },
    "alice",
  );
  const dep = applied.deployments[0];
  assert.equal(dep.capability_score, 1000);
  assert.equal(dep.env.CAPABILITY_SCORE, "1000");
  assert.deepEqual(JSON.parse(dep.env.CAPABILITY_DETAIL), detail);

  // An explicit score takes precedence over the formula; the detail is kept as-is so the UI can explain how W is composed.
  const explicit = await svc.previewDeploymentPlan(
    {
      host_id: hostId,
      role_id: "builder",
      count: 1,
      instance_id: "cap-explicit",
      image: PINNED,
      capability_score: 420,
      capability_detail: detail,
      resource_profile: { cpu_limit: 1, memory_limit_bytes: 512 * 1024 ** 2, pids_limit: 64 },
      network_policy: "default",
    },
    "alice",
  );
  const applied2 = await svc.applyDeploymentPlan(
    explicit.plan_id,
    { plan_digest: explicit.plan_digest },
    "alice",
  );
  assert.equal(applied2.deployments[0].capability_score, 420);
  assert.equal(applied2.deployments[0].env.CAPABILITY_SCORE, "420");

  // Schedulers do not participate in W: the score is 0 and no capability env vars are injected.
  await svc.createDeployment({
    host_id: hostId,
    instance_id: "cap-sched",
    role_id: "scheduler",
    image: PINNED,
    created_by: "alice",
  });
  const sched = (await svc.listDeployments(hostId)).find((d) => d.instance_id === "cap-sched")!;
  assert.equal(Number(sched.capability_score ?? 0), 0);
  assert.equal(sched.env.CAPABILITY_SCORE, undefined);
});

test("joining hosts form a federation tree; ΣW accumulates per level and cycles are rejected", async () => {
  const a = await onlineHost("fleet-a");
  const b = await onlineHost("fleet-b");
  const c = await onlineHost("fleet-c");
  const d = await onlineHost("fleet-d-no-sched");

  for (const hostId of [a, b, c]) {
    await svc.createDeployment({
      host_id: hostId,
      instance_id: `sched-${hostId.slice(-1)}`,
      role_id: "scheduler",
      image: PINNED,
      created_by: "alice",
    });
  }
  const builders: Array<[string, string, number]> = [
    [a, "a-1", 100],
    [b, "b-1", 200],
    [b, "b-2", 50],
    [c, "c-1", 400],
  ];
  for (const [hostId, instanceId, score] of builders) {
    await svc.createDeployment({
      host_id: hostId,
      instance_id: instanceId,
      role_id: "builder",
      image: PINNED,
      capability_score: score,
      created_by: "alice",
    });
  }

  // createDeployment only lands PLANNED/SYNCING; ΣW counts only builders that are actually running.
  await query(
    `UPDATE pcs_deployments SET status='HEALTHY' WHERE instance_id = ANY($1::text[])`,
    [builders.map(([, instanceId]) => instanceId)],
  );

  await svc.mergeHost(b, a, "alice");
  await svc.mergeHost(c, b, "alice");

  const tree = await svc.getFleetTree();
  const byId = new Map(tree.hosts.map((h) => [h.host_id, h]));
  assert.equal(byId.get(a)!.local_score, 100);
  assert.equal(byId.get(b)!.local_score, 250);
  assert.equal(byId.get(c)!.local_score, 400);
  assert.equal(byId.get(a)!.subtree_score, 750);
  assert.equal(byId.get(b)!.subtree_score, 650);
  assert.equal(byId.get(c)!.subtree_score, 400);
  assert.equal(byId.get(a)!.subtree_builder_count, 4);
  // The same database also holds root hosts left by earlier cases; only assert on this test's three hosts.
  assert.ok(tree.roots.includes(a));
  assert.ok(!tree.roots.includes(b));
  assert.ok(!tree.roots.includes(c));

  await assert.rejects(
    () => svc.mergeHost(a, a, "alice"),
    (e: any) => e.code === "HOST_MERGE_SELF",
  );
  await assert.rejects(
    () => svc.mergeHost(a, c, "alice"),
    (e: any) => e.code === "HOST_MERGE_CYCLE",
  );
  // A host without a root scheduler can also be merged directly: bare-metal builders can exist independently of schedulers.
  const mergedD = await svc.mergeHost(d, a, "alice");
  assert.equal(mergedD.parent_host_id, a);
  assert.ok(!(await svc.getFleetTree()).roots.includes(d));
  // But the parent must have a root scheduler, otherwise there is no side to accept the node.
  await assert.rejects(
    () => svc.mergeHost(a, d, "alice"),
    (e: any) => e.code === "PARENT_SCHEDULER_MISSING",
  );

  await svc.unmergeHost(c, "alice");
  const after = await svc.getFleetTree();
  const afterById = new Map(after.hosts.map((h) => [h.host_id, h]));
  assert.equal(afterById.get(c)!.is_root, true);
  assert.equal(afterById.get(a)!.subtree_score, 350);
});

test("a host role is one of three; a bare-metal role cannot additionally deploy another role", async () => {
  // Only local/SSH-onboarded hosts have a credential row; updateHost goes through the credential table, so use a local host here.
  const hostId = (await svc.createLocalHost({ name: "role-host" })).host_id;
  await svc.updateHost(hostId, { role_mode: "builder" });
  await assert.rejects(
    () =>
      svc.createDeployment({
        host_id: hostId,
        instance_id: "role-sched",
        role_id: "scheduler",
        image: PINNED,
        created_by: "alice",
      }),
    (e: any) => e.code === "HOST_ROLE_CONFLICT",
  );

  // There is no execution path for bare-metal schedulers yet: switching a bare-metal builder to scheduler is rejected.
  await assert.rejects(
    () => svc.updateHost(hostId, { role_mode: "scheduler" }),
    (e: any) => e.code === "NATIVE_SCHEDULER_NOT_SUPPORTED",
  );

  await assert.rejects(
    () => svc.updateHost(hostId, { role_mode: "both" as any }),
    (e: any) => e.code === "INVALID_HOST_ROLE",
  );
});

test("one host can run multiple scheduler containers: a single root, nodes attached to a parent scheduler, and builders bound to a chosen scheduler", async () => {
  const hostId = await onlineHost("tree-host");
  // Scheduler addresses are derived from "host address + host port"; the test adds an SSH access address.
  await query(
    `INSERT INTO pcs_host_credentials (host_id, transport, address, ssh_port)
     VALUES ($1, 'ssh', '127.0.0.1', 22)
     ON CONFLICT (host_id) DO UPDATE
       SET transport='ssh', address='127.0.0.1', updated_at=now()`,
    [hostId],
  );

  // The first one automatically becomes the root scheduler.
  const root = (
    await svc.createDeployment({
      host_id: hostId,
      instance_id: "root",
      role_id: "scheduler",
      image: PINNED,
      ports: [{ container: 8443, host: 18443 }],
      created_by: "alice",
    })
  ).deployment;
  assert.equal(root.scheduler_role, "root");
  assert.equal(root.parent_deployment_id, null);
  assert.equal(root.scheduler_url, "http://127.0.0.1:18443");

  // The second one must specify a parent scheduler; going through a deployment plan, the control plane injects the parent address and a separate database.
  const nodePlan = await svc.previewDeploymentPlan(
    {
      host_id: hostId,
      role_id: "scheduler",
      count: 1,
      instance_id: "node-1",
      image: PINNED,
      parent_scheduler_id: root.deployment_id,
      ports: [{ container: 8443, host: 18444 }],
      resource_profile: { cpu_limit: 1, memory_limit_bytes: 512 * 1024 ** 2, pids_limit: 64 },
      network_policy: "default",
    },
    "alice",
  );
  const applied = await svc.applyDeploymentPlan(
    nodePlan.plan_id,
    { plan_digest: nodePlan.plan_digest },
    "alice",
  );
  const nodeDep = applied.deployments[0];
  assert.equal(nodeDep.scheduler_role, "node");
  assert.equal(nodeDep.parent_deployment_id, root.deployment_id);
  assert.equal(nodeDep.scheduler_url, "http://127.0.0.1:18444");
  assert.equal(nodeDep.env.SCHEDULER_NODE_ID, `${hostId}:node-1`);
  assert.equal(nodeDep.env.SCHEDULER_PARENT_URL, root.scheduler_url);
  assert.match(String(nodeDep.env.DATABASE_URL), /scheduler_test_node_1$/);
  assert.ok(nodeDep.env.SCHEDULER_FEDERATION_TOKEN);

  // The root scheduler is unique; a node must have a parent; the parent must be on this host.
  await assert.rejects(
    () =>
      svc.createDeployment({
        host_id: hostId,
        instance_id: "root-2",
        role_id: "scheduler",
        image: PINNED,
        scheduler_role: "root",
        created_by: "alice",
      }),
    (e: any) => e.code === "ROOT_SCHEDULER_EXISTS",
  );
  await assert.rejects(
    () =>
      svc.createDeployment({
        host_id: hostId,
        instance_id: "orphan",
        role_id: "scheduler",
        image: PINNED,
        scheduler_role: "node",
        created_by: "alice",
      }),
    (e: any) => e.code === "SCHEDULER_PARENT_REQUIRED",
  );
  const otherHost = await onlineHost("tree-other-host");
  const otherRoot = (
    await svc.createDeployment({
      host_id: otherHost,
      instance_id: "root",
      role_id: "scheduler",
      image: PINNED,
      created_by: "alice",
    })
  ).deployment;
  await assert.rejects(
    () =>
      svc.createDeployment({
        host_id: hostId,
        instance_id: "cross-node",
        role_id: "scheduler",
        image: PINNED,
        scheduler_role: "node",
        parent_scheduler_id: otherRoot.deployment_id,
        created_by: "alice",
      }),
    (e: any) => e.code === "PARENT_SCHEDULER_NOT_FOUND",
  );

  // Redeploying a node keeps its original position and is not mistaken for a new root.
  const redeployed = (
    await svc.createDeployment({
      host_id: hostId,
      instance_id: "node-1",
      role_id: "scheduler",
      image: PINNED,
      ports: [{ container: 8443, host: 18444 }],
      created_by: "alice",
    })
  ).deployment;
  assert.equal(redeployed.scheduler_role, "node");
  assert.equal(redeployed.parent_deployment_id, root.deployment_id);

  // The builder registers with the selected scheduler (after redeploy the old deployment is REMOVED, so the current generation must be used).
  const builder = (
    await svc.createDeployment({
      host_id: hostId,
      instance_id: "leaf-1",
      role_id: "builder",
      image: PINNED,
      scheduler_id: redeployed.deployment_id,
      created_by: "alice",
    })
  ).deployment;
  assert.equal(builder.scheduler_deployment_id, redeployed.deployment_id);
  assert.equal(builder.env.SCHEDULER_URL, redeployed.scheduler_url);
  assert.equal(redeployed.scheduler_url, "http://127.0.0.1:18444");
});
