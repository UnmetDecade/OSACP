import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdmissionBroker } from "./admission-broker.js";
import type { CommandPayload, InstanceSpec } from "./command-verify.js";
import { buildContainerConfig, containerName, volumeName } from "./container-spec.js";
import { DockerError, type EngineAdapter } from "./docker-engine.js";
import type { RuntimeHostConfig } from "./runtime-config.js";
import type { LocalDeployment, RuntimeState } from "./runtime-state.js";
import { buildTar } from "./tar.js";
import { containerAdmission, type WatchdogStateFile } from "./watchdog-state.js";

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
  now?: () => number;
}

/**
 * 期望态（PCS 的命令 + 本机持久化的 desired state）与实际态（Docker）对账。
 * 所有容器操作串行执行；失败重试有退避，不会每 15s 重复拉同一个坏镜像。
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
      const label = `${command.command_type} ${command.deployment_id ?? command.instance_id}`;
      this.deps.log(`执行 ${label} gen=${command.generation}`);
      try {
        const { state } = this.deps;
        const deploymentId = command.deployment_id!;
        const instanceId = command.instance_id!;

        if (command.command_type === "DEPLOY") {
          if (!command.instance) {
            return fail("INVALID_COMMAND", "DEPLOY 缺少实例规格");
          }
          const grantId = command.resource_grant?.grant_id;
          if (!grantId) return fail("INVALID_GRANT", "DEPLOY 缺少 resource_grant");
          // 同一实例的新部署取代旧部署：丢掉本机旧记录，否则对账会继续
          // 按旧镜像重建容器，和新部署反复抢同一个容器名。
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
          const out = await this.startDeployment(dep, "DEPLOY", pcsReachable);
          if (!out.ok) return out;
          this.commit(dep, command.generation);
          return out;
        }

        const dep = state.deployment(deploymentId);

        if (command.command_type === "START" || command.command_type === "RESTART") {
          if (!dep) return fail("DEPLOYMENT_UNKNOWN", "本机没有这个部署的期望态，拒绝 START");
          state.setDesired(deploymentId, "RUNNING", command.generation);
          state.save();
          const out = await this.startDeployment(
            dep,
            command.command_type === "RESTART" ? "RESTART" : "START",
            pcsReachable,
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
          if (dep) {
            state.setDesired(deploymentId, "REMOVED", command.generation);
            state.save();
          }
          if (dep?.spec.execution === "native") {
            const pid = await this.stopNative(dep);
            fs.rmSync(this.nativeRoot(dep.instance_id), { recursive: true, force: true });
            state.removeDeployment(deploymentId);
            state.save();
            this.commit(instanceId, command.generation);
            return ok({ native_pid: pid, state: "REMOVED" });
          }
          const name = containerName(instanceId);
          const existing = await this.deps.engine.inspect(name);
          if (existing) {
            if (existing.state === "running") {
              await this.deps.engine.stop(name, this.deps.cfg.container_stop_timeout_seconds);
            }
            // 配置项只决定 Docker 创建的匿名卷；平台命名卷单独删。
            await this.deps.engine.remove(name, this.deps.cfg.remove_volumes_on_remove);
          }
          // REMOVE 是永久删除：即使容器已经不在，也要把它的数据卷清掉。
          if (dep) {
            for (const v of dep.spec.volumes ?? []) {
              // shared-* 是整台主机共用的卷，别的容器可能还在用。
              if (v.name.startsWith("shared-")) continue;
              await this.deps.engine.removeVolume(volumeName(instanceId, v.name));
            }
          }
          if (dep) state.removeDeployment(deploymentId);
          state.save();
          this.commit(instanceId, command.generation);
          return ok({ container_id: existing?.id ?? null, state: "REMOVED" });
        }

        return fail("COMMAND_TYPE_NOT_ALLOWED", `不支持 ${command.command_type}`);
      } catch (e) {
        this.deps.log(`${label} 失败：${describe(e)}`);
        return fail(
          e instanceof DockerError ? e.code : "RUNTIME_ERROR",
          describe(e),
        );
      } finally {
        await this.refreshDeploymentGrants().catch((e) => this.deps.log(`更新部署占用失败：${describe(e)}`));
      }
    });
  }

  private commit(instanceIdOrDep: string | LocalDeployment, generation: number): void {
    const instanceId =
      typeof instanceIdOrDep === "string" ? instanceIdOrDep : instanceIdOrDep.instance_id;
    this.deps.state.markApplied(instanceId, generation);
    this.deps.state.save();
  }

  /** 按执行方式分派：容器走 Docker，裸机角色在宿主机上拉起进程。 */
  private startDeployment(
    dep: LocalDeployment,
    action: "DEPLOY" | "START" | "RESTART",
    pcsReachable: boolean,
  ): Promise<CommandOutcome> {
    return dep.spec.execution === "native"
      ? this.ensureNativeRunning(dep, action, pcsReachable)
      : this.ensureRunning(dep, action, pcsReachable);
  }

  /** 裸机实例的数据目录：与 runtime 状态目录同级，按实例隔离。 */
  private nativeRoot(instanceId: string): string {
    const safe = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
    return path.join(path.dirname(this.deps.cfg.state_dir), "native", safe);
  }

  private nativePidFile(root: string): string {
    return path.join(root, "agent.pid");
  }

  /**
   * 读 pid 并确认这个 pid 仍然是本实例的 agent 进程。
   * 只看 pid 是否存活不够：主机重启后 pid 会被别的进程复用。
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

  /** 写部署下发的文件到本机目录；路径仍按 /opt/platform 的约定，映射到实例根下。 */
  private writeNativeFiles(root: string, dep: LocalDeployment): void {
    for (const f of dep.spec.files ?? []) {
      const rel = f.path.startsWith("/opt/platform/")
        ? f.path.slice("/opt/platform/".length)
        : f.path.replace(/^\/+/, "");
      const target = path.resolve(root, rel);
      if (!target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`文件路径越界：${f.path}`);
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
      workspace_dir: path.join(root, "workspace"),
      keep_workspace: false,
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

  /** 宿主机上启动一个构建机进程；日志、pid、workspace 都放在实例目录。 */
  private async ensureNativeRunning(
    dep: LocalDeployment,
    action: "DEPLOY" | "START" | "RESTART",
    pcsReachable: boolean,
  ): Promise<CommandOutcome> {
    const gate = this.gate(action, pcsReachable);
    if (!gate.allowed) return fail(gate.reason!, `本机当前不允许启动角色进程：${gate.reason}`);

    const root = this.nativeRoot(dep.instance_id);
    const agentEntry = path.join(root, "app", "agent-runtime.mjs");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });

    const running = this.nativeProcess(root);
    if (running?.alive && action !== "RESTART") {
      return ok({ native_pid: running.pid, action: "already_running" });
    }
    if (running?.alive) await this.stopNative(dep);

    // 每次启动都重写部署文件：Profile、能力值、调度机地址都可能随部署变化。
    this.writeNativeFiles(root, dep);
    for (const dir of ["app", "agents", "codex", "workspace", "logs", "tokens", "audit"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(agentEntry)) {
      return fail(
        "NATIVE_AGENT_MISSING",
        "主机上没有构建机运行时；请在主机页重新「启动 runtime」后再试",
        { path: agentEntry },
      );
    }
    const env = dep.spec.env ?? {};
    if (!env.SCHEDULER_URL) {
      return fail("SCHEDULER_URL_MISSING", "裸机构建机缺少调度机地址");
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
      return fail("ADMISSION_DENIED_BY_HOST", "本机实时余量不足，拒绝启动构建机", {
        observed: admission.observed,
        reason: admission.reason,
      });
    }

    const cache = this.deps.cfg.cache_dir;
    const profiles = path.join(root, "profiles.json");
    const agentEnv = this.readAgentEnv(dep.spec);
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...agentEnv,
      ...env,
      RUNTIME_CONFIG: configPath,
      // Agent Profile 里的入口路径按容器约定写的是 /opt/platform/...；
      // 裸机模式由 adapter 映射到实例目录。
      PLATFORM_NATIVE_ROOT: root,
      CODEX_HOME: path.join(root, "codex"),
      INSTANCE_TOKEN_DIR: path.join(root, "tokens"),
      CLAIM_INTERVAL_SECONDS: "0.5",
      PATH: [
        path.join(cache, "node", "bin"),
        path.join(cache, "agents"),
        process.env.PATH ?? "",
      ]
        .filter(Boolean)
        .join(":"),
      ...(fs.existsSync(profiles) ? { PROFILES_FILE: profiles } : {}),
    };
    const logPath = path.join(root, "logs", "agent.log");
    const out = fs.openSync(logPath, "a", 0o600);
    fs.writeSync(
      out,
      `\n=== ${new Date().toISOString()} start ${dep.deployment_id} gen=${dep.generation} ===\n`,
    );
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
      return fail("NATIVE_SPAWN_FAILED", "构建机进程启动失败");
    }
    child.unref();
    fs.writeFileSync(this.nativePidFile(root), String(child.pid), { mode: 0o600 });

    // 进程起来后很快退出（缺 Node 依赖、配置错误）要当场报出来，不能等调度机超时。
    await new Promise((r) => setTimeout(r, 800));
    if (!this.nativeProcess(root)?.alive) {
      return fail("NATIVE_PROCESS_EXITED", "构建机进程启动后立即退出", {
        pid: child.pid,
        log: this.tailLog(logPath),
      });
    }
    return ok({ native_pid: child.pid, action: action === "RESTART" ? "restarted" : "started" });
  }

  /** 只杀确认属于本实例的进程；pid 文件被复用时不误杀。 */
  private async stopNative(dep: LocalDeployment): Promise<number | null> {
    const root = this.nativeRoot(dep.instance_id);
    const info = this.nativeProcess(root);
    const pid = info?.pid ?? null;
    if (!info || !info.alive) {
      try {
        fs.unlinkSync(this.nativePidFile(root));
      } catch {
        /* 没有 pid 文件 */
      }
      return null;
    }
    try {
      process.kill(-info.pid, "SIGTERM");
    } catch {
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        /* 已经退出 */
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

  /** 启动 / 重启 / 幂等启动一个容器。已存在的同名容器必须属于同一部署。 */
  private async ensureRunning(
    dep: LocalDeployment,
    action: "DEPLOY" | "START" | "RESTART",
    pcsReachable: boolean,
  ): Promise<CommandOutcome> {
    const gate = this.gate(action, pcsReachable);
    if (!gate.allowed) return fail(gate.reason!, `本机当前不允许启动容器：${gate.reason}`);

    // 容器引用的网络可能不在本机（新主机、网络被删过）。启动既有容器
    // 也会因为 network not found 失败，所以先补齐网络再谈 start。
    await this.ensureNetwork(dep.spec);

    const name = containerName(dep.instance_id);
    let existing = await this.deps.engine.inspect(name).catch(() => null);

    if (existing) {
      const owner = existing.labels["platform.deployment_id"];
      if (owner !== dep.deployment_id) {
        // 同一实例重新部署（换镜像 / 换规格）时，新部署接管容器名；
        // 只有容器属于别的实例才算真冲突，否则先移除旧容器再按新规格重建。
        if (existing.labels["platform.instance_id"] !== dep.instance_id) {
          return fail("CONTAINER_NAME_CONFLICT", `${name} 已被其他部署占用`, {
            owner,
          });
        }
        this.deps.log(`${name} 属于旧部署 ${owner}，由 ${dep.deployment_id} 接管`);
        await this.deps.engine.remove(name, true);
        if (owner) this.deps.state.removeDeployment(owner);
        this.deps.state.save();
        existing = null;
      }
    }
    if (existing) {
      // 重启/拉起前刷新 Profile 文件：Profile 是部署意图的一部分，不能继续用旧的。
      if (action === "RESTART" && existing.state === "running") {
        await this.writeFiles(dep.spec, name);
        await this.deps.engine.restart(name, this.deps.cfg.container_stop_timeout_seconds);
        return ok({ container_id: existing.id, action: "restarted" });
      }
      if (existing.state !== "running") {
        await this.writeFiles(dep.spec, name);
        await this.deps.engine.start(name);
        return ok({ container_id: existing.id, action: "started" });
      }
      // 对账每轮都会走到这里：容器已经在跑、文件也已就位，不再重复写。
      if (action === "DEPLOY") await this.writeFiles(dep.spec, name);
      return ok({ container_id: existing.id, action: "already_running" });
    }

    const admission = await this.deps.broker.checkDeployment(
      dep.grant_id,
      dep.instance_id,
      dep.spec.resource_profile.memory_limit_bytes,
    );
    if (!admission.allowed) {
      return fail("ADMISSION_DENIED_BY_HOST", "本机实时余量不足，拒绝创建容器", {
        observed: admission.observed,
        reason: admission.reason,
      });
    }

    await this.ensureImage(dep.spec);
    // 缓存目录必须存在，否则 Docker 会拒绝 bind mount；内容由控制面按需下发。
    if (this.deps.cfg.cache_dir) fs.mkdirSync(this.deps.cfg.cache_dir, { recursive: true });
    const config = buildContainerConfig(
      {
        deployment_id: dep.deployment_id,
        grant_id: dep.grant_id,
        host_id: dep.host_id,
        instance: dep.spec,
      },
      this.deps.cfg,
      this.readAgentEnv(dep.spec),
    );
    try {
      await this.deps.engine.create(name, config);
    } catch (e) {
      if (e instanceof DockerError && e.status === 409) {
        existing = await this.deps.engine.inspect(name);
        if (existing?.labels["platform.deployment_id"] !== dep.deployment_id) {
          return fail("CONTAINER_NAME_CONFLICT", `${name} 已被其他容器占用`);
        }
      } else {
        throw e;
      }
    }
    await this.writeFiles(dep.spec, name);
    await this.deps.engine.start(name);
    const info = await this.deps.engine.inspect(name);
    return ok({ container_id: info?.id ?? null, action: "created" });
  }

  /** 部署带来的配置文件写进容器；失败即部署失败，不能带着旧 Profile 启动。 */
  private async writeFiles(spec: InstanceSpec, name: string): Promise<void> {
    const files = spec.files ?? [];
    if (!files.length) return;
    await this.deps.engine.putArchive(name, "/", buildTar(files));
    this.deps.log(`写入容器配置 ${files.map((f) => f.path).join(", ")}`);
  }

  /**
   * 只把命令点名的变量从主机凭据文件读出来。值不经过控制面，
   * 缺文件或缺变量都失败关闭——宁可部署失败，也不让 Agent 拿着空密钥跑。
   */
  private readAgentEnv(spec: InstanceSpec): Record<string, string> {
    const names = spec.agent_env ?? [];
    if (!names.length) return {};
    const file =
      this.deps.cfg.agent_env_file ?? path.join(os.homedir(), ".config", "platform", "agent-env");
    if (!fs.existsSync(file)) {
      throw new Error(`主机缺少凭据文件 ${file}：部署需要 ${names.join(", ")}`);
    }
    const values = new Map<string, string>();
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      values.set(m[1], m[2].replace(/^(["'])(.*)\1$/, "$2"));
    }
    const missing = names.filter((n) => !values.get(n));
    if (missing.length) {
      throw new Error(`凭据文件 ${file} 缺少 ${missing.join(", ")}`);
    }
    return Object.fromEntries(names.map((n) => [n, values.get(n)!]));
  }

  /** 容器网络策略映射到本机 Docker 网络；bridge/none 是内置的，不用建。 */
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
    this.deps.log(`拉取镜像 ${spec.image}`);
    await this.deps.engine.pull(spec.image);
    const again = await this.deps.engine.inspectImage(spec.image);
    if (!again) throw new DockerError(500, "IMAGE_PULL_INCOMPLETE", "拉取后仍找不到镜像");
    this.assertDigest(spec.image, again.repo_digests);
  }

  private assertDigest(image: string, repoDigests: string[]): void {
    const digest = image.slice(image.indexOf("@") + 1);
    if (repoDigests.length && !repoDigests.some((d) => d.endsWith(`@${digest}`))) {
      throw new DockerError(409, "IMAGE_DIGEST_MISMATCH", `本地镜像 digest 与部署意图不一致：${image}`);
    }
  }

  private gate(
    action: "DEPLOY" | "START" | "RESTART",
    pcsReachable: boolean,
  ): { allowed: boolean; reason?: string } {
    if (!pcsReachable) return { allowed: false, reason: "PCS_OFFLINE" };
    return containerAdmission(
      this.deps.readWatchdog(),
      this.now(),
      this.deps.cfg.watchdog.sample_seconds,
      action,
    );
  }

  /** 重启后恢复：容器继续跑；缺失时按期望态重建，但 PCS 失联或看门狗保护时不动。 */
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
          log(`对账 ${name} 失败：${describe(e)}`);
          return null;
        });

        if (dep.desired_state === "REMOVED") {
          if (existing) {
            if (existing.state === "running") {
              await engine.stop(name, this.deps.cfg.container_stop_timeout_seconds).catch(() => {});
            }
            await engine.remove(name, this.deps.cfg.remove_volumes_on_remove).catch(() => {});
          }
          // 容器可能已被手工删掉；数据卷仍然属于这次 REMOVE。
          for (const v of dep.spec.volumes ?? []) {
            if (v.name.startsWith("shared-")) continue;
            await engine.removeVolume(volumeName(dep.instance_id, v.name)).catch(() => {});
          }
          state.removeDeployment(dep.deployment_id);
          state.save();
          continue;
        }

        if (dep.desired_state === "STOPPED") {
          if (existing?.state === "running") {
            await engine.stop(name, this.deps.cfg.container_stop_timeout_seconds).catch((e) =>
              log(`停止 ${name} 失败：${describe(e)}`),
            );
          }
          continue;
        }

        // desired RUNNING
        if (!pcsReachable) continue;
        const action = existing ? "START" : "DEPLOY";
        const gate = this.gate(action, pcsReachable);
        if (!gate.allowed) continue;

        if (!existing && (this.retryAfter.get(dep.deployment_id) ?? 0) > this.now()) continue;
        try {
          const out = await this.ensureRunning(dep, action, pcsReachable);
          if (!out.ok) {
            if (!existing) this.retryAfter.set(dep.deployment_id, this.now() + 60_000);
            log(`对账 ${name} 未完成：${String(out.result.code)}`);
          } else {
            this.retryAfter.delete(dep.deployment_id);
          }
        } catch (e) {
          if (!existing) this.retryAfter.set(dep.deployment_id, this.now() + 60_000);
          log(`对账 ${name} 失败：${describe(e)}`);
        }
      }
      await this.refreshDeploymentGrants();
    });
  }

  /**
   * 裸机实例的实际态。PCS 的上报通道按 deployment_id 匹配 `containers`，
   * native 没有容器，就在这里伪装成一条 running 记录，避免部署永远停在 STARTING。
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

  /** 裸机实例的对账：进程在就什么都不做，缺失时按期望态拉起，删除时清目录。 */
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
    const gate = this.gate("DEPLOY", pcsReachable);
    if (!gate.allowed) return;
    if ((this.retryAfter.get(dep.deployment_id) ?? 0) > this.now()) return;
    try {
      const out = await this.ensureNativeRunning(dep, "DEPLOY", pcsReachable);
      if (!out.ok) {
        this.retryAfter.set(dep.deployment_id, this.now() + 60_000);
        log(`对账 ${dep.instance_id} 未完成：${String(out.result.code)}`);
      } else {
        this.retryAfter.delete(dep.deployment_id);
      }
    } catch (e) {
      this.retryAfter.set(dep.deployment_id, this.now() + 60_000);
      log(`对账 ${dep.instance_id} 失败：${describe(e)}`);
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
    // 裸机实例不在 Docker 列表里，单独把在跑的进程算进本机准入占用。
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

function fail(code: string, message: string, detail?: Record<string, unknown>): CommandOutcome {
  return { ok: false, result: { code, message, ...(detail ?? {}) } };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
