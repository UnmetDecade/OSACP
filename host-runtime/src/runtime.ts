#!/usr/bin/env node
/**
 * Host Runtime daemon (one per physical machine).
 *
 * Outbound only: enroll → heartbeat → long-poll commands → signature/expiry/image allowlist/generation checks →
 * run the container lifecycle → ack → report. It also opens a local unix socket for second-level admission of role containers.
 *
 * It holds no tasks, selects no tasks, does not mount the Docker Socket into role containers, and offers no arbitrary command execution.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdmissionBroker, startAdmissionServer } from "./admission-broker.js";
import { AuditChain } from "./audit-chain.js";
import {
  CommandRejected,
  generationDecision,
  validateCommand,
  type CommandPayload,
} from "./command-verify.js";
import { CgroupManager, type AppliedGrant } from "./cgroup.js";
import { DockerEngine } from "./docker-engine.js";
import { buildReport } from "./host-report.js";
import { hostInfo, loadIdentity, saveIdentity, tokenUsable, type HostIdentity } from "./identity.js";
import { OperationJournal } from "./journal.js";
import { memAvailableBytes, sampleHost, type CpuTimes } from "./metrics.js";
import { PcsClient, PcsClientError } from "./pcs-client.js";
import { HostPolicyGate } from "./policy.js";
import { Reconciler } from "./reconciler.js";
import { loadRuntimeHostConfig, readPem } from "./runtime-config.js";
import { RuntimeState } from "./runtime-state.js";
import {
  containerAdmission,
  type HostState,
  type WatchdogStateFile,
} from "./watchdog-state.js";

const RUNTIME_VERSION = "0.2.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function log(message: string): void {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`${t} [runtime] ${message}`);
}

const cfg = loadRuntimeHostConfig(argValue("--config"));
fs.mkdirSync(cfg.state_dir, { recursive: true, mode: 0o700 });
fs.mkdirSync(cfg.identity_dir, { recursive: true, mode: 0o700 });

const commandPublicKey = readPem(cfg.command_public_key_file);
if (!commandPublicKey) {
  console.error(
    "Missing the PCS command public key (command_public_key_file / PCS_COMMAND_PUBLIC_KEY_FILE). " +
      "Commands cannot be verified without it; refusing to start.",
  );
  process.exit(1);
}

const engine = new DockerEngine(cfg.docker_socket, cfg.docker_timeout_ms);
const cgroup = new CgroupManager(cfg.resource_pool, log);
const state = new RuntimeState(cfg.state_dir);
const contactFile = path.join(cfg.state_dir, "pcs-last-seen.json");
const watchdogFile = path.join(cfg.state_dir, "host-state.json");

// Tripwires that live on the host itself: an operator veto, a tamper-evident record of what this
// machine did, and a journal of mutations so a crash mid-deploy can be undone on the next start.
const policy = new HostPolicyGate(undefined, log);
const audit = new AuditChain(path.join(cfg.state_dir, "audit-chain.jsonl"), log);
const journal = new OperationJournal(path.join(cfg.state_dir, "journal.jsonl"), log);
let auditIntegrityOk = true;

let running = true;
let revoked = false;
let inFlight = false;
let client: PcsClient | null = null;
let identity: HostIdentity | null = null;
let lastContactAt = 0;
let lastPcsErrorAt = 0;
let lastEngineErrorAt = 0;
let engineHealthy = false;
let containerRuntime = "docker unavailable";
let admissionServer: import("node:http").Server | null = null;

const broker = new AdmissionBroker(os.totalmem, memAvailableBytes, cfg.admission);

function markContact(): void {
  lastContactAt = Date.now();
  try {
    const tmp = `${contactFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: lastContactAt }), { mode: 0o600 });
    fs.renameSync(tmp, contactFile);
  } catch {
    // If the watchdog cannot read it, it treats the host as lost; that is the safe side
  }
}

function pcsReachable(): boolean {
  return lastContactAt > 0 && Date.now() - lastContactAt < Math.max(45_000, cfg.heartbeat_seconds * 3000);
}

function readWatchdog(): WatchdogStateFile | null {
  try {
    return JSON.parse(fs.readFileSync(watchdogFile, "utf8")) as WatchdogStateFile;
  } catch {
    return null;
  }
}

function hostState(): HostState | "UNKNOWN" {
  return readWatchdog()?.state ?? "UNKNOWN";
}

async function refreshEngineHealth(): Promise<void> {
  try {
    await engine.ping();
    engineHealthy = true;
    if (containerRuntime === "docker unavailable") {
      const v = await engine.version().catch(() => null);
      if (v) containerRuntime = `docker ${v.version}`;
    }
  } catch (e) {
    engineHealthy = false;
    if (lastEngineErrorAt < Date.now() - 60_000) {
      lastEngineErrorAt = Date.now();
      log(`Container engine unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function ensureIdentity(): Promise<void> {
  let saved = loadIdentity(cfg.identity_dir);
  if (saved && !saved.pcs_url) saved = { ...saved, pcs_url: cfg.pcs_url };
  if (saved && saved.pcs_url !== cfg.pcs_url) {
    log(`Identity belongs to ${saved.pcs_url}, not the current PCS ${cfg.pcs_url}; re-enrolling`);
    saved = null;
  }

  client = new PcsClient(cfg.pcs_url, 10_000, saved?.host_token, {
    caFile: cfg.pcs_ca_file,
    certFile: cfg.pcs_client_cert_file,
    keyFile: cfg.pcs_client_key_file,
  });

  if (saved && tokenUsable(saved)) {
    identity = saved;
    log(`Identity ${saved.host_id} (token valid until ${saved.expires_at})`);
    return;
  }

  if (saved) {
    try {
      const renewed = await client.renewToken();
      identity = { ...saved, ...renewed };
      saveIdentity(cfg.identity_dir, identity);
      client.setToken(identity.host_token);
      log(`Host token renewed until ${identity.expires_at}`);
      return;
    } catch (e) {
      const msg = e instanceof PcsClientError ? `${e.code}: ${e.message}` : String(e);
      log(`Token renewal failed: ${msg}`);
    }
  }

  if (!cfg.enrollment_token) {
    throw new Error(
      "No local identity and no one-time enrollment token. " +
        "Create the host in PCS, then restart with PCS_ENROLLMENT_TOKEN.",
    );
  }

  const info = hostInfo();
  await refreshEngineHealth().catch(() => {});
  const enrolled = await client.enroll({
    enrollment_token: cfg.enrollment_token,
    hostname: info.hostname,
    os: info.os,
    arch: info.arch,
    fingerprint: info.fingerprint,
    container_runtime: containerRuntime,
    runtime_version: RUNTIME_VERSION,
    resources: {
      cpu_total: os.cpus().length,
      mem_total_bytes: os.totalmem(),
    },
    devices: [],
    tools: [],
  });
  identity = {
    host_id: enrolled.host_id,
    host_token: enrolled.host_token,
    expires_at: enrolled.expires_at,
    pcs_url: cfg.pcs_url,
    enrolled_at: new Date().toISOString(),
  };
  saveIdentity(cfg.identity_dir, identity);
  client.setToken(identity.host_token);
  log(`Enrolled host_id=${identity.host_id}, token valid until ${identity.expires_at}`);
}

async function renewIdentity(): Promise<boolean> {
  if (!client || !identity) return false;
  try {
    const renewed = await client.renewToken();
    identity = { ...identity, ...renewed };
    saveIdentity(cfg.identity_dir, identity);
    client.setToken(identity.host_token);
    markContact();
    log(`Host token renewed until ${identity.expires_at}`);
    return true;
  } catch (e) {
    log(`Token renewal failed: ${describePcsError(e)}`);
    return false;
  }
}

async function withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PcsClientError && e.isUnauthorized && (await renewIdentity())) {
      return await fn();
    }
    throw e;
  }
}

function describePcsError(e: unknown): string {
  if (e instanceof PcsClientError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function notePcsError(e: unknown): void {
  if (e instanceof PcsClientError && e.isRevoked) {
    if (!revoked) {
      revoked = true;
      log("Host revoked by PCS: stopping command polling and new containers; running containers are left alone");
    }
    return;
  }
  if (Date.now() - lastPcsErrorAt > 30_000) {
    lastPcsErrorAt = Date.now();
    log(`PCS call failed: ${describePcsError(e)}`);
  }
}

/** Scheduler endpoint used to pull per-instance grants; learned from the heartbeat response. */
let grantBaseUrl: string | null = null;

async function heartbeatLoop(): Promise<void> {
  while (running && !revoked) {
    try {
      if (identity && !tokenUsable(identity)) await renewIdentity();
      const hb = await withAuthRetry(() =>
        client!.heartbeat({
          runtime: {
            version: RUNTIME_VERSION,
            container_runtime: containerRuntime,
            healthy: engineHealthy,
            capabilities: {
              // The control plane does not need to understand these, but an operator reading the
              // host record should see whether this machine is vetoed or has lost its audit trail.
              local_policy: policy.status(),
              audit_integrity: auditIntegrityOk && !audit.broken,
            },
          },
          host_state: hostState(),
          resources: {
            mem_available_bytes: memAvailableBytes(),
            load1: os.loadavg()[0],
            cpu_count: os.cpus().length,
          },
        }),
      );
      const root = (hb?.schedulers ?? []).find((s) => (s.role ?? "root") === "root") ??
        (hb?.schedulers ?? [])[0];
      if (root?.url) {
        if (grantBaseUrl !== root.url) {
          log(`Dynamic scheduling: using scheduler ${root.url} (mode ${root.scheduling_mode ?? "static"})`);
        }
        grantBaseUrl = String(root.url).replace(/\/+$/, "");
      }
      markContact();
    } catch (e) {
      notePcsError(e);
    }
    await sleep(cfg.heartbeat_seconds * 1000);
  }
}

let reportCpu: CpuTimes | null = null;

async function reportLoop(): Promise<void> {
  while (running && !revoked) {
    await refreshEngineHealth();
    try {
      const { sample, cpu } = sampleHost(reportCpu);
      reportCpu = cpu;
      const wd = readWatchdog();
      const report = await buildReport({
        hostId: identity!.host_id,
        runtimeVersion: RUNTIME_VERSION,
        containerRuntime,
        engine,
        sample,
        hostState: wd?.state ?? "UNKNOWN",
        engineHealthy,
        deployments: reconcilerInstance?.nativeReports() ?? [],
        pool: cgroup.snapshot() as unknown as Record<string, unknown>,
      });
      await withAuthRetry(() => client!.report(report));
      markContact();
    } catch (e) {
      notePcsError(e);
    }
    await sleep(cfg.report_seconds * 1000);
  }
}

/**
 * Dynamic scheduling: pull grants from the scheduler and apply them to each builder scope.
 * The applied generation is reported back with the next host report, which moves the grant to APPLIED.
 * Failure leaves the previous values in place; the scheduler keeps the grant PENDING and admission waits.
 */
let lastGrantErrorAt = 0;

async function grantLoop(): Promise<void> {
  while (running && !revoked) {
    const base = grantBaseUrl;
    if (base && cgroup.ready && identity?.host_id) {
      try {
        const res = await fetch(
          `${base}/v1/hosts/${encodeURIComponent(identity.host_id)}/resource-grants`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (res.ok) {
          const body = (await res.json()) as { items?: any[] };
          for (const grant of body.items ?? []) {
            if (!grant?.instance_id) continue;
            const applied: AppliedGrant = cgroup.applyGrant({
              instance_id: String(grant.instance_id),
              generation: Number(grant.generation) || 1,
              cpu_millicores: Number(grant.cpu_millicores) || 0,
              memory_bytes: Number(grant.memory_bytes) || 0,
              memory_low_bytes: Number(grant.memory_low_bytes) || 0,
              memory_high_bytes: Number(grant.memory_high_bytes) || 0,
              cpu_weight: Number(grant.cpu_weight) || 1,
              cap_cpu_millicores: Number(grant.cap_cpu_millicores) || 0,
              cap_memory_bytes: Number(grant.cap_mem_bytes) || 0,
            });
            if (applied.applied) cgroup.recordApplied(applied);
            else if (lastGrantErrorAt < Date.now() - 60_000) {
              lastGrantErrorAt = Date.now();
              log(`Failed to apply grant ${applied.instance_id} g${applied.generation}: ${applied.error}`);
            }
          }
        }
      } catch (e) {
        if (lastGrantErrorAt < Date.now() - 60_000) {
          lastGrantErrorAt = Date.now();
          log(`Failed to fetch grants: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    await sleep(Math.max(2, cfg.grant_poll_seconds) * 1000);
  }
}

async function ack(commandId: string, ok: boolean, result: Record<string, unknown>): Promise<void> {
  try {
    await withAuthRetry(() => client!.ack(commandId, ok, result));
    markContact();
  } catch (e) {
    // The command will be redelivered; processed_commands guarantees it is not executed twice
    notePcsError(e);
    log(`ack ${commandId} failed: ${describePcsError(e)}`);
  }
}

const reconciler = () =>
  new Reconciler({
    engine,
    state,
    cfg,
    broker,
    readWatchdog,
    log,
    poolScope: (instanceId) => (cgroup.ready ? cgroup.ensureScope(instanceId) : null),
    releasePoolScope: (instanceId) => cgroup.removeScope(instanceId),
    journal,
    policy,
    audit: (event, data) => audit.append(event, data),
    auditBroken: () => !auditIntegrityOk || audit.broken,
  });

let reconcilerInstance: Reconciler | null = null;

async function handleCommand(command: CommandPayload): Promise<void> {
  if (!identity) return;
  inFlight = true;
  try {
    let checked: CommandPayload;
    try {
      checked = validateCommand(command, {
        publicKeyPem: commandPublicKey!,
        hostId: identity.host_id,
        allowlist: cfg.image_allowlist,
        networkPolicies: cfg.network_policies,
      });
    } catch (e) {
      const code = e instanceof CommandRejected ? e.code : "COMMAND_REJECTED";
      log(`Rejected command ${command?.command_id ?? "?"}: ${code}`);
      audit.append("command.rejected", {
        command_id: command?.command_id ?? null,
        command_type: command?.command_type ?? null,
        code,
        message: e instanceof Error ? e.message : String(e),
      });
      if (command?.command_id) {
        await ack(command.command_id, false, {
          code,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    const processed = state.processed(checked.command_id);
    if (processed) {
      log(`Command ${checked.command_id} was already executed; idempotent ack`);
      await ack(checked.command_id, processed.ok, processed.result);
      return;
    }

    if (generationDecision(checked, state.appliedGeneration(checked.instance_id!)) === "STALE") {
      const result = {
        ignored: true,
        reason: "STALE_GENERATION",
        generation: checked.generation,
      };
      log(
        `Dropping stale generation command ${checked.command_id} ` +
          `gen=${checked.generation} applied=${state.appliedGeneration(checked.instance_id!)}`,
      );
      state.recordProcessed(checked.command_id, true, result);
      state.save();
      await ack(checked.command_id, true, result);
      return;
    }

    audit.append("command.received", {
      command_id: checked.command_id,
      command_type: checked.command_type,
      deployment_id: checked.deployment_id ?? null,
      instance_id: checked.instance_id ?? null,
      generation: checked.generation,
    });
    const outcome = await reconcilerInstance!.execute(checked, pcsReachable());
    state.recordProcessed(checked.command_id, outcome.ok, outcome.result);
    state.save();
    audit.append("command.result", {
      command_id: checked.command_id,
      command_type: checked.command_type,
      deployment_id: checked.deployment_id ?? null,
      instance_id: checked.instance_id ?? null,
      ok: outcome.ok,
      code: outcome.result.code ?? null,
      message: outcome.result.message ?? null,
    });
    log(
      `${checked.command_type} ${checked.command_id} -> ${outcome.ok ? "OK" : "FAILED"} ` +
        `${JSON.stringify(outcome.result).slice(0, 200)}`,
    );
    await ack(checked.command_id, outcome.ok, outcome.result);
  } finally {
    inFlight = false;
  }
}

async function commandLoop(): Promise<void> {
  while (running && !revoked) {
    let command: CommandPayload | null;
    try {
      command = await client!.nextCommand(cfg.command_wait_seconds);
      markContact();
    } catch (e) {
      notePcsError(e);
      await sleep(5000);
      continue;
    }
    if (!command) {
      await sleep(1000);
      continue;
    }
    await handleCommand(command);
  }
}

async function reconcileLoop(): Promise<void> {
  while (running && !revoked) {
    try {
      await reconcilerInstance!.reconcile(pcsReachable());
    } catch (e) {
      log(`Reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(15_000);
  }
}

async function main(): Promise<void> {
  log(
    `Starting: PCS=${cfg.pcs_url} docker=${cfg.docker_socket} ` +
      `socket=${cfg.admission_socket} image allowlist=${cfg.image_allowlist.join(",") || "(empty: all deployments rejected)"}`,
  );
  const wd = readWatchdog();
  const wdDecision = containerAdmission(
    wd,
    Date.now(),
    cfg.watchdog.sample_seconds,
    "DEPLOY",
  );
  if (!wdDecision.allowed) {
    log(`Watchdog state unavailable (${wdDecision.reason}): not creating new containers until the watchdog runs`);
  }

  // Verify the audit chain before doing anything that could be audited. A broken chain does not
  // stop the machine -- running workloads stay up -- but it blocks new deployments until fixed.
  const verified = audit.verify();
  if (!verified.ok) {
    auditIntegrityOk = false;
    log(
      `AUDIT CHAIN BROKEN at record ${verified.broken_at ?? "?"}: ${verified.reason ?? "unknown"}; ` +
        "new deployments are refused until the audit log is repaired",
    );
  } else {
    log(`Audit chain verified: ${verified.records} record(s)`);
  }
  audit.append("runtime.started", {
    version: RUNTIME_VERSION,
    audit_ok: verified.ok,
    policy: policy.status(),
  });

  admissionServer = await startAdmissionServer(broker, cfg.admission_socket);
  log(`Local admission socket listening at ${cfg.admission_socket} (0600)`);

  while (running) {
    try {
      await ensureIdentity();
      break;
    } catch (e) {
      log(`Enrollment not complete: ${e instanceof Error ? e.message : String(e)}; retrying in 10s`);
      await sleep(10_000);
    }
  }
  if (!running) return;

  reconcilerInstance = reconciler();
  // Undo anything a previous process began but never committed, before reconciliation touches the same names.
  await reconcilerInstance.recoverJournal();
  await refreshEngineHealth();
  // Pool capacity is the host total; the scheduler treats this same number as C_mem/C_cpu.
  cgroup.init(os.totalmem(), os.cpus().length * 1000);

  void heartbeatLoop();
  void reportLoop();
  void commandLoop();
  void reconcileLoop();
  void grantLoop();
}

async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;
  log(`${signal}: stopping command polling; running containers keep running`);
  admissionServer?.close();
  try {
    fs.unlinkSync(cfg.admission_socket);
  } catch {
    // Ignore
  }
  const deadline = Date.now() + 10_000;
  while (inFlight && Date.now() < deadline) await sleep(100);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((e) => {
  console.error("[runtime] failed to start", e);
  process.exit(1);
});
