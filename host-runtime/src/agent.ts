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
  /** Host Runtime's local admission socket; when unset, falls back to in-process LocalAdmission */
  hostAdmissionSocket?: string;
  /** Per-attempt workspace root; defaults to data/workspace */
  workspaceDir: string;
  /** For debugging: keep the workspace after the task ends */
  keepWorkspace?: boolean;
  /** Agent/API Profiles loaded for this instance; when absent, only the deterministic executor is used */
  profiles?: RuntimeProfiles;
  /** Secret Store URL and instance identity token (used only to exchange for short-lived credentials) */
  secretStoreUrl?: string;
  instanceToken?: string | (() => string | undefined);
  egressPolicies?: Record<string, string[]>;
  allowLoopbackEgress?: boolean;
  /** Tool/API audit directory */
  auditDir?: string;
}

/**
 * Lifecycle of one role instance (role-agent).
 *
 * There is no "scheduling" judgement in this process: the scheduler decides which task to claim; this only
 * "asks → re-checks locally → executes → reports the result", with fencing carried through everything.
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
   * Startup reconciliation: if the previous process was killed without a chance to release, residual TASK grants
   * under this instance name keep holding memory until the TTL. After a restart, clear them by instance_id first to restore the real headroom.
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
      // The Runtime may not be up yet; admission still fails closed and does not block startup
      this.log(`启动对账跳过：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Admission rejected or unavailable: back off by the claim interval, avoiding repeated attempts in place */
  private backOffAfterAdmission(): void {
    this.admissionBackoffUntil = Date.now() + this.tuning.claimIntervalSeconds * 1000;
  }

  log(msg: string): void {
    const t = new Date().toISOString().slice(11, 23);
    console.log(`${t} [${this.id}] ${msg}`);
  }

  /** Tool/API audit: records only a digest, with no secrets, request bodies or full responses. */
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
   * Configuration sync (§7.11): pull the version periodically; the scheduler returns 304 when it is unchanged.
   * The skeleton only "records a change when it sees one"; running tasks keep using the old local config.
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

  /** Keep backing off and retrying when registration fails; if the scheduler is not up, do not exit the process */
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
      // A heartbeat failure does not stop in-flight tasks (§11: running containers keep running when disconnected from PCS)
      this.log(`心跳失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async claimLoop(): Promise<void> {
    while (!this.draining) {
      if (this.running.size >= this.slots) {
        await sleep(200);
        continue;
      }
      // Back off after admission is rejected; otherwise the same task is repeatedly claimed in place, emitting many attempts per second
      if (Date.now() < this.admissionBackoffUntil) {
        await sleep(Math.min(500, this.admissionBackoffUntil - Date.now()));
        continue;
      }
      let assignment: Assignment | null;
      try {
        assignment = await this.client.claim(this.cfg.instance_id);
      } catch (e) {
        if (e instanceof SchedulerError && e.code === "INSTANCE_NOT_ELIGIBLE") {
          // SUSPECT / DRAINING / not ONLINE: wait for the heartbeat to bring it back
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
      // 0. Profile match: only look at the references in the envelope. On mismatch, requeue without consuming a retry
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

      // 1a. Host Runtime local admission: cross-process, uses live headroom; the grant comes from the scheduler's claim transaction
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
          // Fail closed when the local admission endpoint is unavailable: rather reject than bypass the live headroom check
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

      // 1b. In-process fallback (local development mode without a Host Runtime socket)
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

      // 2. start-ack: ownership of this attempt begins here
      await this.client.startAck(a.attempt_id, {
        ...proof,
        instance_id: this.id,
        accepted: true,
      });
      this.log(`开始 ${a.task_id}（attempt ${a.attempt_number}，fencing ${a.fencing_token}）`);

      // 3. Lease renewal
      const renewTimer = setInterval(() => void this.renew(a, proof, controller), this.tuning.leaseRenewSeconds * 1000);

      // 4. Cancellation watch + progress
      const watchTimer = setInterval(() => void this.watch(a, proof, controller), this.tuning.progressSeconds * 1000);

      // One independent workspace per attempt; not reused across tasks, so leftover files from a previous task cannot be read
      workspaceDir = path.join(this.tuning.workspaceDir, a.attempt_id);
      fs.mkdirSync(workspaceDir, { recursive: true });

      const profiles = this.tuning.profiles;
      // Container diagnostics always go through the allowlisted deterministic executor, even if a Profile declares that task type
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
        // The lease was reclaimed or transferred to another instance: report no result, let it expire naturally
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
          // A failed release is covered by lease end/TTL and does not block task teardown
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
        // Network blip: do not stop immediately; the lease still has headroom, and the next round retries
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
      // A failed query does not affect execution; the cancel request will be seen again next round
    }
    void proof;
  }

  /** Graceful stop: stop claiming first and wait for in-flight tasks; on timeout, abandon them for the scheduler to reclaim */
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

    // Deregister (§7.12): with in-flight tasks only force is possible; an unreachable scheduler must not block exit
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
