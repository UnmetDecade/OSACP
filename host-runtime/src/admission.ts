/**
 * 本机二次准入（§8.4 的简化版）。
 *
 * 调度机的准入基于 15s 前的样本，启动前必须用实时数据再判一次，防超卖。
 * 这里把「校验 + 占用」放在同一把锁里串行执行——两个任务同时看到同一份可用内存，
 * 就是超卖的来源。
 *
 * 与规范的差异：规范由 role-agent 调 runtime.sock 的 /admission/check，
 * 按 grant_id 记账；这里在进程内记账，grant 状态仍由调度机持有。
 */

export interface AdmissionResult {
  allowed: boolean;
  reason?: "INSUFFICIENT_MEMORY";
  observed: {
    mem_available_bytes: number;
    reserved_bytes: number;
    requested_bytes: number;
  };
}

export class LocalAdmission {
  private reserved = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly availableBytes: () => number,
    private readonly perSlotBytes: number,
  ) {}

  /** 串行化：任何时候只有一个调用能看到并修改 reserved */
  tryAcquire(): Promise<AdmissionResult> {
    const run = this.chain.then(() => {
      const available = this.availableBytes();
      const requested = this.perSlotBytes;
      const observed = {
        mem_available_bytes: available,
        reserved_bytes: this.reserved,
        requested_bytes: requested,
      };
      if (available - this.reserved < requested) {
        return { allowed: false, reason: "INSUFFICIENT_MEMORY", observed };
      }
      this.reserved += requested;
      return { allowed: true, observed };
    });
    this.chain = run.catch(() => {});
    return run as Promise<AdmissionResult>;
  }

  release(): void {
    this.reserved = Math.max(0, this.reserved - this.perSlotBytes);
  }

  get reservedBytes(): number {
    return this.reserved;
  }
}
