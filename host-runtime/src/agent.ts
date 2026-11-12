import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LocalAdmission } from "./admission.js";
import { SchedulerClient, SchedulerError, type Assignment } from "./client.js";
import type { InstanceConfig } from "./config.js";
import { TaskAborted, TaskFailed, executorFor } from "./executor.js";
import { checkHostAdmission, listHostGrants, releaseHostAdmission } from "./host-admission-client.js";
import { memAvailableBytes, sample } from "./metrics.js";
import { ApiAdapter } from "./agent-runtime/api-adapter.js";
import { runAgentTask } from "./agent-runtime/agent-executor.js";
import {
  assertEnvelopeAllowed,
  ProfileRejected,
  supportsTask,
  type RuntimeProfiles,
} from "./agent-runtime/profiles.js";
import { SecretClient } from "./agent-runtime/secret-client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Running {
  task: Assignment;
  controller: AbortController;
}

export interface AgentTuning {
  heartbeatSeconds: number;
  claimIntervalSeconds: number;
  leaseRenewSeconds: number;
  progressSeconds: number;
  configSyncSeconds: number;
  /** Host Runtime 的本机准入 socket；未设置时退回进程内 LocalAdmission */
  hostAdmissionSocket?: string;
  /** 每个 attempt 的工作目录根；默认 data/workspace */
  workspaceDir: string;
  /** 调试用：任务结束后保留工作目录 */
  keepWorkspace?: boolean;
  /** 本实例已加载的 Agent/API Profile；缺省时只用确定性执行器 */
  profiles?: RuntimeProfiles;
  /** Secret Store 地址与实例身份令牌（只用于换取短期凭据） */
  secretStoreUrl?: string;
  instanceToken?: string | (() => string | undefined);
  egressPolicies?: Record<string, string[]>;
  allowLoopbackEgress?: boolean;
  /** 工具/API 审计目录 */
  auditDir?: string;
}

/**
 * 一个角色实例（role-agent）的生命周期。
 *
 * 这个进程里没有“调度”判断：领什么任务由调度机决定，它只负责
 * 「问 → 本地再判一次 → 执行 → 报结果」，以及把一切都带上 fencing。
 */
export class Agent {
  private readonly id: string;
  private readonly slots: number;
  private readonly slotMemoryBytes: number;
  private readonly admission: LocalAdmission;
  private running = new Map<string, Running>();
  private draining = false;
  private hbTimer?: NodeJS.Timeout;
  private configVersion?: number;
  private admissionBackoffUntil = 0;
  private apiAdapter?: ApiAdapter;
  private secretClient?: SecretClient;

  constructor(
    private readonly cfg: InstanceConfig,
    private readonly client: SchedulerClient,
    private readonly tuning: AgentTuning,
  ) {
    this.id = cfg.instance_id;
    this.slots = cfg.slots ?? 1;
    this.slotMemoryBytes = cfg.slot_memory_bytes ?? 1024 ** 3;
    this.admission = new LocalAdmission(memAvailableBytes, this.slotMemoryBytes);
  }

  /**
   * 启动对账：上次进程被 kill 时没有机会 release，本实例名下的残留 TASK grant
   * 会一直占着内存直到 TTL。重启后先按 instance_id 清掉，恢复真实余量。
   */
  private async reconcileHostGrants(): Promise<void> {
    const socket = this.tuning.hostAdmissionSocket;
    if (!socket) return;
    try {
      const { items } = await listHostGrants(socket);
      const mine = items.filter((g) => g.instance_id === this.id);
      for (const g of mine) await releaseHostAdmission(socket, g.grant_id);
      if (mine.length) this.log(`启动对账：释放 ${mine.length} 个残留 task grant`);
    } catch (e) {
      // Runtime 可能还没起来；准入时仍会失败关闭，不阻塞启动
      this.log(`启动对账跳过：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 准入被拒或不可用：按 claim 间隔退避，避免原地刷 attempt */
  private backOffAfterAdmission(): void {
    this.admissionBackoffUntil = Date.now() + this.tuning.claimIntervalSeconds * 1000;
  }

  log(msg: string): void {
    const t = new Date().toISOString().slice(11, 23);
    console.log(`${t} [${this.id}] ${msg}`);
  }

  /** 工具/API 审计：只落摘要，不含密钥、请求体与完整响应。 */
  private audit(file: string, record: unknown): void {
    try {
      const dir = path.resolve(this.tuning.auditDir ?? "data/audit");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, file), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (e) {
      this.log(`审计写入失败（${file}）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async startApiRuntime(): Promise<void> {
    const profiles = this.tuning.profiles;
    if (!profiles || profiles.api.size === 0) return;
    if (!this.tuning.secretStoreUrl) {
      throw new Error("实例绑定了 API Profile，但没有配置 secret_store_url（失败关闭）");
    }
    this.secretClient = new SecretClient({
      url: this.tuning.secretStoreUrl,
      token: this.tuning.instanceToken ?? "",
    });
    this.apiAdapter = new ApiAdapter({
      instanceId: this.id,
      profiles: profiles.api,
      secretClient: this.secretClient,
      egress: {
        policies: this.tuning.egressPolicies ?? {},
        allowLoopback: this.tuning.allowLoopbackEgress ?? false,
      },
      port: this.cfg.api_adapter_port ?? 0,
      audit: (r) => this.audit("api-audit.jsonl", r),
    });
    await this.apiAdapter.start();
    this.log(`API Adapter 已启动：${this.apiAdapter.url}（${profiles.api.size} 个绑定）`);
  }

  async start(): Promise<void> {
    await this.startApiRuntime();
    await this.reconcileHostGrants();
    await this.registerLoop();
    if (this.draining) return;
    await this.beat();
    this.hbTimer = setInterval(() => void this.beat(), this.tuning.heartbeatSeconds * 1000);
    void this.configLoop();
    void this.claimLoop();
  }

  /**
   * 配置同步（§7.11）：定期拉版本，版本没变调度机回 304。
   * 骨架只做“看到变化就记下来”；执行中任务继续用旧的本地配置。
   */
  private async configLoop(): Promise<void> {
    while (!this.draining) {
      try {
        const cfg = await this.client.config(this.cfg.instance_id, this.configVersion);
        if (cfg) {
          this.configVersion = cfg.config_version;
          this.log(
            `配置同步 v${cfg.config_version}：任务类型 ` +
              `${cfg.allowed_task_types?.join(",") || "-"}${cfg.drain?.requested ? "（drain 中）" : ""}`,
          );
        }
      } catch (e) {
        if (e instanceof SchedulerError && e.status === 401) {
          this.log("配置同步被拒（401），检查 SCHEDULER_TOKEN 是否与调度机 AUTH_TOKEN 一致");
        } else {
          this.log(`配置同步失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await sleep(this.tuning.configSyncSeconds * 1000);
    }
  }

  /** 注册失败就一直退避重试；调度机没起来也不退出进程 */
  private async registerLoop(): Promise<void> {
    let attempt = 0;
    while (!this.draining) {
      try {
        await this.client.register({
          instance_id: this.cfg.instance_id,
          role_id: this.cfg.role_id,
          host_id: this.cfg.host_id,
          agent_profile_id: this.cfg.agent_profile_id,
          agent_profile_version:
            this.tuning.profiles?.agent.version ?? this.cfg.agent_profile_version,
          api_profile_ids: this.tuning.profiles
            ? [...this.tuning.profiles.boundApiIds]
            : (this.cfg.api_profile_ids ?? []),
          allowed_task_types: this.cfg.task_types,
          capabilities: this.cfg.capabilities,
          config_version: 1,
          ...(typeof this.cfg.capability_score === "number"
            ? { capability_score: this.cfg.capability_score }
            : {}),
          ...(this.cfg.capability_detail ? { capability_detail: this.cfg.capability_detail } : {}),
        });
        this.log("已注册");
        return;
      } catch (e) {
        attempt++;
        const msg = e instanceof Error ? e.message : String(e);
        this.log(`注册失败（第 ${attempt} 次）：${msg}，2s 后重试`);
        await sleep(2000);
      }
    }
  }

  private async beat(): Promise<void> {
    try {
      await this.client.heartbeat({
        instance_id: this.cfg.instance_id,
        state: this.draining ? "DRAINING" : "ONLINE",
        load: { ...sample(), slots_busy: this.running.size, slots_total: this.slots },
        capabilities: this.cfg.capabilities,
      });
    } catch (e) {
      // 心跳失败不停止在途任务（§11：与 PCS 断连时已运行容器继续运行）
      this.log(`心跳失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async claimLoop(): Promise<void> {
    while (!this.draining) {
      if (this.running.size >= this.slots) {
        await sleep(200);
        continue;
      }
      // 准入被拒后退避，否则同一任务会被原地反复领取，每秒刷出多条 attempt
      if (Date.now() < this.admissionBackoffUntil) {
        await sleep(Math.min(500, this.admissionBackoffUntil - Date.now()));
        continue;
      }
      let assignment: Assignment | null;
      try {
        assignment = await this.client.claim(this.cfg.instance_id);
      } catch (e) {
        if (e instanceof SchedulerError && e.code === "INSTANCE_NOT_ELIGIBLE") {
          // SUSPECT / DRAINING / 未 ONLINE：等心跳把它拉回来
          await sleep(3000);
          continue;
        }
        this.log(`领取失败：${e instanceof Error ? e.message : String(e)}`);
        await sleep(2000);
        continue;
      }
      if (!assignment) {
        await sleep(this.tuning.claimIntervalSeconds * 1000);
        continue;
      }
      void this.run(assignment);
    }
    this.log("claim 循环已停止");
  }

  private async run(a: Assignment): Promise<void> {
    const controller = new AbortController();
    this.running.set(a.attempt_id, { task: a, controller });
    const proof = { lease_token: a.lease_token, fencing_token: a.fencing_token };
    let acquired = false;
    let hostGrant: string | null = null;
    let workspaceDir: string | null = null;
    const socket = this.tuning.hostAdmissionSocket;

    try {
      // 0. Profile 匹配：只看信封里的引用。不匹配就回队，不消耗重试
      if (this.tuning.profiles) {
        try {
          assertEnvelopeAllowed(this.tuning.profiles, a);
        } catch (e) {
          const msg = e instanceof ProfileRejected ? `${e.code}: ${e.message}` : String(e);
          this.log(`${a.task_id} Profile 不匹配（${msg}），任务回队`);
          await this.client.startAck(a.attempt_id, {
            ...proof,
            instance_id: this.id,
            accepted: false,
          });
          this.audit("profile-audit.jsonl", {
            ts: new Date().toISOString(),
            instance_id: this.id,
            task_id: a.task_id,
            attempt_id: a.attempt_id,
            decision: "REJECT",
            error: msg,
          });
          return;
        }
      }

      // 1a. Host Runtime 本机准入：跨进程、用实时余量，grant 来自调度机领取事务
      if (socket) {
        try {
          const ha = await checkHostAdmission(socket, {
            grant_id: a.grant_id,
            kind: "TASK",
            instance_id: this.id,
            task_id: a.task_id,
            attempt_id: a.attempt_id,
            resources: { memory_bytes: this.slotMemoryBytes },
          });
          if (!ha.allowed) {
            this.log(
              `${a.task_id} Host Runtime 准入拒绝：${ha.reason ?? "INSUFFICIENT_MEMORY"}，` +
                `可用 ${gb(ha.observed.mem_available_bytes)} 需要 ${gb(ha.observed.requested_bytes)}；` +
                `放回队列且不消耗重试`,
            );
            await this.client.startAck(a.attempt_id, {
              ...proof,
              instance_id: this.id,
              accepted: false,
            });
            this.backOffAfterAdmission();
            return;
          }
          hostGrant = a.grant_id;
        } catch (e) {
          // 本机准入接口不可用时失败关闭：宁可拒绝，也不绕过实时余量检查
          this.log(
            `${a.task_id} Host Runtime 准入接口不可用（${e instanceof Error ? e.message : String(e)}），` +
              `按失败关闭拒绝该 assignment`,
          );
          await this.client.startAck(a.attempt_id, {
            ...proof,
            instance_id: this.id,
            accepted: false,
          });
          this.backOffAfterAdmission();
          return;
        }
      }

      // 1b. 进程内兜底（没有 Host Runtime socket 时的本地开发模式）
      const adm = await this.admission.tryAcquire();
      if (!adm.allowed) {
        this.log(
          `${a.task_id} 本机准入拒绝：可用 ${gb(adm.observed.mem_available_bytes)} ` +
            `< 需要 ${gb(adm.observed.requested_bytes)}，放回队列且不消耗重试`,
        );
        await this.client.startAck(a.attempt_id, {
          ...proof,
          instance_id: this.id,
          accepted: false,
        });
        this.backOffAfterAdmission();
        return;
      }
      acquired = true;

      // 2. start-ack：从这里开始才拥有这个 attempt
      await this.client.startAck(a.attempt_id, {
        ...proof,
        instance_id: this.id,
        accepted: true,
      });
      this.log(`开始 ${a.task_id}（attempt ${a.attempt_number}，fencing ${a.fencing_token}）`);

      // 3. 续租
      const renewTimer = setInterval(() => void this.renew(a, proof, controller), this.tuning.leaseRenewSeconds * 1000);

      // 4. 取消观察 + 进度
      const watchTimer = setInterval(() => void this.watch(a, proof, controller), this.tuning.progressSeconds * 1000);

      // 每个 attempt 一个独立工作目录；不跨任务复用，避免前一个任务的残留文件被读到
      workspaceDir = path.join(this.tuning.workspaceDir, a.attempt_id);
      fs.mkdirSync(workspaceDir, { recursive: true });

      const profiles = this.tuning.profiles;
      // 容器诊断永远走白名单确定性执行器，即使 Profile 声明了该任务类型也不外派。
      const useAgent = profiles
        ? supportsTask(profiles.agent, a.task_type) && !a.task_type.startsWith("task.console.")
        : false;
      if (useAgent) {
        this.log(
          `${a.task_id} 由 Agent ${profiles!.agent.agent_profile_id}@${profiles!.agent.version} 执行（${profiles!.agent.adapter}）`,
        );
      }
      let outcome: { summary: string; outputs?: Record<string, unknown> };
      try {
        const executor = useAgent
          ? (t: Assignment, c: Parameters<typeof runAgentTask>[1]) =>
              runAgentTask(t, c, {
                profiles: profiles!,
                apiAdapter: this.apiAdapter,
                toolAudit: (r) => this.audit("tool-audit.jsonl", r),
              })
          : executorFor(a.task_type);
        outcome = await executor(a, {
          signal: controller.signal,
          instanceId: this.id,
          workspaceDir,
          log: (m) => this.log(`  ${a.task_id}: ${m}`),
          progress: (percent, note) => {
            void this.client
              .progress(a.attempt_id, { ...proof, percent, note })
              .catch(() => {});
          },
          downloadArtifact: (artifactId) => this.client.downloadArtifactContent(artifactId),
          uploadArtifact: async (content, mediaType = "application/octet-stream") => {
            const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
            const sha256 = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
            const meta = await this.client.createArtifact({
              task_id: a.task_id,
              attempt_id: a.attempt_id,
              sha256,
              size_bytes: buf.length,
              media_type: mediaType,
            });
            if (!meta) throw new Error("调度机未返回制品记录");
            await this.client.uploadArtifactContent(meta.artifact_id, buf);
            await this.client.completeArtifact(meta.artifact_id);
            this.log(`  ${a.task_id}: 制品 ${meta.artifact_id} 已校验（${sha256.slice(0, 19)}…）`);
            return { artifact_id: meta.artifact_id, sha256, size_bytes: buf.length };
          },
        });
      } catch (e) {
        await this.handleExecError(a, proof, e);
        return;
      } finally {
        clearInterval(renewTimer);
        clearInterval(watchTimer);
      }

      const r = await this.client.result(a.attempt_id, {
        ...proof,
        status: "SUCCEEDED",
        summary: outcome.summary,
        outputs: outcome.outputs,
      });
      this.log(`完成 ${a.task_id}：${outcome.summary}${describeResult(r)}`);
    } catch (e) {
      if (e instanceof SchedulerError && e.isFencingLost) {
        // 租约已被回收或转给别的实例：不要上报任何结果，让它自然过期
        this.log(`${a.task_id} 租约已失效（${e.code}），放弃本 attempt`);
      } else {
        this.log(`${a.task_id} 执行异常：${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (workspaceDir && !this.tuning.keepWorkspace) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch (e) {
          this.log(`${a.task_id} 工作目录清理失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (acquired) this.admission.release();
      if (hostGrant && socket) {
        void releaseHostAdmission(socket, hostGrant).catch(() => {
          // 释放失败会由租约结束/TTL 兜底，不阻塞任务收尾
        });
      }
      this.running.delete(a.attempt_id);
    }
  }

  private async handleExecError(a: Assignment, proof: { lease_token: string; fencing_token: number }, e: unknown) {
    if (e instanceof TaskAborted) {
      if (e.reason === "cancelled") {
        await this.client
          .result(a.attempt_id, { ...proof, status: "CANCELLED", summary: "按取消请求停止" })
          .catch(() => {});
        this.log(`${a.task_id} 已按取消请求停止`);
      } else if (e.reason === "lease_lost") {
        this.log(`${a.task_id} 租约失效或已被回收，停止执行且不上报结果`);
      } else {
        this.log(`${a.task_id} 进程退出前未完成，留给调度机回收`);
      }
      return;
    }

    const code = e instanceof TaskFailed ? e.code : "EXECUTOR_ERROR";
    const message = e instanceof Error ? e.message : String(e);
    await this.client
      .result(a.attempt_id, { ...proof, status: "FAILED", error: { code, message } })
      .catch((err) => this.log(`${a.task_id} 上报失败结果时出错：${String(err)}`));
    this.log(`${a.task_id} 失败（${code}）：${message}`);
  }

  private async renew(a: Assignment, proof: { lease_token: string; fencing_token: number }, controller: AbortController) {
    try {
      const r = await this.client.renew(a.attempt_id, proof);
      this.log(`${a.task_id} 续租至 ${r?.lease_expires_at ?? "未知"}`);
    } catch (e) {
      if (e instanceof SchedulerError && e.isFencingLost) {
        controller.abort("lease_lost");
      } else {
        // 网络抖动：不立刻停手，租约还有余量，下一轮会再试
        this.log(`${a.task_id} 续租失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async watch(a: Assignment, proof: { lease_token: string; fencing_token: number }, controller: AbortController) {
    try {
      const t = await this.client.task(a.task_id);
      if (t?.cancel_requested_at && !controller.signal.aborted) {
        controller.abort("cancelled");
      }
    } catch {
      // 查询失败不影响执行，取消请求会在下一轮再看到
    }
    void proof;
  }

  /** 优雅停止：先不再领取，等在途任务完成；超时则放弃，交给调度机回收 */
  async stop(waitMs = 15000): Promise<void> {
    this.draining = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    await this.beat();
    this.log(`开始 drain，在途 ${this.running.size} 个`);

    const deadline = Date.now() + waitMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await sleep(200);
    }
    if (this.running.size > 0) {
      this.log(`drain 超时，放弃 ${this.running.size} 个在途任务（等租约过期后由调度机回收）`);
      for (const { controller } of this.running.values()) controller.abort("shutdown");
    }

    // 注销（§7.12）：还有在途任务时只能 force；调度机不可达也不能卡住退出
    try {
      const out = await this.client.deregister(this.cfg.instance_id, {
        reason: "shutdown",
        force: this.running.size > 0,
      });
      this.log(`已注销（${out?.state ?? "OFFLINE"}）`);
    } catch (e) {
      this.log(`注销失败（不影响退出）：${e instanceof Error ? e.message : String(e)}`);
    }
    await this.apiAdapter?.close().catch(() => {});
    this.apiAdapter = undefined;
  }
}

function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)}GB`;
}

function describeResult(r: unknown): string {
  if (r && typeof r === "object" && "idempotent" in r) return "（幂等重放）";
  return "";
}
