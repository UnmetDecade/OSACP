import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdmissionBroker } from "./admission-broker.js";
import type { CommandPayload, InstanceSpec } from "./command-verify.js";
import { buildContainerConfig, containerName, volumeName } from "./container-spec.js";
import { DockerError, type EngineAdapter } from "./docker-engine.js";
import type { Operation, OperationJournal, OperationKind } from "./journal.js";
import type { HostPolicyGate, PolicyAction } from "./policy.js";
import type { RuntimeHostConfig } from "./runtime-config.js";
import type { LocalDeployment, RuntimeState } from "./runtime-state.js";
import { buildTar } from "./tar.js";
import { containerAdmission, type WatchdogStateFile } from "./watchdog-state.js";

/**
 * Workspace root for bare-metal role processes.
 *
 * A native builder runs as the host's login user, which cannot create directories under `/opt`
 * (owned by root), so the workspace lives in that user's home instead: a plain, stable directory
 * the administrator sees in `ls` and lands in when opening the terminal. Keep in sync with
 * `NATIVE_WORKSPACE_DIR` in pcs-issuer and the admin app's display.
 */
const NATIVE_WORKSPACE_DIR = path.join(os.homedir(), "platform", "workspace");

export interface CommandOutcome {
  ok: boolean;
  result: Record<string, unknown>;
}

export interface ReconcilerDeps {
  engine: EngineAdapter;
  state: RuntimeState;
  cfg: RuntimeHostConfig;
  broker: AdmissionBroker;
  readWatchdog: () => WatchdogStateFile | null;
  log: (message: string) => void;
  /** Returns the builder's cgroup scope (creating it) or null when the pool is unavailable. */
  poolScope?: (instanceId: string) => string | null;
  /** Drops a scope after the container is removed. */
  releasePoolScope?: (instanceId: string) => void;
  /** Host mutations, so a crash mid-deploy can be undone on the next start. */
  journal?: OperationJournal;
  /** Root-owned local veto; absent means no local policy is configured. */
  policy?: HostPolicyGate;
  /** Tamper-evident audit sink for command decisions and rollbacks. */
  audit?: (event: string, data?: Record<string, unknown>) => void;
  /** True when the audit chain failed verification or a write; new effects are refused. */
  auditBroken?: () => boolean;
  now?: () => number;
}

/** Journal handle for one command: every mutation of that command is committed or rolled back together. */
interface JournalTracker {
  begin(kind: OperationKind, target: string, detail?: Record<string, unknown>): Operation | null;
  applied(op: Operation | null): void;
}

/**
 * Reconcile the desired state (PCS commands + locally persisted desired state) against the actual state (Docker).
 * All container operations run serially; failed retries are backed off, so the same bad image is not pulled again every 15s.
 */
export class Reconciler {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly retryAfter = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  execute(command: CommandPayload, pcsReachable: boolean): Promise<CommandOutcome> {
    return this.serialize(async () => {
      const { ops, tracker } = this.journalTxn(command.command_id);
      const outcome = await this.runCommand(command, pcsReachable, tracker);

      if (outcome.ok) {
        for (const op of ops) this.deps.journal?.commit(op);
      } else {
        await this.rollbackOps(ops, `${command.command_type} ${command.command_id}`);
      }
      return outcome;
    });
  }

  private runCommand(
    command: CommandPayload,
    pcsReachable: boolean,
    txn: JournalTracker,
  ): Promise<CommandOutcome> {
    return (async () => {
      const label = `${command.command_type} ${command.deployment_id ?? command.instance_id}`;
      this.deps.log(`Executing ${label} gen=${command.generation}`);
      try {
        const { state } = this.deps;
        const deploymentId = command.deployment_id!;
        const instanceId = command.instance_id!;

        if (command.command_type === "DEPLOY") {
          if (!command.instance) {
            return fail("INVALID_COMMAND", "DEPLOY is missing the instance spec");
          }
          const grantId = command.resource_grant?.grant_id;
          if (!grantId) return fail("INVALID_GRANT", "DEPLOY is missing resource_grant");
          // A new deployment for the same instance supersedes the old one: drop the old local record, otherwise reconciliation keeps
          // rebuilding the container from the old image and fights the new deployment over the same container name.
          for (const other of state.listDeployments()) {
            if (other.instance_id === instanceId && other.deployment_id !== deploymentId) {
              state.removeDeployment(other.deployment_id);
            }
          }
          state.upsertDeployment({
            deployment_id: deploymentId,
            host_id: command.host_id,
            grant_id: grantId,
            generation: command.generation,
            spec: command.instance,
            desired_state: "RUNNING",
          });
          state.save();
          const dep = state.deployment(deploymentId)!;
          const out = await this.startDeployment(dep, "DEPLOY", pcsReachable, txn);
          if (!out.ok) return out;
          this.commit(dep, command.generation);
          return out;
        }

        const dep = state.deployment(deploymentId);

        if (command.command_type === "START" || command.command_type === "RESTART") {
          if (!dep) return fail("DEPLOYMENT_UNKNOWN", "This host has no desired state for this deployment; refusing START");
          state.setDesired(deploymentId, "RUNNING", command.generation);
          state.save();
          const out = await this.startDeployment(
            dep,
            command.command_type === "RESTART" ? "RESTART" : "START",
            pcsReachable,
            txn,
          );
          if (!out.ok) return out;
          this.commit(dep, command.generation);
          return out;
        }

        if (command.command_type === "STOP") {
          if (dep) {
            state.setDesired(deploymentId, "STOPPED", command.generation);
            state.save();
          }
          if (dep?.spec.execution === "native") {
            const pid = await this.stopNative(dep);
            this.commit(instanceId, command.generation);
            return ok({ native_pid: pid, state: "STOPPED" });
          }
          const name = containerName(instanceId);
          const existing = await this.deps.engine.inspect(name);
          if (existing && existing.state === "running") {
            await this.deps.engine.stop(name, this.deps.cfg.container_stop_timeout_seconds);
          }
          this.commit(instanceId, command.generation);
          return ok({ container_id: existing?.id ?? null, state: "STOPPED" });
        }

        if (command.command_type === "REMOVE") {
          // Removal destroys data. Journal it first so a crash mid-removal is visible as an
          // interrupted removal instead of a half-removed instance nobody notices.
          const atRisk = (dep?.spec.volumes ?? []).filter((v) => !v.name.startsWith("shared-")).map((v) => v.name);
          const removeOp = txn.begin("DEPLOYMENT_REMOVE", instanceId, {
            deployment_id: deploymentId,
            data_at_risk: atRisk,
          });
          if (dep) {
            state.setDesired(deploymentId, "REMOVED", command.generation);
            state.save();
          }
          if (dep?.spec.execution === "native") {
            const pid = await this.stopNative(dep);
            fs.rmSync(this.nativeRoot(dep.instance_id), { recursive: true, force: true });
            state.removeDeployment(deploymentId);
            state.save();
            txn.applied(removeOp);
            this.commit(instanceId, command.generation);
            return ok({ native_pid: pid, state: "REMOVED" });
          }
          const name = containerName(instanceId);
          const existing = await this.deps.engine.inspect(name);
          if (existing) {
            if (existing.state === "running") {
              await this.deps.engine.stop(name, this.deps.cfg.container_stop_timeout_seconds);
            }
            // The config option only controls the anonymous volumes Docker creates; platform-named volumes are removed separately.
            await this.deps.engine.remove(name, this.deps.cfg.remove_volumes_on_remove);
          }
          // REMOVE is a permanent deletion: even if the container is already gone, its data volumes must be cleared.
          if (dep) {
            for (const v of dep.spec.volumes ?? []) {
              // shared-* volumes are shared across the whole host; other containers may still be using them.
              if (v.name.startsWith("shared-")) continue;
              await this.deps.engine.removeVolume(volumeName(instanceId, v.name));
            }
          }
          if (dep) state.removeDeployment(deploymentId);
          state.save();
          txn.applied(removeOp);
          this.commit(instanceId, command.generation);
          return ok({ container_id: existing?.id ?? null, state: "REMOVED" });
        }

        return fail("COMMAND_TYPE_NOT_ALLOWED", `Unsupported ${command.command_type}`);
      } catch (e) {
        this.deps.log(`${label} failed: ${describe(e)}`);
        return fail(
          e instanceof DockerError ? e.code : "RUNTIME_ERROR",
          describe(e),
        );
      } finally {
        await this.refreshDeploymentGrants().catch((e) => this.deps.log(`Failed to refresh deployment reservations: ${describe(e)}`));
      }
    })();
  }

  private journalTxn(txnId: string): { ops: Operation[]; tracker: JournalTracker } {
    const ops: Operation[] = [];
    return {
      ops,
      tracker: {
        begin: (kind, target, detail = {}) => {
          const op = this.deps.journal?.begin(txnId, kind, target, detail) ?? null;
          if (op) ops.push(op);
          return op;
        },
        applied: (op) => {
          if (op) this.deps.journal?.applied(op);
        },
      },
    };
  }

  /**
   * Undo applied mutations in reverse order.
   *
   * Every step is idempotent and ownership-checked: by the time a rollback runs, the container may
   * already be gone, or may have been replaced by a newer deployment that must not be touched.
   */
  private async rollbackOps(ops: Operation[], label: string): Promise<void> {
    for (const op of [...ops].reverse()) {
      const result = await this.rollbackOperation(op).catch((e) => `rollback_failed: ${describe(e)}`);
      this.deps.journal?.rolledBack(op, result);
      this.deps.audit?.("command.rolled_back", {
        label,
        op_id: op.op_id,
        kind: op.kind,
        target: op.target,
        result,
        data_at_risk: op.detail.data_at_risk,
      });
      this.deps.log(`${label} rollback ${op.kind} ${op.target}: ${result}`);
    }
  }

  private async rollbackOperation(op: Operation): Promise<string> {
    const { engine, cfg } = this.deps;
    if (op.kind === "CONTAINER_CREATE") {
      const existing = await engine.inspect(op.target).catch(() => null);
      if (!existing) return "nothing_to_roll_back";
      const owner = existing.labels["platform.deployment_id"];
      if (op.detail.deployment_id && owner !== op.detail.deployment_id) return "ownership_changed";
      if (existing.state === "running") {
        await engine.stop(op.target, cfg.container_stop_timeout_seconds).catch(() => {});
      }
      // Anonymous volumes go with the container; named data volumes are left for an operator.
      await engine.remove(op.target, false);
      return "container_removed";
    }
    if (op.kind === "CONTAINER_START") {
      if (op.detail.was_running === true) return "was_already_running";
      const existing = await engine.inspect(op.target).catch(() => null);
      if (!existing || existing.state !== "running") return "not_running";
      if (op.detail.deployment_id && existing.labels["platform.deployment_id"] !== op.detail.deployment_id) {
        return "ownership_changed";
      }
      await engine.stop(op.target, cfg.container_stop_timeout_seconds);
      return "container_stopped";
    }
    if (op.kind === "NATIVE_START") {
      if (op.detail.was_running === true) return "was_already_running";
      const root = String(op.detail.root ?? "");
      if (!root) return "missing_root";
      const pid = await this.killNative(root);
      return pid ? "native_stopped" : "nothing_to_roll_back";
    }
    // DEPLOYMENT_REMOVE destroys data; there is nothing to put back, and pretending otherwise would be worse.
    return "not_reversible";
  }

  /**
   * Startup recovery: anything begun and never committed was interrupted mid-flight.
   * Undo it before reconciliation rebuilds from the desired state, otherwise a half-created
   * container fights the rebuild over the same name.
   */
  async recoverJournal(): Promise<void> {
    const journal = this.deps.journal;
    if (!journal) return;
    for (const op of journal.pending()) {
      const result = await this.rollbackOperation(op).catch((e) => `rollback_failed: ${describe(e)}`);
      journal.rolledBack(op, result);
      this.deps.audit?.("journal.recovered", {
        op_id: op.op_id,
        kind: op.kind,
        target: op.target,
        phase: op.phase,
        result,
        data_at_risk: op.detail.data_at_risk,
      });
      this.deps.log(`Recovered interrupted ${op.kind} ${op.target} (was ${op.phase}): ${result}`);
    }
  }

  private commit(instanceIdOrDep: string | LocalDeployment, generation: number): void {
    const instanceId =
      typeof instanceIdOrDep === "string" ? instanceIdOrDep : instanceIdOrDep.instance_id;
    this.deps.state.markApplied(instanceId, generation);
    this.deps.state.save();
  }

  /** Dispatch by execution mode: containers go through Docker, bare-metal roles run as a process on the host. */
  private startDeployment(
    dep: LocalDeployment,
    action: "DEPLOY" | "START" | "RESTART",
    pcsReachable: boolean,
    txn?: JournalTracker,
  ): Promise<CommandOutcome> {
    return dep.spec.execution === "native"
      ? this.ensureNativeRunning(dep, action, pcsReachable, txn)
      : this.ensureRunning(dep, action, pcsReachable, txn);
  }

  /** Data directory for a bare-metal instance: alongside the runtime state directory, isolated per instance. */
  private nativeRoot(instanceId: string): string {
    const safe = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
    return path.join(path.dirname(this.deps.cfg.state_dir), "native", safe);
  }

  private nativePidFile(root: string): string {
    return path.join(root, "agent.pid");
  }

  /**
   * Read the pid and confirm that this pid is still the agent process for this instance.
   * Checking only whether the pid is alive is not enough: after a host reboot the pid may be reused by another process.
   */
  private nativeProcess(root: string): { pid: number; alive: boolean } | null {
    const file = this.nativePidFile(root);
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(file, "utf8").trim());
    } catch {
      return null;
    }
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const probe = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 3000,
    });
    const cmd = String(probe.stdout ?? "");
    const expected = path.join(root, "app", "agent-runtime.mjs");
    if (probe.status !== 0 || !cmd.includes(expected)) {
      return { pid, alive: false };
    }
    return { pid, alive: true };
  }

  /** Write files delivered by the deployment to the local directory; paths still follow the /opt/platform convention and map under the instance root. */
  private writeNativeFiles(root: string, dep: LocalDeployment): void {
    for (const f of dep.spec.files ?? []) {
      const rel = f.path.startsWith("/opt/platform/")
        ? f.path.slice("/opt/platform/".length)
        : f.path.replace(/^\/+/, "");
      const target = path.resolve(root, rel);
      if (!target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`File path escapes the boundary: ${f.path}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, f.content, { mode: 0o600 });
    }
  }

  private nativeConfig(dep: LocalDeployment, root: string): Record<string, unknown> {
    const env = dep.spec.env ?? {};
    let capabilityDetail: unknown;
    try {
      capabilityDetail = env.CAPABILITY_DETAIL ? JSON.parse(env.CAPABILITY_DETAIL) : undefined;
    } catch {
      capabilityDetail = undefined;
    }
    const slots = Math.max(1, Number(env.MAX_CONCURRENCY ?? 1) || 1);
    const profiles = path.join(root, "profiles.json");
    return {
      scheduler_url: env.SCHEDULER_URL,
      heartbeat_seconds: 10,
      claim_interval_seconds: 0.5,
      lease_renew_seconds: 60,
      progress_seconds: 3,
      config_sync_seconds: 30,
      request_timeout_ms: 5000,
      token_dir: path.join(root, "tokens"),
      host_admission_socket: this.deps.cfg.admission_socket,
      // Bare-metal builders have no container filesystem. Use the same visible path a builder
      // container mounts, so build output is where administrators look for it instead of a hidden
      // runtime directory. Attempts stay in their own subdirectory, and are kept after the task so
      // the output can be inspected (and re-run) without digging through the runtime root.
      workspace_dir: NATIVE_WORKSPACE_DIR,
      keep_workspace: true,
      audit_dir: path.join(root, "audit"),
      ...(fs.existsSync(profiles) ? { profiles_file: profiles } : {}),
      instances: [
        {
          instance_id: dep.instance_id,
          role_id: dep.spec.role_id,
          host_id: dep.host_id,
          agent_profile_id: env.AGENT_PROFILE_ID || "agp_builder",
          task_types: ["task.build", "task.chat.builder", "task.console.builder"],
          capabilities: {
            healthy: ["code.build", "shell", "llm"],
            os: env.BUILDER_OS || process.platform,
          },
          ...(env.CAPABILITY_SCORE ? { capability_score: Number(env.CAPABILITY_SCORE) } : {}),
          ...(capabilityDetail ? { capability_detail: capabilityDetail } : {}),
          slots,
          slot_memory_bytes: Math.max(
            512 * 1024 ** 2,
            Math.floor(dep.spec.resource_profile.memory_limit_bytes / slots),
          ),
        },
      ],
    };
  }

  /** Start a builder process on the host; logs, pid and workspace all live in the instance directory. */
  private async ensureNativeRunning(
    dep: LocalDeployment,
    action: "DEPLOY" | "START" | "RESTART",
    pcsReachable: boolean,
    txn?: JournalTracker,
  ): Promise<CommandOutcome> {
    const gate = this.gate(action, pcsReachable, dep);
    if (!gate.allowed) return fail(gate.reason!, `This host does not currently allow starting role processes: ${gate.reason}`);

    const root = this.nativeRoot(dep.instance_id);
    const agentEntry = path.join(root, "app", "agent-runtime.mjs");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });

    const running = this.nativeProcess(root);
    if (running?.alive && action !== "RESTART") {
      return ok({ native_pid: running.pid, action: "already_running" });
    }
    if (running?.alive) await this.stopNative(dep);

    // Rewrite the deployment files on every start: the Profile, capability values and scheduler URL may all change with the deployment.
    this.writeNativeFiles(root, dep);
    for (const dir of ["app", "agents", "codex", "workspace", "logs", "tokens", "audit"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(agentEntry)) {
      return fail(
        "NATIVE_AGENT_MISSING",
        "No builder runtime on this host; start the runtime again from the host page and retry",
        { path: agentEntry },
      );
    }
    const env = dep.spec.env ?? {};
    if (!env.SCHEDULER_URL) {
      return fail("SCHEDULER_URL_MISSING", "Native builder is missing the scheduler URL");
    }
    const configPath = path.join(root, "runtime.config.json");
    fs.writeFileSync(configPath, JSON.stringify(this.nativeConfig(dep, root), null, 2), {
      mode: 0o600,
    });

    const admission = await this.deps.broker.checkDeployment(
      dep.grant_id,
      dep.instance_id,
      dep.spec.resource_profile.memory_limit_bytes,
    );
    if (!admission.allowed) {
      return fail("ADMISSION_DENIED_BY_HOST", "Insufficient live headroom on this host; refusing to start the builder", {
        observed: admission.observed,
        reason: admission.reason,
      });
    }

    const cache = this.deps.cfg.cache_dir;
    // Native builders resolve the Agent interpreter through the cache PATH; a host enrolled without that cache
    // (container hosts never need one) otherwise fails later with the opaque "spawn node ENOENT" from the adapter.
    const nodeReady = ensureNativeNode(cache);
    if (!nodeReady) {
      return fail(
        "NATIVE_RUNTIME_MISSING",
        "This host has no Node.js for native builders; install Node.js or provision ~/.platform/cache/node, then deploy again",
        { cache_dir: cache, exec_path: process.execPath },
      );
    }
    const profiles = path.join(root, "profiles.json");
    const spawnPath = [
      path.join(cache, "node", "bin"),
      path.join(cache, "agents"),
      process.env.PATH ?? "",
    ]
      .filter(Boolean)
      .join(":");
    // A builder without its agent CLI still starts and registers, then fails every dispatched task with
    // "spawn claude ENOENT". Refuse the start so the deploy command reports the missing command instead.
    const missingCli = missingAgentCli(profiles, dep.instance_id, spawnPath.split(":"));
    if (missingCli) {
      return fail(
        "AGENT_CLI_MISSING",
        `Builder Agent CLI is not installed on this host: ${missingCli}; install it on the host (or in ~/.platform/cache/agents) and deploy again`,
        { command: missingCli, cache_dir: cache },
      );
    }
    const agentEnv = this.readAgentEnv(dep.spec);
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...agentEnv,
      ...env,
      RUNTIME_CONFIG: configPath,
      // Entrypoint paths in the Agent Profile use the container convention /opt/platform/...;
      // in native mode the adapter maps them to the instance directory.
      PLATFORM_NATIVE_ROOT: root,
      CODEX_HOME: path.join(root, "codex"),
      INSTANCE_TOKEN_DIR: path.join(root, "tokens"),
      CLAIM_INTERVAL_SECONDS: "0.5",
      PATH: spawnPath,
      ...(fs.existsSync(profiles) ? { PROFILES_FILE: profiles } : {}),
    };
    const logPath = path.join(root, "logs", "agent.log");
    const out = fs.openSync(logPath, "a", 0o600);
    fs.writeSync(
      out,
      `\n=== ${new Date().toISOString()} start ${dep.deployment_id} gen=${dep.generation} ===\n`,
    );
    const spawnOp = txn?.begin("NATIVE_START", dep.instance_id, {
      deployment_id: dep.deployment_id,
      root,
      was_running: false,
    }) ?? null;
    let child;
    try {
      child = spawn(process.execPath, [agentEntry, "--instance", dep.instance_id], {
        cwd: path.join(root, "app"),
        env: spawnEnv,
        detached: true,
        stdio: ["ignore", out, out],
      });
    } finally {
      fs.closeSync(out);
    }
    if (!child?.pid) {
      return fail("NATIVE_SPAWN_FAILED", "Builder process failed to start");
    }
    child.unref();
    fs.writeFileSync(this.nativePidFile(root), String(child.pid), { mode: 0o600 });
    txn?.applied(spawnOp);

    // A process that exits shortly after starting (missing Node dependencies, bad config) must be reported on the spot, not left for the scheduler to time out.
    await new Promise((r) => setTimeout(r, 800));
    if (!this.nativeProcess(root)?.alive) {
      return fail("NATIVE_PROCESS_EXITED", "Builder process exited immediately after starting", {
        pid: child.pid,
        log: this.tailLog(logPath),
      });
    }
    return ok({ native_pid: child.pid, action: action === "RESTART" ? "restarted" : "started" });
  }

  /** Kill only a process confirmed to belong to this instance; do not kill the wrong one when a pid file has been reused. */
  private async stopNative(dep: LocalDeployment): Promise<number | null> {
    return this.killNative(this.nativeRoot(dep.instance_id));
  }

  private async killNative(root: string): Promise<number | null> {
    const info = this.nativeProcess(root);
    const pid = info?.pid ?? null;
    if (!info || !info.alive) {
      try {
        fs.unlinkSync(this.nativePidFile(root));
      } catch {
        /* no pid file */
      }
      return null;
    }
    try {
      process.kill(-info.pid, "SIGTERM");
    } catch {
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && this.nativeProcess(root)?.alive) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (this.nativeProcess(root)?.alive) {
      try {
        process.kill(-info.pid, "SIGKILL");
      } catch {
        try {
          process.kill(info.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    try {
      fs.unlinkSync(this.nativePidFile(root));
    } catch {
      /* ignore */
    }
    return pid;
  }

  private tailLog(file: string): string {
    try {
      return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-12).join("\n").slice(-2000);
    } catch {
      return "";
    }
  }

  /** Start / restart / idempotently start a container. An existing container with the same name must belong to the same deployment. */
  private async ensureRunning(
    dep: LocalDeployment,
    action: "DEPLOY" | "START" | "RESTART",
    pcsReachable: boolean,
    txn?: JournalTracker,
  ): Promise<CommandOutcome> {
    const gate = this.gate(action, pcsReachable, dep);
    if (!gate.allowed) return fail(gate.reason!, `This host does not currently allow starting containers: ${gate.reason}`);

    // The network a container references may not exist on this host (new host, network deleted).
    // Starting an existing container also fails with "network not found", so fill in the network before any start.
    await this.ensureNetwork(dep.spec);

    const name = containerName(dep.instance_id);
    let existing = await this.deps.engine.inspect(name).catch(() => null);

    if (existing) {
      const owner = existing.labels["platform.deployment_id"];
      if (owner !== dep.deployment_id) {
        // When an instance is redeployed (new image / new spec), the new deployment takes over the container name;
        // only a container belonging to another instance is a real conflict, otherwise remove the old one and rebuild to the new spec.
        if (existing.labels["platform.instance_id"] !== dep.instance_id) {
          return fail("CONTAINER_NAME_CONFLICT", `${name} is already in use by another deployment`, {
            owner,
          });
        }
        this.deps.log(`${name} belonged to the previous deployment ${owner}; now owned by ${dep.deployment_id}`);
        await this.deps.engine.remove(name, true);
        if (owner) this.deps.state.removeDeployment(owner);
        this.deps.state.save();
        existing = null;
      }
    }
    if (existing) {
      // Refresh the Profile files before restart/start: the Profile is part of the deployment intent, the old one must not be kept.
      if (action === "RESTART" && existing.state === "running") {
        await this.writeFiles(dep.spec, name);
        await this.deps.engine.restart(name, this.deps.cfg.container_stop_timeout_seconds);
        return ok({ container_id: existing.id, action: "restarted" });
      }
      if (existing.state !== "running") {
        const startOp = txn?.begin("CONTAINER_START", name, {
          deployment_id: dep.deployment_id,
          instance_id: dep.instance_id,
          was_running: false,
        }) ?? null;
        await this.writeFiles(dep.spec, name);
        await this.deps.engine.start(name);
        txn?.applied(startOp);
        return ok({ container_id: existing.id, action: "started" });
      }
      // Reconciliation reaches here on every round: the container is already running and the files are in place, so do not rewrite them.
      if (action === "DEPLOY") await this.writeFiles(dep.spec, name);
      return ok({ container_id: existing.id, action: "already_running" });
    }

    const admission = await this.deps.broker.checkDeployment(
      dep.grant_id,
      dep.instance_id,
      dep.spec.resource_profile.memory_limit_bytes,
    );
    if (!admission.allowed) {
      return fail("ADMISSION_DENIED_BY_HOST", "Insufficient live headroom on this host; refusing to create the container", {
        observed: admission.observed,
        reason: admission.reason,
      });
    }

    await this.ensureImage(dep.spec);
    // The cache directory must exist, otherwise Docker rejects the bind mount; its contents are delivered by the control plane on demand.
    if (this.deps.cfg.cache_dir) fs.mkdirSync(this.deps.cfg.cache_dir, { recursive: true });
    // Only builders share the pool; schedulers and platform containers stay outside it.
    const cgroupParent =
      dep.spec.role_id === "builder" ? (this.deps.poolScope?.(dep.instance_id) ?? undefined) : undefined;
    const config = buildContainerConfig(
      {
        deployment_id: dep.deployment_id,
        grant_id: dep.grant_id,
        host_id: dep.host_id,
        instance: dep.spec,
        cgroup_parent: cgroupParent,
      },
      this.deps.cfg,
      this.readAgentEnv(dep.spec),
    );
    const createOp = txn?.begin("CONTAINER_CREATE", name, {
      deployment_id: dep.deployment_id,
      instance_id: dep.instance_id,
      data_at_risk: (dep.spec.volumes ?? []).filter((v) => !v.name.startsWith("shared-")).map((v) => v.name),
    }) ?? null;
    try {
      await this.deps.engine.create(name, config);
      txn?.applied(createOp);
    } catch (e) {
      if (e instanceof DockerError && e.status === 409) {
        existing = await this.deps.engine.inspect(name);
        if (existing?.labels["platform.deployment_id"] !== dep.deployment_id) {
          return fail("CONTAINER_NAME_CONFLICT", `${name} is already in use by another container`);
        }
        // The container exists and is ours, so a rollback of this command still has to take it away.
        txn?.applied(createOp);
      } else {
        throw e;
      }
    }
    await this.writeFiles(dep.spec, name);
    await this.deps.engine.start(name);
    const info = await this.deps.engine.inspect(name);
    return ok({ container_id: info?.id ?? null, action: "created" });
  }

  /** Write deployment config files into the container; a failure means the deployment fails, and it must not start with an old Profile. */
  private async writeFiles(spec: InstanceSpec, name: string): Promise<void> {
    const files = spec.files ?? [];
    if (!files.length) return;
    await this.deps.engine.putArchive(name, "/", buildTar(files));
    this.deps.log(`Writing container config ${files.map((f) => f.path).join(", ")}`);
  }

  /**
   * Read only the variables named by the command out of the host credential file. Values never pass through the control plane;
   * a missing file or missing variable fails closed—better a failed deployment than an Agent running with empty keys.
   */
  private readAgentEnv(spec: InstanceSpec): Record<string, string> {
    const names = spec.agent_env ?? [];
    if (!names.length) return {};
    const file =
      this.deps.cfg.agent_env_file ?? path.join(os.homedir(), ".config", "platform", "agent-env");
    if (!fs.existsSync(file)) {
      throw new Error(`Host is missing credential file ${file}: the deployment requires ${names.join(", ")}`);
    }
    const values = new Map<string, string>();
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      values.set(m[1], m[2].replace(/^(["'])(.*)\1$/, "$2"));
    }
    const missing = names.filter((n) => !values.get(n));
    if (missing.length) {
      throw new Error(`Credential file ${file} is missing ${missing.join(", ")}`);
    }
    return Object.fromEntries(names.map((n) => [n, values.get(n)!]));
  }

  /** Map the container network policy to a local Docker network; bridge/none are built in and need no creation. */
  private async ensureNetwork(spec: InstanceSpec): Promise<void> {
    const networkMode = this.deps.cfg.network_policies[spec.network_policy] ?? "bridge";
    if (networkMode !== "bridge" && networkMode !== "none") {
      await this.deps.engine.ensureNetwork(networkMode);
    }
  }

  private async ensureImage(spec: InstanceSpec): Promise<void> {
    const inspected = await this.deps.engine.inspectImage(spec.image);
    if (inspected) {
      this.assertDigest(spec.image, inspected.repo_digests);
      return;
    }
    this.deps.log(`Pulling image ${spec.image}`);
    await this.deps.engine.pull(spec.image);
    const again = await this.deps.engine.inspectImage(spec.image);
    if (!again) throw new DockerError(500, "IMAGE_PULL_INCOMPLETE", "Image still not found after pulling");
    this.assertDigest(spec.image, again.repo_digests);
  }

  private assertDigest(image: string, repoDigests: string[]): void {
    const digest = image.slice(image.indexOf("@") + 1);
    if (repoDigests.length && !repoDigests.some((d) => d.endsWith(`@${digest}`))) {
      throw new DockerError(409, "IMAGE_DIGEST_MISMATCH", `Local image digest does not match the deployment intent: ${image}`);
    }
  }

  private gate(
    action: "DEPLOY" | "START" | "RESTART",
    pcsReachable: boolean,
    dep?: LocalDeployment,
  ): { allowed: boolean; reason?: string } {
    if (!pcsReachable) return { allowed: false, reason: "PCS_OFFLINE" };

    // Local policy is checked before anything else: an operator's veto outranks the control plane.
    const policy = this.deps.policy?.check({
      action: action as PolicyAction,
      role_id: dep?.spec.role_id,
      image: dep?.spec.image,
      active_deployments: this.deps.state
        .listDeployments()
        .filter((d) => d.desired_state === "RUNNING" && d.deployment_id !== dep?.deployment_id).length,
    });
    if (policy && !policy.allowed) {
      this.deps.audit?.("policy.denied", {
        action,
        deployment_id: dep?.deployment_id,
        instance_id: dep?.instance_id,
        reason: policy.reason,
      });
      return { allowed: false, reason: policy.reason ?? "POLICY_DENIED" };
    }

    // An audit chain that failed to write is not evidence of anything; do not add new effects on top.
    if (this.deps.auditBroken?.()) return { allowed: false, reason: "AUDIT_CHAIN_BROKEN" };

    return containerAdmission(
      this.deps.readWatchdog(),
      this.now(),
      this.deps.cfg.watchdog.sample_seconds,
      action,
    );
  }

  /** Recovery after restart: running containers stay up; when missing, rebuild from the desired state, but do nothing when PCS is unreachable or the watchdog is protecting. */
  reconcile(pcsReachable: boolean): Promise<void> {
    return this.serialize(async () => {
      const { state, engine, log } = this.deps;
      for (const dep of state.listDeployments()) {
        if (dep.spec.execution === "native") {
          await this.reconcileNative(dep, pcsReachable);
          continue;
        }
        const name = containerName(dep.instance_id);
        let existing = await engine.inspect(name).catch((e) => {
          log(`Reconcile ${name} failed: ${describe(e)}`);
          return null;
        });

        if (dep.desired_state === "REMOVED") {
          const removeTxn = this.journalTxn(`reconcile:${dep.deployment_id}`);
          const removeOp = removeTxn.tracker.begin("DEPLOYMENT_REMOVE", dep.instance_id, {
            deployment_id: dep.deployment_id,
            data_at_risk: (dep.spec.volumes ?? []).filter((v) => !v.name.startsWith("shared-")).map((v) => v.name),
          });
          if (existing) {
            if (existing.state === "running") {
              await engine.stop(name, this.deps.cfg.container_stop_timeout_seconds).catch(() => {});
            }
            await engine.remove(name, this.deps.cfg.remove_volumes_on_remove).catch(() => {});
          }
          // The container may already have been deleted by hand; the data volumes still belong to this REMOVE.
          for (const v of dep.spec.volumes ?? []) {
            if (v.name.startsWith("shared-")) continue;
            await engine.removeVolume(volumeName(dep.instance_id, v.name)).catch(() => {});
          }
          state.removeDeployment(dep.deployment_id);
          state.save();
          removeTxn.tracker.applied(removeOp);
          for (const op of removeTxn.ops) this.deps.journal?.commit(op);
          if (dep.spec.role_id === "builder") this.deps.releasePoolScope?.(dep.instance_id);
          continue;
        }

        if (dep.desired_state === "STOPPED") {
          if (existing?.state === "running") {
            await engine.stop(name, this.deps.cfg.container_stop_timeout_seconds).catch((e) =>
              log(`Stop ${name} failed: ${describe(e)}`),
            );
          }
          continue;
        }

        // desired RUNNING
        if (!pcsReachable) continue;
        const action = existing ? "START" : "DEPLOY";
        const gate = this.gate(action, pcsReachable, dep);
        if (!gate.allowed) continue;

        if (!existing && (this.retryAfter.get(dep.deployment_id) ?? 0) > this.now()) continue;
        const { ops, tracker } = this.journalTxn(`reconcile:${dep.deployment_id}`);
        try {
          const out = await this.ensureRunning(dep, action, pcsReachable, tracker);
          if (!out.ok) {
            await this.rollbackOps(ops, `reconcile ${name}`);
            if (!existing) this.retryAfter.set(dep.deployment_id, this.now() + 60_000);
            log(`Reconcile ${name} incomplete: ${String(out.result.code)}`);
          } else {
            for (const op of ops) this.deps.journal?.commit(op);
            this.retryAfter.delete(dep.deployment_id);
          }
        } catch (e) {
          await this.rollbackOps(ops, `reconcile ${name}`);
          if (!existing) this.retryAfter.set(dep.deployment_id, this.now() + 60_000);
          log(`Reconcile ${name} failed: ${describe(e)}`);
        }
      }
      await this.refreshDeploymentGrants();
    });
  }

  /**
   * Actual state of a bare-metal instance. The PCS report channel matches `containers` by deployment_id;
   * native has no container, so fake a running record here to keep deployments from being stuck in STARTING forever.
   */
  nativeReports(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const dep of this.deps.state.listDeployments()) {
      if (dep.spec.execution !== "native" || dep.desired_state !== "RUNNING") continue;
      const proc = this.nativeProcess(this.nativeRoot(dep.instance_id));
      if (!proc?.alive) continue;
      out.push({
        instance_id: dep.instance_id,
        deployment_id: dep.deployment_id,
        container_id: null,
        state: "running",
        health: "healthy",
        image: null,
        started_at: dep.updated_at,
        restart_count: 0,
        pid: proc.pid,
        execution: "native",
      });
    }
    return out;
  }

  /** Reconciliation for a bare-metal instance: do nothing while the process is up, start it from the desired state when missing, clean the directory on removal. */
  private async reconcileNative(dep: LocalDeployment, pcsReachable: boolean): Promise<void> {
    const { state, log } = this.deps;
    const root = this.nativeRoot(dep.instance_id);
    const running = this.nativeProcess(root);

    if (dep.desired_state === "REMOVED") {
      await this.stopNative(dep);
      fs.rmSync(root, { recursive: true, force: true });
      state.removeDeployment(dep.deployment_id);
      state.save();
      return;
    }
    if (dep.desired_state === "STOPPED") {
      if (running?.alive) await this.stopNative(dep);
      return;
    }
    if (running?.alive) return;
    if (!pcsReachable) return;
    const gate = this.gate("DEPLOY", pcsReachable, dep);
    if (!gate.allowed) return;
    if ((this.retryAfter.get(dep.deployment_id) ?? 0) > this.now()) return;
    const { ops, tracker } = this.journalTxn(`reconcile:${dep.deployment_id}`);
    try {
      const out = await this.ensureNativeRunning(dep, "DEPLOY", pcsReachable, tracker);
      if (!out.ok) {
        await this.rollbackOps(ops, `reconcile ${dep.instance_id}`);
        this.retryAfter.set(dep.deployment_id, this.now() + 60_000);
        log(`Reconcile ${dep.instance_id} incomplete: ${String(out.result.code)}`);
      } else {
        for (const op of ops) this.deps.journal?.commit(op);
        this.retryAfter.delete(dep.deployment_id);
      }
    } catch (e) {
      await this.rollbackOps(ops, `reconcile ${dep.instance_id}`);
      this.retryAfter.set(dep.deployment_id, this.now() + 60_000);
      log(`Reconcile ${dep.instance_id} failed: ${describe(e)}`);
    }
  }

  private async refreshDeploymentGrants(): Promise<void> {
    const containers = await this.deps.engine.listManaged();
    const running = containers.filter((c) => c.state === "running");
    const grants: Array<{ grant_id: string; instance_id: string; memory_bytes: number }> = [];
    for (const c of running) {
      const grantId = c.labels["platform.grant_id"];
      const deploymentId = c.labels["platform.deployment_id"];
      const instanceId = c.labels["platform.instance_id"];
      if (!grantId || !deploymentId || !instanceId) continue;
      const dep = this.deps.state.deployment(deploymentId);
      grants.push({
        grant_id: grantId,
        instance_id: instanceId,
        memory_bytes: dep?.spec.resource_profile.memory_limit_bytes ?? 0,
      });
    }
    // Bare-metal instances are not in the Docker list; count the running process into local admission usage separately.
    for (const dep of this.deps.state.listDeployments()) {
      if (dep.spec.execution !== "native" || dep.desired_state !== "RUNNING") continue;
      if (!this.nativeProcess(this.nativeRoot(dep.instance_id))?.alive) continue;
      grants.push({
        grant_id: dep.grant_id,
        instance_id: dep.instance_id,
        memory_bytes: dep.spec.resource_profile.memory_limit_bytes,
      });
    }
    this.deps.broker.setDeploymentGrants(grants);
  }
}

function ok(result: Record<string, unknown>): CommandOutcome {
  return { ok: true, result };
}

/**
 * Make sure a node binary is reachable for native builders: the spawn PATH is <cache>/node/bin first, then the
 * host PATH. When the cache is empty, link the runtime's own node into it — the runtime is itself running under node,
 * so this cannot point at a version the platform has not tested. Returns false when the host has no node at all.
 */
function ensureNativeNode(cacheDir: string): boolean {
  const binDir = path.join(cacheDir, "node", "bin");
  const nodePath = path.join(binDir, "node");
  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(cacheDir, "agents"), { recursive: true });
    try {
      fs.lstatSync(nodePath);
    } catch {
      fs.symlinkSync(process.execPath, nodePath);
    }
  } catch {
    // A read-only cache or foreign layout: fall through to the PATH check below.
  }
  if (fs.existsSync(nodePath)) return true;
  return (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .some((dir) => fs.existsSync(path.join(dir, "node")));
}

/** CLI commands that Agent Profiles select through --provider; --command overrides these. */
const PROVIDER_CLI: Record<string, string> = { claude: "claude", codex: "codex" };

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function resolveOnPath(command: string, dirs: string[]): boolean {
  if (command.includes("/")) return fs.existsSync(command);
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Find the agent CLI a bound Profile will spawn, and report it when the host does not have it.
 *
 * The adapter's entrypoint (`node cli-agent.mjs`) resolves through the cache, but the CLI it drives
 * (`claude`, `codex`, ...) is looked up on the spawn PATH; missing it only shows up at task time.
 */
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function missingAgentCli(
  profilesFile: string,
  instanceId: string,
  pathDirs: string[],
): string | null {
  if (!fs.existsSync(profilesFile)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(profilesFile, "utf8"));
  } catch {
    return null;
  }
  const root = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const all = Array.isArray(root.agent_profiles) ? root.agent_profiles : [];
  const bindings = root.bindings as Record<string, unknown> | undefined;
  const boundId = recordValue(bindings?.[instanceId])?.agent_profile_id;
  const profiles = boundId
    ? all.filter((p) => recordValue(p)?.agent_profile_id === boundId)
    : all;
  for (const raw of profiles) {
    const profile = recordValue(raw);
    if (!profile) continue;
    if (profile.enabled === false) continue;
    if (profile.adapter && profile.adapter !== "stdio-jsonrpc") continue;
    const args: string[] = Array.isArray(profile.args) ? profile.args.map(String) : [];
    const provider = flagValue(args, "--provider") ?? "claude";
    const command = flagValue(args, "--command") ?? PROVIDER_CLI[provider];
    if (!command) continue;
    if (!resolveOnPath(command, pathDirs)) return command;
  }
  return null;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): CommandOutcome {
  return { ok: false, result: { code, message, ...(detail ?? {}) } };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
