import assert from "node:assert/strict";
import { test } from "node:test";
import type { WatchdogConfig } from "../src/runtime-config.js";
import {
  containerAdmission,
  nextWatchdogState,
  thresholdReason,
  watchdogFresh,
  type WatchdogSample,
  type WatchdogStateFile,
} from "../src/watchdog-state.js";

const G = 1024 ** 3;
const cfg: WatchdogConfig = {
  sample_seconds: 5,
  warning: { mem_available_ratio_below: 0.2, load1_per_cpu_above: 1.5, disk_free_ratio_below: 0.15 },
  throttled: { mem_available_ratio_below: 0.12, load1_per_cpu_above: 2.5, disk_free_ratio_below: 0.08 },
  protecting: { mem_available_ratio_below: 0.05, load1_per_cpu_above: 4, disk_free_ratio_below: 0.03 },
  sustain_seconds: { warning: 60, throttled: 120, protecting: 5 },
  recover_seconds: 300,
  recovering_seconds: 60,
  pcs_lost_seconds: 60,
};

const t0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function sample(overrides: Partial<WatchdogSample> = {}): WatchdogSample {
  return {
    mem_total_bytes: 8 * G,
    mem_available_bytes: 6 * G,
    load1: 0.5,
    cpu_count: 4,
    disk_total_bytes: 100 * G,
    disk_free_bytes: 50 * G,
    pcs_reachable: true,
    pcs_silence_seconds: 1,
    ...overrides,
  };
}

function stateFile(
  state: WatchdogStateFile["state"],
  at: number,
  overrides: Partial<WatchdogStateFile> = {},
): WatchdogStateFile {
  return {
    state,
    since: iso(at),
    reason: "TEST",
    updated_at: iso(at),
    pending: null,
    below_since: null,
    sample: sample(),
    ...overrides,
  };
}

test("阈值各自独立触发", () => {
  assert.deepEqual(thresholdReason(sample(), cfg.warning), []);
  assert.equal(thresholdReason(sample({ mem_available_bytes: 1 * G }), cfg.warning).length, 1);
  assert.equal(thresholdReason(sample({ load1: 7 }), cfg.warning).length, 1);
  assert.equal(
    thresholdReason(sample({ disk_free_bytes: 10 * G }), cfg.warning).length,
    1,
  );
});

test("升级必须持续到 sustain 窗口：NORMAL→WARNING→THROTTLED→PROTECTING", () => {
  const warn = sample({ mem_available_bytes: 1.5 * G }); // 0.1875
  const throttle = sample({ mem_available_bytes: 0.8 * G }); // 0.10
  const protect = sample({ mem_available_bytes: 0.3 * G }); // 0.0375

  let s = nextWatchdogState(null, sample(), t0, cfg);
  assert.equal(s.state, "NORMAL");

  s = nextWatchdogState(s, warn, t0 + 1000, cfg);
  assert.equal(s.state, "NORMAL");
  assert.equal(s.pending?.level, 1);
  s = nextWatchdogState(s, warn, t0 + 61_000, cfg);
  assert.equal(s.state, "WARNING");

  s = nextWatchdogState(s, throttle, t0 + 62_000, cfg);
  assert.equal(s.state, "WARNING");
  assert.equal(s.pending?.level, 2);
  s = nextWatchdogState(s, throttle, t0 + 182_000, cfg);
  assert.equal(s.state, "THROTTLED");

  s = nextWatchdogState(s, protect, t0 + 183_000, cfg);
  assert.equal(s.state, "THROTTLED");
  assert.equal(s.pending?.level, 3);
  s = nextWatchdogState(s, protect, t0 + 188_000, cfg);
  assert.equal(s.state, "PROTECTING");
  assert.match(s.reason, /MEM_AVAILABLE_RATIO/);
});

test("PCS 失联直接进入 PROTECTING，不看本机指标", () => {
  let s = nextWatchdogState(null, sample(), t0, cfg);
  const lost = sample({ pcs_reachable: false, pcs_silence_seconds: 61 });
  s = nextWatchdogState(s, lost, t0 + 1000, cfg);
  assert.equal(s.state, "NORMAL");
  assert.equal(s.pending?.level, 3);
  s = nextWatchdogState(s, lost, t0 + 6000, cfg);
  assert.equal(s.state, "PROTECTING");
  assert.match(s.reason, /PCS_LOST/);
});

test("恢复需要稳定 recover_seconds，再观察 recovering_seconds", () => {
  let s = stateFile("PROTECTING", t0);
  s = nextWatchdogState(s, sample(), t0 + 1000, cfg);
  assert.equal(s.state, "PROTECTING");
  assert.ok(s.below_since);

  s = nextWatchdogState(s, sample(), t0 + 1000 + 300_000, cfg);
  assert.equal(s.state, "RECOVERING");

  s = nextWatchdogState(s, sample(), t0 + 301_000 + 60_000, cfg);
  assert.equal(s.state, "NORMAL");
  assert.equal(s.pending, null);
});

test("恢复过程中再次告警立即回到升级判定", () => {
  const recovering = stateFile("RECOVERING", t0);
  const warn = sample({ mem_available_bytes: 1.5 * G });
  let s = nextWatchdogState(recovering, warn, t0 + 1000, cfg);
  assert.equal(s.state, "RECOVERING");
  assert.equal(s.pending?.level, 1);
  s = nextWatchdogState(s, warn, t0 + 61_000, cfg);
  assert.equal(s.state, "WARNING");
});

test("缺失或过期看门狗状态一律失败关闭", () => {
  const now = t0;
  assert.equal(watchdogFresh(null, now, 5), false);
  assert.equal(watchdogFresh(stateFile("NORMAL", now - 16_000), now, 5), false);
  assert.equal(watchdogFresh(stateFile("NORMAL", now - 10_000), now, 5), true);

  for (const action of ["DEPLOY", "START", "RESTART"] as const) {
    assert.equal(
      containerAdmission(null, now, 5, action).reason,
      "WATCHDOG_UNAVAILABLE",
    );
    assert.equal(
      containerAdmission(stateFile("NORMAL", now - 60_000), now, 5, action).reason,
      "WATCHDOG_UNAVAILABLE",
    );
    assert.equal(
      containerAdmission(stateFile("PROTECTING", now), now, 5, action).reason,
      "HOST_PROTECTING",
    );
  }
});

test("THROTTLED 只拦新建部署，START/RESTART 仍允许", () => {
  const throttled = stateFile("THROTTLED", t0);
  assert.equal(containerAdmission(throttled, t0, 5, "DEPLOY").allowed, false);
  assert.equal(containerAdmission(throttled, t0, 5, "START").allowed, true);
  assert.equal(containerAdmission(throttled, t0, 5, "RESTART").allowed, true);
  assert.equal(containerAdmission(stateFile("WARNING", t0), t0, 5, "DEPLOY").allowed, true);
});
