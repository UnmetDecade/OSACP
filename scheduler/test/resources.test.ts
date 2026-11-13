/**
 * Pure v0.3 scheduling math (§6, §8, §9, §11). No database: these tests pin the formulas themselves,
 * so a regression is visible without standing up PostgreSQL.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  splitCapability,
  dynamicLiveScore,
  dynamicGuaranteedScore,
  normalizeDifficulty,
} from "../src/capability.js";
import {
  MIB,
  DEFAULT_DYNAMIC_POLICY,
  computeHRes,
  percentile25,
  computeDemand,
  waterFill,
  allocateGrants,
  computeConcurrency,
  backoffSeconds,
  nextPressureState,
  admissionAllowedByPressure,
} from "../src/core/resources.js";

const GIB = 1024 * MIB;

test("H_res is 1 when idle, falls with peak utilization, and is clamped by H_min", () => {
  const hMin = 0.05;
  assert.equal(
    computeHRes({ usedMemBytes: 0, memCapacityBytes: 8 * GIB, usedCpuMillicores: 0, cpuCapacityMillicores: 8000, hMin }),
    1,
  );
  assert.equal(
    computeHRes({ usedMemBytes: 4 * GIB, memCapacityBytes: 8 * GIB, usedCpuMillicores: 800, cpuCapacityMillicores: 8000, hMin }),
    0.5,
  );
  // Memory dominates when it is the higher utilization.
  assert.equal(
    computeHRes({ usedMemBytes: 7 * GIB, memCapacityBytes: 8 * GIB, usedCpuMillicores: 800, cpuCapacityMillicores: 8000, hMin }),
    0.125,
  );
  assert.equal(
    computeHRes({ usedMemBytes: 8 * GIB, memCapacityBytes: 8 * GIB, usedCpuMillicores: 8000, cpuCapacityMillicores: 8000, hMin }),
    hMin,
  );
  // Committed-but-unused grants never enter H_res, so idle hosts keep a full score.
  assert.equal(
    computeHRes({ usedMemBytes: 0, memCapacityBytes: 0, usedCpuMillicores: 0, cpuCapacityMillicores: 0, hMin }),
    1,
  );
});

test("percentile25 uses nearest rank and ignores non-finite samples", () => {
  assert.equal(percentile25([]), 0);
  assert.equal(percentile25([40, 10, 30, 20]), 10);
  assert.equal(percentile25([Number.NaN, 20, 40]), 20);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile25(hundred), 25);
});

test("splitCapability caps CPU/memory at 500 and keeps the static half untouched", () => {
  const full = splitCapability({ cores: 8, mem_gb: 32, freq_ghz: 4, disk_gb: 256, model: 10, api: 10 });
  assert.deepEqual(full, { static_score: 500, res_score: 500, ceiling: 1000 });

  const capped = splitCapability(
    { cores: 8, mem_gb: 32, freq_ghz: 4, disk_gb: 256, model: 10, api: 10 },
    { cpu_cores: 2, mem_gb: 8 },
  );
  assert.equal(capped.static_score, 500);
  assert.equal(capped.res_score, 125);
  assert.equal(capped.ceiling, 625);
});

test("W_live scales only the resource half in resource scope and applies the floor in whole scope", () => {
  const split = { static_score: 500, res_score: 500, ceiling: 1000 };
  assert.equal(dynamicLiveScore(split, 0.5), 750);
  assert.equal(dynamicLiveScore(split, 0.5, { scope: "whole" }), 500);
  assert.equal(dynamicLiveScore(split, 0.01, { scope: "whole", wFloor: 25 }), 25);
  assert.equal(dynamicGuaranteedScore({ static_score: 500, res_score: 500, ceiling: 1000 }, { cpu_cores: 2, mem_gb: 8 }), 625);
});

test("difficulty treats zero as unrestricted", () => {
  assert.equal(normalizeDifficulty(0), 0);
  assert.equal(normalizeDifficulty(-5), 0);
  assert.equal(normalizeDifficulty("60"), 60);
  assert.equal(normalizeDifficulty(5000), 1000);
});

test("demand is max(reserved, used, idle floor) clamped to the cap", () => {
  const [a] = computeDemand([
    {
      instanceId: "a",
      capCpuMillicores: 4000,
      capMemBytes: 8 * GIB,
      reservedCpuMillicores: 1000,
      reservedMemBytes: 512 * MIB,
      usedCpuMillicores: 2500,
      usedMemBytes: 2 * GIB,
      idleFloorCpuMillicores: 50,
      idleFloorMemBytes: 128 * MIB,
    },
  ]);
  assert.equal(a.demandCpuMillicores, 2500);
  assert.equal(a.demandMemBytes, 2 * GIB);
  assert.equal(a.weightCpu, 1_000_000);
  assert.equal(a.weightMem, 1_000_000);
});

test("waterFill splits evenly and never exceeds capacity or demand", () => {
  const grants = waterFill(10, [
    { instanceId: "a", cap: 10, demand: 10, weight: 1, floor: 0 },
    { instanceId: "b", cap: 10, demand: 10, weight: 1, floor: 0 },
  ]);
  assert.equal(grants.get("a"), 5);
  assert.equal(grants.get("b"), 5);

  const noRoom = waterFill(100, [
    { instanceId: "a", cap: 100, demand: 10, weight: 1, floor: 0 },
    { instanceId: "b", cap: 100, demand: 10, weight: 1, floor: 0 },
  ]);
  assert.equal(noRoom.get("a"), 10);
  assert.equal(noRoom.get("b"), 10);

  // A weighted split: 3:1 shares of the capacity that is left after demand floors.
  const weighted = waterFill(400, [
    { instanceId: "a", cap: 400, demand: 400, weight: 3, floor: 0 },
    { instanceId: "b", cap: 400, demand: 400, weight: 1, floor: 0 },
  ]);
  assert.equal(weighted.get("a"), 300);
  assert.equal(weighted.get("b"), 100);
});

test("waterFill hands out floors first and the integer remainder deterministically", () => {
  const grants = waterFill(11, [
    { instanceId: "b", cap: 10, demand: 10, weight: 1, floor: 5 },
    { instanceId: "a", cap: 10, demand: 10, weight: 1, floor: 5 },
  ]);
  assert.equal(grants.get("a"), 6);
  assert.equal(grants.get("b"), 5);
  assert.equal([...grants.values()].reduce((x, y) => x + y, 0), 11);
});

test("waterFill stays exact for byte-scale capacities", () => {
  const capacity = 512 * GIB;
  const items = ["a", "b", "c"].map((id) => ({
    instanceId: id,
    cap: 300 * GIB,
    demand: 300 * GIB,
    weight: 333_333,
    floor: 0,
  }));
  const grants = waterFill(capacity, items);
  const total = [...grants.values()].reduce((x, y) => x + y, 0);
  assert.ok(total <= capacity);
  // The split is fair within one byte per instance, not lossy at 2^53.
  const values = [...grants.values()];
  assert.ok(Math.max(...values) - Math.min(...values) <= 3);
  assert.ok(total >= capacity - 3);
});

test("allocateGrants maps grants to cgroup knobs and tightens memory.high under pressure", () => {
  const demand = computeDemand([
    {
      instanceId: "a",
      capCpuMillicores: 4000,
      capMemBytes: 6 * GIB,
      reservedCpuMillicores: 4000,
      reservedMemBytes: 4 * GIB,
      usedCpuMillicores: 0,
      usedMemBytes: 0,
      idleFloorCpuMillicores: DEFAULT_DYNAMIC_POLICY.idle_floor_cpu_millicores,
      idleFloorMemBytes: DEFAULT_DYNAMIC_POLICY.idle_floor_mem_bytes,
    },
    {
      instanceId: "b",
      capCpuMillicores: 4000,
      capMemBytes: 6 * GIB,
      reservedCpuMillicores: 4000,
      reservedMemBytes: 4 * GIB,
      usedCpuMillicores: 0,
      usedMemBytes: 0,
      idleFloorCpuMillicores: DEFAULT_DYNAMIC_POLICY.idle_floor_cpu_millicores,
      idleFloorMemBytes: DEFAULT_DYNAMIC_POLICY.idle_floor_mem_bytes,
    },
  ]);

  const normal = allocateGrants({
    cpuCapacityMillicores: 8000,
    memCapacityBytes: 8 * GIB,
    demands: demand,
    pressureState: "NORMAL",
    policy: DEFAULT_DYNAMIC_POLICY,
  });
  for (const g of normal) {
    assert.equal(g.grantCpuMillicores, 4000);
    assert.equal(g.grantMemBytes, 4 * GIB);
    assert.equal(g.memoryLowBytes, 4 * GIB);
    // Normal hands out borrowing up to the cap through memory.high.
    assert.equal(g.memoryHighBytes, 6 * GIB);
    assert.equal(g.cpuWeight, 5000);
    assert.equal(g.overcommitted, false);
  }

  const critical = allocateGrants({
    cpuCapacityMillicores: 8000,
    memCapacityBytes: 8 * GIB,
    demands: demand,
    pressureState: "CRITICAL",
    policy: DEFAULT_DYNAMIC_POLICY,
  });
  for (const g of critical) {
    // CRITICAL clamps memory.high to the grant, which is what forces reclaim.
    assert.equal(g.memoryHighBytes, g.grantMemBytes);
  }
});

test("overcommit marks a grant below already-committed reservations", () => {
  const demand = computeDemand([
    {
      instanceId: "a",
      capCpuMillicores: 6000,
      capMemBytes: 6 * GIB,
      reservedCpuMillicores: 5000,
      reservedMemBytes: 5 * GIB,
      usedCpuMillicores: 0,
      usedMemBytes: 0,
      idleFloorCpuMillicores: 50,
      idleFloorMemBytes: 128 * MIB,
    },
    {
      instanceId: "b",
      capCpuMillicores: 6000,
      capMemBytes: 6 * GIB,
      reservedCpuMillicores: 5000,
      reservedMemBytes: 5 * GIB,
      usedCpuMillicores: 0,
      usedMemBytes: 0,
      idleFloorCpuMillicores: 50,
      idleFloorMemBytes: 128 * MIB,
    },
  ]);
  const grants = allocateGrants({
    cpuCapacityMillicores: 8000,
    memCapacityBytes: 8 * GIB,
    demands: demand,
    pressureState: "NORMAL",
    policy: DEFAULT_DYNAMIC_POLICY,
  });
  assert.equal(grants.every((g) => g.overcommitted), true);
});

test("per-type concurrency is the tightest of CPU, memory and k_max", () => {
  assert.equal(
    computeConcurrency({
      remainingCpuMillicores: 2000,
      remainingMemBytes: 2048 * MIB,
      requestCpuMillicores: 500,
      requestMemBytes: 600 * MIB,
      kMax: 4,
    }),
    3,
  );
  assert.equal(
    computeConcurrency({
      remainingCpuMillicores: 2000,
      remainingMemBytes: 2048 * MIB,
      requestCpuMillicores: 0,
      requestMemBytes: 512 * MIB,
      kMax: 4,
    }),
    0,
  );
  assert.equal(
    computeConcurrency({
      remainingCpuMillicores: 100,
      remainingMemBytes: 100,
      requestCpuMillicores: 500,
      requestMemBytes: 512 * MIB,
      kMax: 4,
    }),
    0,
  );
});

test("backoff doubles from 1s and saturates at the cap", () => {
  assert.equal(backoffSeconds(0, 1, 60), 1);
  assert.equal(backoffSeconds(3, 1, 60), 8);
  assert.equal(backoffSeconds(10, 1, 60), 60);
  assert.equal(backoffSeconds(-1, 1, 60), 1);
});

test("pressure state uses separate enter/exit thresholds and can always reach CRITICAL", () => {
  const p = DEFAULT_DYNAMIC_POLICY;
  assert.equal(nextPressureState("NORMAL", 0.7, p), "BUSY");
  assert.equal(nextPressureState("NORMAL", 0.86, p), "PRESSURE");
  assert.equal(nextPressureState("NORMAL", 0.96, p), "CRITICAL");
  assert.equal(nextPressureState("CRITICAL", 0.8, p), "RECOVERING");
  assert.equal(nextPressureState("CRITICAL", 0.95, p), "CRITICAL");
  assert.equal(nextPressureState("RECOVERING", 0.96, p), "CRITICAL");
  assert.equal(nextPressureState("RECOVERING", 0.86, p), "PRESSURE");
  assert.equal(nextPressureState("RECOVERING", 0.5, p), "NORMAL");
  assert.equal(nextPressureState("BUSY", 0.65, p), "BUSY");
  assert.equal(nextPressureState("BUSY", 0.5, p), "NORMAL");
  assert.equal(nextPressureState("NORMAL", Number.NaN, p), "NORMAL");
});

test("only NORMAL, BUSY and RECOVERING admit new work", () => {
  assert.equal(admissionAllowedByPressure("NORMAL"), true);
  assert.equal(admissionAllowedByPressure("BUSY"), true);
  assert.equal(admissionAllowedByPressure("RECOVERING"), true);
  assert.equal(admissionAllowedByPressure("PRESSURE"), false);
  assert.equal(admissionAllowedByPressure("CRITICAL"), false);
  assert.equal(admissionAllowedByPressure("UNKNOWN"), false);
});
