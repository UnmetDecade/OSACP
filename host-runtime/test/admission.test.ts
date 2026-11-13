import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LocalAdmission } from "../src/admission.js";

const GB = 1024 ** 3;

describe("local admission", () => {
  it("with capacity for only one slot, only one concurrent request is granted", async () => {
    const adm = new LocalAdmission(() => 3 * GB, 2 * GB);
    const [a, b] = await Promise.all([adm.tryAcquire(), adm.tryAcquire()]);
    const allowed = [a, b].filter((r) => r.allowed).length;
    assert.equal(allowed, 1, "two tasks seeing the same available memory at once is oversubscription");
    assert.equal(adm.reservedBytes, 2 * GB);
  });

  it("capacity can be requested again after release", async () => {
    const adm = new LocalAdmission(() => 3 * GB, 2 * GB);
    assert.equal((await adm.tryAcquire()).allowed, true);
    assert.equal((await adm.tryAcquire()).allowed, false);
    adm.release();
    assert.equal((await adm.tryAcquire()).allowed, true);
  });

  it("rejections carry observability values that explain the reason", async () => {
    const adm = new LocalAdmission(() => 1 * GB, 2 * GB);
    const r = await adm.tryAcquire();
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "INSUFFICIENT_MEMORY");
    assert.equal(r.observed.mem_available_bytes, 1 * GB);
    assert.equal(r.observed.requested_bytes, 2 * GB);
  });
});
