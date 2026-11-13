#!/usr/bin/env node
/**
 * P7 stress smoke test: submit N task.build tasks to the scheduler, observing completion latency, throughput and host memory.
 *
 * Usage:
 *   SCHEDULER_URL=http://127.0.0.1:7801 COUNT=30 TASK_TYPE=task.build \
 *   MONITOR_PIDS=123,456 node scripts/load-test.mjs
 *
 * Only creates tasks and reads status; does not touch keys or audit bodies. The OOM count comes from /proc/vmstat,
 * so Linux is required; other platforms skip that item.
 */
import fs from "node:fs";

const url = (process.env.SCHEDULER_URL ?? "http://127.0.0.1:7801").replace(/\/+$/, "");
const count = Number(process.env.COUNT ?? 20);
const taskType = process.env.TASK_TYPE ?? "task.build";
const timeoutSeconds = Number(process.env.TIMEOUT_SECONDS ?? 180);
const pids = (process.env.MONITOR_PIDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readMeminfo() {
  try {
    const text = fs.readFileSync("/proc/meminfo", "utf8");
    const get = (key) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? 0);
    return { mem_total_kb: get("MemTotal"), mem_available_kb: get("MemAvailable") };
  } catch {
    return null;
  }
}

function oomKills() {
  try {
    const text = fs.readFileSync("/proc/vmstat", "utf8");
    const m = /^oom_kill\s+(\d+)/m.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function rssKb(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    return Number(/^VmRSS:\s+(\d+) kB/m.exec(text)?.[1] ?? 0);
  } catch {
    return null;
  }
}

async function json(method, path, body) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${data?.error?.code ?? ""} ${data?.error?.message ?? ""}`);
  }
  return data;
}

const samples = [];
let sampling = true;
const memBefore = readMeminfo();
const oomBefore = oomKills();
const rssBefore = Object.fromEntries(pids.map((p) => [p, rssKb(p)]));

const sampler = (async () => {
  while (sampling) {
    const mem = readMeminfo();
    const rss = Object.fromEntries(pids.map((p) => [p, rssKb(p)]));
    if (mem) samples.push({ at: Date.now(), ...mem, rss });
    await sleep(500);
  }
})();

const queueBefore = await json("GET", "/v1/queue/stats");

const submitted = [];
const submitStart = Date.now();
for (let i = 0; i < count; i++) {
  const started = performance.now();
  const t = await json("POST", "/v1/tasks", {
    task_type: taskType,
    payload_ref: `load://${runId}/${i}`,
    priority_class: 1,
  });
  submitted.push({ task_id: t.task_id, at: Date.now(), submit_ms: performance.now() - started });
}
const submitMs = Date.now() - submitStart;

const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "DEAD", "BLOCKED"]);
const pending = new Map(submitted.map((t) => [t.task_id, t.at]));
const latencies = [];
const statuses = {};
const deadline = Date.now() + timeoutSeconds * 1000;

while (pending.size && Date.now() < deadline) {
  const ids = [...pending.keys()];
  const results = await Promise.all(
    ids.map((id) => json("GET", `/v1/tasks/${id}`).catch(() => null)),
  );
  results.forEach((t, i) => {
    if (!t) return;
    const id = ids[i];
    if (terminal.has(t.status)) {
      statuses[t.status] = (statuses[t.status] ?? 0) + 1;
      // Time from when the task's submission completes, including queue time; this is the user-perceived end-to-end latency.
      latencies.push(Date.now() - Number(pending.get(id)));
      pending.delete(id);
    }
  });
  if (pending.size) await sleep(250);
}

const elapsedMs = Date.now() - submitStart;
sampling = false;
await sampler;
const memAfter = readMeminfo();
const oomAfter = oomKills();
const rssAfter = Object.fromEntries(pids.map((p) => [p, rssKb(p)]));

const finished = latencies.length;
const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
const peak = samples.reduce(
  (acc, s) => ({
    min_available_kb: Math.min(acc.min_available_kb ?? s.mem_available_kb, s.mem_available_kb),
    max_rss: Object.fromEntries(
      Object.entries(s.rss).map(([p, v]) => [p, Math.max(acc.max_rss?.[p] ?? 0, v ?? 0)]),
    ),
  }),
  { min_available_kb: null, max_rss: {} },
);
const queueAfter = await json("GET", "/v1/queue/stats");

const report = {
  run_id: runId,
  task_type: taskType,
  submitted: count,
  finished,
  timed_out: pending.size,
  statuses,
  submit_seconds: +(submitMs / 1000).toFixed(2),
  elapsed_seconds: +(elapsedMs / 1000).toFixed(2),
  throughput_per_second: finished ? +(finished / (elapsedMs / 1000)).toFixed(2) : 0,
  latency_ms: { p50: pct(0.5), p95: pct(0.95), max: sorted.at(-1) ?? 0 },
  memory_kb: {
    before: memBefore,
    after: memAfter,
    min_available_during: peak.min_available_kb,
    peak_rss: peak.max_rss,
    rss_before: rssBefore,
    rss_after: rssAfter,
  },
  oom_kill: { before: oomBefore, after: oomAfter, delta: oomBefore === null ? null : oomAfter - oomBefore },
  queue: { before: queueBefore, after: queueAfter },
};

console.log(JSON.stringify(report, null, 2));

if (finished !== count || pending.size) {
  console.error(`FAIL - completed ${finished}/${count}, timed out ${pending.size}`);
  process.exit(1);
}
if (report.oom_kill.delta && report.oom_kill.delta > 0) {
  console.error(`FAIL - ${report.oom_kill.delta} OOM kills occurred during the run`);
  process.exit(1);
}
console.log(`OK - ${finished}/${count} completed, p95 ${pct(0.95)}ms, OOM kill delta ${report.oom_kill.delta ?? "n/a"}`);
