import fs from "node:fs";
import os from "node:os";

/** 宿主实时指标。Linux 读 /proc，其它平台退回 os API。 */
export function memAvailableBytes(): number {
  try {
    const text = fs.readFileSync("/proc/meminfo", "utf8");
    const line = text.split("\n").find((l) => l.startsWith("MemAvailable:"));
    if (line) return Number(line.replace(/\D+/g, "")) * 1024;
  } catch {
    // 非 Linux，走 fallback
  }
  return os.freemem();
}

export function sample(): {
  cpu_count: number;
  load1: number;
  mem_available_bytes: number;
  mem_total_bytes: number;
} {
  const [load1 = 0] = os.loadavg();
  return {
    cpu_count: os.cpus().length,
    load1: Number(load1.toFixed(2)),
    mem_available_bytes: memAvailableBytes(),
    mem_total_bytes: os.totalmem(),
  };
}

export interface CpuTimes {
  total: number;
  idle: number;
}

export interface DiskSample {
  fs: string;
  total_bytes: number;
  free_bytes: number;
  total_inodes: number;
  free_inodes: number;
}

export interface HostSample {
  cpu_count: number;
  cpu_usage: number;
  load1: number;
  load5: number;
  load15: number;
  mem_total_bytes: number;
  mem_available_bytes: number;
  swap_total_bytes: number;
  swap_used_bytes: number;
  pids_used: number;
  disk: DiskSample[];
}

function readMeminfo(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const line of fs.readFileSync("/proc/meminfo", "utf8").split("\n")) {
      const m = /^([A-Za-z_()]+):\s+(\d+)/.exec(line);
      if (m) out[m[1]] = Number(m[2]) * 1024;
    }
  } catch {
    // 非 Linux
  }
  return out;
}

export function readCpuTimes(): CpuTimes | null {
  try {
    const first = fs.readFileSync("/proc/stat", "utf8").split("\n")[0];
    const nums = first.trim().split(/\s+/).slice(1).map(Number);
    if (nums.length < 4) return null;
    const total = nums.reduce((a, b) => a + b, 0);
    return { total, idle: nums[3] + (nums[4] ?? 0) };
  } catch {
    return null;
  }
}

function countPids(): number {
  try {
    return fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)).length;
  } catch {
    return 0;
  }
}

function diskSample(fsName: string, target: string): DiskSample {
  try {
    const s = fs.statfsSync(target);
    return {
      fs: fsName,
      total_bytes: Number(s.blocks) * Number(s.bsize),
      free_bytes: Number(s.bavail) * Number(s.bsize),
      total_inodes: Number(s.files),
      free_inodes: Number(s.ffree),
    };
  } catch {
    return { fs: fsName, total_bytes: 0, free_bytes: 0, total_inodes: 0, free_inodes: 0 };
  }
}

/** 采集一次；cpu_usage 需要上一次 /proc/stat 采样点，首次为 0。 */
export function sampleHost(prevCpu?: CpuTimes | null): { sample: HostSample; cpu: CpuTimes | null } {
  const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
  const mem = readMeminfo();
  const totalMem = mem.MemTotal ?? os.totalmem();
  const available = mem.MemAvailable ?? os.freemem();
  const swapTotal = mem.SwapTotal ?? 0;
  const swapFree = mem.SwapFree ?? 0;
  const cpu = readCpuTimes();
  let usage = 0;
  if (prevCpu && cpu && cpu.total > prevCpu.total) {
    usage = 1 - (cpu.idle - prevCpu.idle) / (cpu.total - prevCpu.total);
    usage = Math.max(0, Math.min(1, usage));
  }

  return {
    sample: {
      cpu_count: os.cpus().length,
      cpu_usage: Number(usage.toFixed(4)),
      load1: Number(load1.toFixed(2)),
      load5: Number(load5.toFixed(2)),
      load15: Number(load15.toFixed(2)),
      mem_total_bytes: totalMem,
      mem_available_bytes: available,
      swap_total_bytes: swapTotal,
      swap_used_bytes: Math.max(0, swapTotal - swapFree),
      pids_used: countPids(),
      disk: [
        diskSample("root", "/"),
        diskSample("state", process.cwd()),
      ],
    },
    cpu,
  };
}
