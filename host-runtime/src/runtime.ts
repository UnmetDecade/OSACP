#!/usr/bin/env node
/**
 * Host Runtime 守护进程（每台物理机一个）。
 *
 * 只出站：注册 → 心跳 → 长轮询命令 → 验签/过期/镜像白名单/generation 检查 →
 * 执行容器生命周期 → ack → 上报。另开一个本机 unix socket 给角色容器做二次准入。
 *
 * 它不持有任务、不选择任务、不挂 Docker Socket 到角色容器，也不提供任意命令执行。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdmissionBroker, startAdmissionServer } from "./admission-broker.js";
import {
  CommandRejected,
  generationDecision,
  validateCommand,
  type CommandPayload,
} from "./command-verify.js";
import { DockerEngine } from "./docker-engine.js";
import { buildReport } from "./host-report.js";
import { hostInfo, loadIdentity, saveIdentity, tokenUsable, type HostIdentity } from "./identity.js";
import { memAvailableBytes, sampleHost, type CpuTimes } from "./metrics.js";
import { PcsClient, PcsClientError } from "./pcs-client.js";
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
    "缺少 PCS 命令公钥（command_public_key_file / PCS_COMMAND_PUBLIC_KEY_FILE）。" +
      "没有公钥就无法验签，拒绝启动。",
  );
  process.exit(1);
}

const engine = new DockerEngine(cfg.docker_socket, cfg.docker_timeout_ms);
const state = new RuntimeState(cfg.state_dir);
const contactFile = path.join(cfg.state_dir, "pcs-last-seen.json");
const watchdogFile = path.join(cfg.state_dir, "host-state.json");

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
    // 看门狗读不到会按失联处理，这是安全的一侧
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
      log(`容器引擎不可用：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function ensureIdentity(): Promise<void> {
  let saved = loadIdentity(cfg.identity_dir);
  if (saved && !saved.pcs_url) saved = { ...saved, pcs_url: cfg.pcs_url };
  if (saved && saved.pcs_url !== cfg.pcs_url) {
    log(`身份属于 ${saved.pcs_url}，与当前 PCS ${cfg.pcs_url} 不一致，重新注册`);
    saved = null;
  }

  client = new PcsClient(cfg.pcs_url, 10_000, saved?.host_token, {
    caFile: cfg.pcs_ca_file,
    certFile: cfg.pcs_client_cert_file,
    keyFile: cfg.pcs_client_key_file,
  });

  if (saved && tokenUsable(saved)) {
    identity = saved;
    log(`身份 ${saved.host_id}（令牌有效至 ${saved.expires_at}）`);
    return;
  }

  if (saved) {
    try {
      const renewed = await client.renewToken();
      identity = { ...saved, ...renewed };
      saveIdentity(cfg.identity_dir, identity);
      client.setToken(identity.host_token);
      log(`主机令牌已续期至 ${identity.expires_at}`);
      return;
    } catch (e) {
      const msg = e instanceof PcsClientError ? `${e.code}: ${e.message}` : String(e);
      log(`令牌续期失败：${msg}`);
    }
  }

  if (!cfg.enrollment_token) {
    throw new Error(
      "没有本机身份，也没有提供一次性注册令牌。" +
        "在 PCS 上创建主机后，用 PCS_ENROLLMENT_TOKEN 重新启动。",
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
  log(`注册成功 host_id=${identity.host_id}，令牌至 ${identity.expires_at}`);
}

async function renewIdentity(): Promise<boolean> {
  if (!client || !identity) return false;
  try {
    const renewed = await client.renewToken();
    identity = { ...identity, ...renewed };
    saveIdentity(cfg.identity_dir, identity);
    client.setToken(identity.host_token);
    markContact();
    log(`主机令牌已续期至 ${identity.expires_at}`);
    return true;
  } catch (e) {
    log(`令牌续期失败：${describePcsError(e)}`);
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
      log("主机已被 PCS 吊销：停止领取命令与启动新容器；已运行容器不杀");
    }
    return;
  }
  if (Date.now() - lastPcsErrorAt > 30_000) {
    lastPcsErrorAt = Date.now();
    log(`PCS 调用失败：${describePcsError(e)}`);
  }
}

async function heartbeatLoop(): Promise<void> {
  while (running && !revoked) {
    try {
      if (identity && !tokenUsable(identity)) await renewIdentity();
      await withAuthRetry(() =>
        client!.heartbeat({
          runtime: {
            version: RUNTIME_VERSION,
            container_runtime: containerRuntime,
            healthy: engineHealthy,
            capabilities: {},
          },
          host_state: hostState(),
          resources: {
            mem_available_bytes: memAvailableBytes(),
            load1: os.loadavg()[0],
            cpu_count: os.cpus().length,
          },
        }),
      );
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
      });
      await withAuthRetry(() => client!.report(report));
      markContact();
    } catch (e) {
      notePcsError(e);
    }
    await sleep(cfg.report_seconds * 1000);
  }
}

async function ack(commandId: string, ok: boolean, result: Record<string, unknown>): Promise<void> {
  try {
    await withAuthRetry(() => client!.ack(commandId, ok, result));
    markContact();
  } catch (e) {
    // 命令会被重投；processed_commands 保证不会重复执行
    notePcsError(e);
    log(`ack ${commandId} 失败：${describePcsError(e)}`);
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
      log(`拒绝命令 ${command?.command_id ?? "?"}：${code}`);
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
      log(`命令 ${checked.command_id} 已执行过，幂等 ack`);
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
        `丢弃过期 generation 命令 ${checked.command_id} ` +
          `gen=${checked.generation} 已应用=${state.appliedGeneration(checked.instance_id!)}`,
      );
      state.recordProcessed(checked.command_id, true, result);
      state.save();
      await ack(checked.command_id, true, result);
      return;
    }

    const outcome = await reconcilerInstance!.execute(checked, pcsReachable());
    state.recordProcessed(checked.command_id, outcome.ok, outcome.result);
    state.save();
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
      log(`对账失败：${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(15_000);
  }
}

async function main(): Promise<void> {
  log(
    `启动：PCS=${cfg.pcs_url} docker=${cfg.docker_socket} ` +
      `socket=${cfg.admission_socket} 镜像白名单=${cfg.image_allowlist.join(",") || "(空，拒绝全部部署)"}`,
  );
  const wd = readWatchdog();
  const wdDecision = containerAdmission(
    wd,
    Date.now(),
    cfg.watchdog.sample_seconds,
    "DEPLOY",
  );
  if (!wdDecision.allowed) {
    log(`看门狗状态不可用（${wdDecision.reason}）：重启后暂不创建新容器，先启动 watchdog`);
  }

  admissionServer = await startAdmissionServer(broker, cfg.admission_socket);
  log(`本机准入 socket 已监听 ${cfg.admission_socket}（0600）`);

  while (running) {
    try {
      await ensureIdentity();
      break;
    } catch (e) {
      log(`注册未完成：${e instanceof Error ? e.message : String(e)}；10s 后重试`);
      await sleep(10_000);
    }
  }
  if (!running) return;

  reconcilerInstance = reconciler();
  await refreshEngineHealth();

  void heartbeatLoop();
  void reportLoop();
  void commandLoop();
  void reconcileLoop();
}

async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;
  log(`${signal}：停止领取命令；已运行容器保持运行`);
  admissionServer?.close();
  try {
    fs.unlinkSync(cfg.admission_socket);
  } catch {
    // 忽略
  }
  const deadline = Date.now() + 10_000;
  while (inFlight && Date.now() < deadline) await sleep(100);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((e) => {
  console.error("[runtime] 启动失败", e);
  process.exit(1);
});
