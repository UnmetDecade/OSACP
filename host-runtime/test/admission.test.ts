import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LocalAdmission } from "../src/admission.js";

const GB = 1024 ** 3;

describe("本机二次准入", () => {
  it("容量只够一个槽位时，并发申请只有一个通过", async () => {
    const adm = new LocalAdmission(() => 3 * GB, 2 * GB);
    const [a, b] = await Promise.all([adm.tryAcquire(), adm.tryAcquire()]);
    const allowed = [a, b].filter((r) => r.allowed).length;
    assert.equal(allowed, 1, "两个任务同时看到同一份可用内存就是超卖");
    assert.equal(adm.reservedBytes, 2 * GB);
  });

  it("释放后可以再次申请", async () => {
    const adm = new LocalAdmission(() => 3 * GB, 2 * GB);
    assert.equal((await adm.tryAcquire()).allowed, true);
    assert.equal((await adm.tryAcquire()).allowed, false);
    adm.release();
    assert.equal((await adm.tryAcquire()).allowed, true);
  });

  it("拒绝时带上可观测值，便于解释原因", async () => {
    const adm = new LocalAdmission(() => 1 * GB, 2 * GB);
    const r = await adm.tryAcquire();
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "INSUFFICIENT_MEMORY");
    assert.equal(r.observed.mem_available_bytes, 1 * GB);
    assert.equal(r.observed.requested_bytes, 2 * GB);
  });
});
