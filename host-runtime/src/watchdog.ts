#!/usr/bin/env node
/**
 * 独立看门狗进程（生产由 systemd 单独管理，不随 host-runtime 退出）。
 * 只读 /proc、磁盘统计与 supervisor 写的 PCS 联系时间；不持有任何任务或凭据。
 *
 * 输出 state/host-state.json，supervisor 在启动任何新容器前必须读它。
 */
import fs from "node:fs";
import path from "node:path";
import { loadRuntimeHostConfig } from "./runtime-config.js";
import { sampleHost, type CpuTimes } from "./metrics.js";
import {
  nextWatchdogState,
  type WatchdogSample,
  type WatchdogStateFile,
} from "./watchdog-state.js";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cfg = loadRuntimeHostConfig(argValue("--config"));
const stateFile = path.join(cfg.state_dir, "host-state.json");
const contactFile = path.join(cfg.state_dir, "pcs-last-seen.json");

fs.mkdirSync(cfg.state_dir, { recursive: true, mode: 0o700 });

function readState(): WatchdogStateFile | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8")) as WatchdogStateFile;
  } catch {
    return null;
  }
}

function readContactAgeSeconds(nowMs: number): number {
  try {
    const data = JSON.parse(fs.readFileSync(contactFile, "utf8")) as { at?: number };
    if (!data.at) return Number.POSITIVE_INFINITY;
    return Math.max(0, (nowMs - data.at) / 1000);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function writeState(state: WatchdogStateFile): void {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

let prevCpu: CpuTimes | null = null;
let lastState = "";

function tick(): void {
  const now = Date.now();
  const { sample, cpu } = sampleHost(prevCpu);
  prevCpu = cpu;
  const silence = readContactAgeSeconds(now);
  const root = sample.disk.find((d) => d.fs === "root") ?? sample.disk[0];
  const wdSample: WatchdogSample = {
    mem_total_bytes: sample.mem_total_bytes,
    mem_available_bytes: sample.mem_available_bytes,
    load1: sample.load1,
    cpu_count: sample.cpu_count,
    disk_total_bytes: root?.total_bytes ?? 0,
    disk_free_bytes: root?.free_bytes ?? 0,
    pcs_reachable: Number.isFinite(silence) && silence <= cfg.watchdog.pcs_lost_seconds,
    pcs_silence_seconds: silence,
  };
  const next = nextWatchdogState(readState(), wdSample, now, cfg.watchdog);
  writeState(next);
  if (next.state !== lastState) {
    lastState = next.state;
    console.log(
      `[watchdog] ${next.state} ${next.reason} ` +
        `(mem ${(wdSample.mem_available_bytes / 1024 ** 3).toFixed(1)}GiB, ` +
        `load1 ${wdSample.load1}/${wdSample.cpu_count}, pcs ${silence.toFixed(0)}s)`,
    );
  }
}

tick();
const timer = setInterval(tick, cfg.watchdog.sample_seconds * 1000);

function stop(signal: string): void {
  console.log(`${signal}，看门狗停止（保留最后一次状态供 supervisor 判断新鲜度）`);
  clearInterval(timer);
  process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
