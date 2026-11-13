import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AdmissionBroker } from "../src/admission-broker.js";
import type { CommandPayload, InstanceSpec } from "../src/command-verify.js";
import { containerName } from "../src/container-spec.js";
import { OperationJournal } from "../src/journal.js";
import { HostPolicyGate } from "../src/policy.js";
import { Reconciler } from "../src/reconciler.js";
import type { RuntimeHostConfig } from "../src/runtime-config.js";
import { RuntimeState } from "../src/runtime-state.js";
import type { HostState, WatchdogStateFile } from "../src/watchdog-state.js";
import { FakeEngine } from "./fake-engine.js";

const G = 1024 ** 3;
const MEM = 256 * 1024 ** 2;
const DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE = `registry.test/platform/worker@${DIGEST}`;
const now = Date.now();

const cfg = {
  container_stop_timeout_seconds: 30,
  remove_volumes_on_remove: false,
  network_policies: { default: "bridge" },
  watchdog: { sample_seconds: 5 },
} as unknown as RuntimeHostConfig;

function spec(instanceId: string): InstanceSpec {
  return {
    instance_id: instanceId,
    role_id: "worker",
    display_name: "worker",
    image: IMAGE,
    resource_profile: { cpu_limit: 0.5, memory_limit_bytes: MEM, pids_limit: 64, io_weight: 500 },
    env: { ROLE_ID: "worker" },
    volumes: [{ name: "workspace", mount: "/opt/platform/workspace" }],
    network_policy: "default",
    config_version: 1,
    command: ["sleep", "3600"],
  };
}

function command(
  type: CommandPayload["command_type"],
  deploymentId: string,
  instanceId: string,
  generation = 1,
): CommandPayload {
  return {
    command_id: `cmd_${type}_${generation}`,
    command_type: type,
    host_id: "hst_1",
    deployment_id: deploymentId,
    instance_id: instanceId,
    generation,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    resource_grant:
      type === "DEPLOY"
        ? { grant_id: `rgr_${deploymentId}`, kind: "DEPLOYMENT", cpu_limit: 0.5, memory_limit_bytes: MEM }
        : null,
    instance: type === "DEPLOY" ? spec(instanceId) : null,
    signature: "test",
  };
}

function setup(opts: {
  availableBytes?: number;
  watchdog?: HostState | null;
  agentEnvFile?: string;
  cacheDir?: string;
  journal?: OperationJournal;
  policyFile?: string;
  audit?: (event: string, data?: Record<string, unknown>) => void;
  auditBroken?: () => boolean;
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconciler-test-"));
  const state = new RuntimeState(dir);
  const engine = new FakeEngine();
  const config = {
    ...cfg,
    ...(opts.agentEnvFile ? { agent_env_file: opts.agentEnvFile } : {}),
    ...(opts.cacheDir ? { cache_dir: opts.cacheDir } : {}),
  };
  const broker = new AdmissionBroker(
    () => 8 * G,
    () => opts.availableBytes ?? 8 * G,
    {
      host_reserve_bytes: 0,
      system_reserve_bytes: 0,
      safety_margin_bytes: 0,
      max_task_grant_bytes: 4 * G,
      grant_ttl_seconds: 3600,
    },
  );
  const hostStateFile = path.join(dir, "host-state.json");
  const watchdog = opts.watchdog === undefined ? "NORMAL" : opts.watchdog;
  if (watchdog !== null) {
    writeHostState(hostStateFile, watchdog);
  }
  const reconciler = new Reconciler({
    engine,
    state,
    cfg: config,
    broker,
    readWatchdog: () => {
      try {
        return JSON.parse(fs.readFileSync(hostStateFile, "utf8")) as WatchdogStateFile;
      } catch {
        return null;
      }
    },
    log: () => {},
    now: () => now,
    ...(opts.journal ? { journal: opts.journal } : {}),
    ...(opts.policyFile ? { policy: new HostPolicyGate(opts.policyFile, () => {}) } : {}),
    ...(opts.audit ? { audit: opts.audit } : {}),
    ...(opts.auditBroken ? { auditBroken: opts.auditBroken } : {}),
  });
  return { dir, state, engine, broker, reconciler, hostStateFile };
}

function writeHostState(file: string, state: HostState): void {
  const payload: WatchdogStateFile = {
    state,
    since: new Date(now).toISOString(),
    reason: "TEST",
    updated_at: new Date(now).toISOString(),
    pending: null,
    below_since: null,
    sample: {
      mem_total_bytes: 8 * G,
      mem_available_bytes: 6 * G,
      load1: 0.1,
      cpu_count: 4,
      disk_total_bytes: 100 * G,
      disk_free_bytes: 50 * G,
      pcs_reachable: true,
      pcs_silence_seconds: 1,
    },
  };
  fs.writeFileSync(file, JSON.stringify(payload));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("DEPLOY→STOP→START→RESTART→REMOVE converges to the desired state", async () => {
  const { dir, state, engine, broker, reconciler } = setup();
  const depId = "dep_1";
  const insId = "ins_1";
  try {
    let out = await reconciler.execute(command("DEPLOY", depId, insId), true);
    assert.equal(out.ok, true);
    assert.equal(engine.calls.includes(`create:${containerName(insId)}`), true);
    assert.equal(engine.calls.includes(`start:${containerName(insId)}`), true);
    assert.equal(state.deployment(depId)?.desired_state, "RUNNING");
    assert.equal(engine.containers.get(containerName(insId))?.state, "running");
    assert.equal(broker.summary().deployment_grants, 1);

    out = await reconciler.execute(command("STOP", depId, insId, 2), true);
    assert.equal(out.ok, true);
    assert.equal(engine.containers.get(containerName(insId))?.state, "exited");
    assert.equal(state.deployment(depId)?.desired_state, "STOPPED");
    assert.equal(broker.summary().deployment_grants, 0);

    out = await reconciler.execute(command("START", depId, insId, 3), true);
    assert.equal(out.ok, true);
    assert.equal(engine.containers.get(containerName(insId))?.state, "running");
    assert.equal(state.deployment(depId)?.desired_state, "RUNNING");

    out = await reconciler.execute(command("RESTART", depId, insId, 4), true);
    assert.equal(out.ok, true);
    assert.equal(engine.containers.get(containerName(insId))?.restart_count, 1);

    out = await reconciler.execute(command("REMOVE", depId, insId, 5), true);
    assert.equal(out.ok, true);
    assert.equal(engine.containers.has(containerName(insId)), false);
    assert.equal(state.deployment(depId), undefined);
    assert.equal(broker.summary().deployment_grants, 0);
  } finally {
    cleanup(dir);
  }
});

test("deployment writes the container config and injects model keys from the host credentials file", async () => {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-test-"));
  const envFile = path.join(secretsDir, "agent-env");
  fs.writeFileSync(
    envFile,
    'ANTHROPIC_API_KEY=sk-test\nANTHROPIC_BASE_URL="https://example.test/anthropic"\n',
  );
  const { dir, engine, reconciler } = setup({ agentEnvFile: envFile });
  const depId = "dep_env";
  const insId = "ins_env";
  try {
    const cmd = command("DEPLOY", depId, insId);
    cmd.instance = {
      ...cmd.instance!,
      files: [{ path: "/opt/platform/profiles.json", content: '{"agent_profiles":[]}' }],
      agent_env: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
    };
    const out = await reconciler.execute(cmd, true);
    assert.equal(out.ok, true);
    assert.equal(engine.archives.has(containerName(insId)), true);
    assert.equal(engine.calls.includes(`archive:${containerName(insId)}:/`), true);
    assert.deepEqual(engine.configOf(containerName(insId))?.Env, [
      "ANTHROPIC_API_KEY=sk-test",
      "ANTHROPIC_BASE_URL=https://example.test/anthropic",
      "ROLE_ID=worker",
    ]);
  } finally {
    cleanup(dir);
    cleanup(secretsDir);
  }
});

test("container creation is refused when the credentials file lacks a variable", async () => {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-missing-"));
  const envFile = path.join(secretsDir, "agent-env");
  fs.writeFileSync(envFile, "ANTHROPIC_BASE_URL=https://example.test/anthropic\n");
  const { dir, engine, reconciler } = setup({ agentEnvFile: envFile });
  try {
    const cmd = command("DEPLOY", "dep_noenv", "ins_noenv");
    cmd.instance = { ...cmd.instance!, agent_env: ["ANTHROPIC_API_KEY"] };
    const out = await reconciler.execute(cmd, true);
    assert.equal(out.ok, false);
    assert.equal(out.result.code, "RUNTIME_ERROR");
    assert.match(String(out.result.message), /ANTHROPIC_API_KEY/);
    assert.equal(engine.calls.some((c) => c.startsWith("create:")), false);
  } finally {
    cleanup(dir);
    cleanup(secretsDir);
  }
});

test("the container mounts the host runtime environment cache read-only", async () => {
  const cacheDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "platform-cache-")), "cache");
  const { dir, engine, reconciler } = setup({ cacheDir });
  try {
    const out = await reconciler.execute(command("DEPLOY", "dep_cache", "ins_cache"), true);
    assert.equal(out.ok, true);
    assert.equal(fs.existsSync(cacheDir), true, "the cache directory should be created before deployment");
    const mounts = engine.configOf(containerName("ins_cache"))?.HostConfig?.Mounts ?? [];
    const cache = mounts.find((m: any) => m.Target === "/opt/platform/cache");
    assert.equal(cache?.Type, "bind");
    assert.equal(cache?.Source, cacheDir);
    assert.equal(cache?.ReadOnly, true);
  } finally {
    cleanup(dir);
    cleanup(path.dirname(cacheDir));
  }
});

test("reconciliation does not rewrite the config file when the container is already running", async () => {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-reconcile-"));
  const envFile = path.join(secretsDir, "agent-env");
  fs.writeFileSync(envFile, "ANTHROPIC_API_KEY=sk-test\n");
  const { dir, engine, reconciler } = setup({ agentEnvFile: envFile });
  try {
    const cmd = command("DEPLOY", "dep_recfg", "ins_recfg");
    cmd.instance = {
      ...cmd.instance!,
      files: [{ path: "/opt/platform/profiles.json", content: '{"agent_profiles":[]}' }],
      agent_env: ["ANTHROPIC_API_KEY"],
    };
    await reconciler.execute(cmd, true);
    const writes = engine.calls.filter((c) => c.startsWith("archive:")).length;
    assert.equal(writes, 1);

    await reconciler.reconcile(true);
    assert.equal(engine.calls.filter((c) => c.startsWith("archive:")).length, writes);
  } finally {
    cleanup(dir);
    cleanup(secretsDir);
  }
});

test("repeated DEPLOY is idempotent: a running container is not recreated", async () => {
  const { dir, engine, reconciler } = setup();
  const depId = "dep_idem";
  const insId = "ins_idem";
  try {
    await reconciler.execute(command("DEPLOY", depId, insId), true);
    const creates = engine.calls.filter((c) => c.startsWith("create:")).length;
    const out = await reconciler.execute(command("DEPLOY", depId, insId, 2), true);
    assert.equal(out.ok, true);
    assert.equal(out.result.action, "already_running");
    assert.equal(engine.calls.filter((c) => c.startsWith("create:")).length, creates);
  } finally {
    cleanup(dir);
  }
});

test("PCS unreachable, watchdog protection, and insufficient admission all refuse new containers", async () => {
  {
    const { dir, engine, reconciler } = setup();
    try {
      const out = await reconciler.execute(command("DEPLOY", "dep_off", "ins_off"), false);
      assert.equal(out.ok, false);
      assert.equal(out.result.code, "PCS_OFFLINE");
      assert.equal(engine.calls.some((c) => c.startsWith("create:")), false);
    } finally {
      cleanup(dir);
    }
  }
  {
    const { dir, engine, reconciler } = setup({ watchdog: "PROTECTING" });
    try {
      const out = await reconciler.execute(command("DEPLOY", "dep_prot", "ins_prot"), true);
      assert.equal(out.ok, false);
      assert.equal(out.result.code, "HOST_PROTECTING");
      assert.equal(engine.calls.some((c) => c.startsWith("create:")), false);
    } finally {
      cleanup(dir);
    }
  }
  {
    const { dir, engine, reconciler } = setup({ watchdog: null });
    try {
      const out = await reconciler.execute(command("DEPLOY", "dep_nowd", "ins_nowd"), true);
      assert.equal(out.ok, false);
      assert.equal(out.result.code, "WATCHDOG_UNAVAILABLE");
      assert.equal(engine.calls.some((c) => c.startsWith("create:")), false);
    } finally {
      cleanup(dir);
    }
  }
  {
    const { dir, engine, reconciler } = setup({ availableBytes: 100 * 1024 ** 2 });
    try {
      const out = await reconciler.execute(command("DEPLOY", "dep_mem", "ins_mem"), true);
      assert.equal(out.ok, false);
      assert.equal(out.result.code, "ADMISSION_DENIED_BY_HOST");
      assert.equal(engine.calls.some((c) => c.startsWith("create:")), false);
    } finally {
      cleanup(dir);
    }
  }
});

test("THROTTLED blocks new deployments but still allows restarting existing containers", async () => {
  const { dir, engine, reconciler } = setup();
  try {
    await reconciler.execute(command("DEPLOY", "dep_t", "ins_t"), true);
    writeHostState(path.join(dir, "host-state.json"), "THROTTLED");

    const denied = await reconciler.execute(command("DEPLOY", "dep_t2", "ins_t2"), true);
    assert.equal(denied.ok, false);
    assert.equal(denied.result.code, "HOST_THROTTLED");

    const restart = await reconciler.execute(command("RESTART", "dep_t", "ins_t", 2), true);
    assert.equal(restart.ok, true);
    assert.equal(engine.containers.get(containerName("ins_t"))?.restart_count, 1);
  } finally {
    cleanup(dir);
  }
});

test("reconciliation: exited containers are started, missing ones are recreated, and nothing is touched while offline", async () => {
  const { dir, state, engine, reconciler } = setup();
  const depId = "dep_rec";
  const insId = "ins_rec";
  try {
    await reconciler.execute(command("DEPLOY", depId, insId), true);
    const name = containerName(insId);

    engine.simulateExit(name);
    await reconciler.reconcile(true);
    assert.equal(engine.containers.get(name)?.state, "running");

    engine.containers.delete(name);
    await reconciler.reconcile(true);
    assert.equal(engine.containers.get(name)?.state, "running");

    engine.containers.delete(name);
    await reconciler.reconcile(false);
    assert.equal(engine.containers.has(name), false);
    assert.equal(state.deployment(depId)?.desired_state, "RUNNING");
  } finally {
    cleanup(dir);
  }
});

test("reconciliation: STOPPED deployments are no longer started", async () => {
  const { dir, engine, reconciler } = setup();
  const depId = "dep_stop";
  const insId = "ins_stop";
  try {
    await reconciler.execute(command("DEPLOY", depId, insId), true);
    await reconciler.execute(command("STOP", depId, insId, 2), true);

    // Someone starts the container by hand; reconciliation should stop it again
    await engine.start(containerName(insId));
    await reconciler.reconcile(true);
    assert.equal(engine.containers.get(containerName(insId))?.state, "exited");
  } finally {
    cleanup(dir);
  }
});

test("rollback: a deploy that fails after create leaves no half-created container", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconciler-rb-"));
  const journal = new OperationJournal(path.join(dir, "journal.jsonl"));
  const { engine, reconciler, dir: stateDir } = setup({ journal });
  try {
    engine.failArchive = true;
    const cmd = command("DEPLOY", "dep_rb", "ins_rb");
    // Writing config files happens after the container is created; the failure lands mid-deploy.
    cmd.instance!.files = [{ path: "/opt/platform/profile.json", content: "{}" }];
    const out = await reconciler.execute(cmd, true);
    assert.equal(out.ok, false);
    assert.equal(engine.containers.has(containerName("ins_rb")), false);
    assert.equal(journal.pending().length, 0, "a rolled-back transaction leaves nothing open");
  } finally {
    cleanup(stateDir);
    cleanup(dir);
  }
});

test("policy veto: a kill switch blocks DEPLOY before any container is created", async () => {
  const policyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reconciler-pol-")), "host-policy.json");
  fs.writeFileSync(policyFile, JSON.stringify({ version: 1, kill_switch: true }));
  fs.chmodSync(policyFile, 0o600);
  const events: string[] = [];
  const { dir, engine, reconciler } = setup({ policyFile, audit: (event) => events.push(event) });
  try {
    const out = await reconciler.execute(command("DEPLOY", "dep_pol", "ins_pol"), true);
    assert.equal(out.ok, false);
    assert.equal(out.result.code, "HOST_KILL_SWITCH");
    assert.equal(engine.calls.includes(`create:${containerName("ins_pol")}`), false);
    assert.deepEqual(events, ["policy.denied"]);
  } finally {
    cleanup(dir);
    cleanup(path.dirname(policyFile));
  }
});

test("audit: a broken chain blocks new deployments", async () => {
  const { dir, engine, reconciler } = setup({ auditBroken: () => true });
  try {
    const out = await reconciler.execute(command("DEPLOY", "dep_aud", "ins_aud"), true);
    assert.equal(out.ok, false);
    assert.equal(out.result.code, "AUDIT_CHAIN_BROKEN");
    assert.equal(engine.calls.includes(`create:${containerName("ins_aud")}`), false);
  } finally {
    cleanup(dir);
  }
});

test("journal recovery: a container left by an interrupted create is removed on startup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconciler-rec-"));
  const file = path.join(dir, "journal.jsonl");
  const { engine, reconciler, dir: stateDir } = setup({ journal: new OperationJournal(file) });
  try {
    const name = containerName("ins_rec2");
    engine.images.add(IMAGE);
    await engine.create(name, {
      Image: IMAGE,
      Labels: {
        "platform.managed": "true",
        "platform.deployment_id": "dep_rec2",
        "platform.instance_id": "ins_rec2",
      },
    });
    // Simulate a crash after the container was created but before the command committed.
    const crashed = new OperationJournal(file);
    crashed.applied(crashed.begin("cmd_crash", "CONTAINER_CREATE", name, { deployment_id: "dep_rec2" }));

    const reopened = new OperationJournal(file);
    const recovered = new Reconciler({
      engine,
      state: new RuntimeState(stateDir),
      cfg: cfg,
      broker: new AdmissionBroker(() => 8 * G, () => 8 * G, {
        host_reserve_bytes: 0,
        system_reserve_bytes: 0,
        safety_margin_bytes: 0,
        max_task_grant_bytes: 4 * G,
        grant_ttl_seconds: 3600,
      }),
      readWatchdog: () => null,
      log: () => {},
      now: () => now,
      journal: reopened,
    });
    await recovered.recoverJournal();
    assert.equal(engine.containers.has(name), false);
    assert.equal(reopened.pending().length, 0);
    void reconciler;
  } finally {
    cleanup(stateDir);
    cleanup(dir);
  }
});
