/**
 * Local second-stage admission (a simplified version of §8.4).
 *
 * The scheduler's admission is based on samples taken 15s earlier, so a real-time check must be run once more before starting, to prevent oversubscription.
 * Here "check + reserve" run serially under the same lock—two tasks seeing the same available memory at the same time
 * is exactly where oversubscription comes from.
 *
 * Difference from the spec: the spec has role-agent call /admission/check on runtime.sock
 * and account by grant_id; here accounting is in-process, and grant state is still held by the scheduler.
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

  /** Serialize: at most one call can see and modify `reserved` at any time */
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
