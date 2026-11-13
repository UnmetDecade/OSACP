#!/usr/bin/env node
/**
 * Run a shell command on a builder through a sideload token, with files in both directions.
 *
 * Inputs: --upload sends local files to the control plane first; the builder materializes them under
 * `attachments/` before the command runs. Outputs: --collect lists workspace paths (default `.`), and
 * after the task finishes every produced file is downloaded through the scheduler's artifact channel
 * and written into --out with its original relative path.
 *
 * Unlike printing a base64 tar into stdout, this path is not limited to the 256 KiB console capture:
 * each artifact can be up to 64 MiB and any format (source, binaries, images, archives) is stored and
 * returned byte-for-byte; the SHA-256 is verified again here before a file is written.
 *
 * Usage:
 *   SIDELOAD_TOKEN='sdl_…' PCS_URL='http://192.168.10.110:7901' \
 *     node scripts/sideload-project.mjs \
 *       --out tmp/hello-cpp \
 *       --upload ./input/data.csv \
 *       --command 'g++ -O2 -std=c++17 hello.cpp -o hello && ./hello > result.txt' \
 *       --collect .
 *
 * Options:
 *   --out <dir>        local directory to receive the collected files (required)
 *   --command <sh>     command to run in the workspace (required)
 *   --pcs <url>        control-plane base URL (or PCS_URL)
 *   --instance <id>    pin a builder instance (default: the scheduler picks by W)
 *   --timeout <sec>    task deadline and local wait limit (default 180)
 *   --collect <path>   workspace-relative path to bring back; repeatable, directories are walked (default `.`)
 *   --upload <file>    local file to send as an input attachment; repeatable (max 16)
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`${key} needs a value`);
    const name = key.slice(2);
    if (name === "upload" || name === "collect") {
      (out[name] ??= []).push(value);
    } else {
      out[name] = value;
    }
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const token = (process.env.SIDELOAD_TOKEN ?? "").trim();
const pcs = (args.pcs ?? process.env.PCS_URL ?? "").trim().replace(/\/+$/, "");
if (!token.startsWith("sdl_")) fail("SIDELOAD_TOKEN is required (sdl_…)");
if (!pcs) fail("PCS_URL or --pcs is required");
if (!args.command) fail("--command is required");
if (!args.out) fail("--out is required");

const outDir = path.resolve(args.out);
const timeoutSec = Number(args.timeout ?? 180);
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) fail("--timeout must be a positive number");

const MEDIA_BY_EXT = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".py": "text/x-python",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++src",
  ".hpp": "text/x-c++hdr",
  ".js": "text/javascript",
  ".ts": "text/x-typescript",
  ".sh": "application/x-sh",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
const mediaFor = (file) => MEDIA_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";

async function call(pathname, { method = "GET", body } = {}) {
  const res = await fetch(pcs + pathname, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const code = data?.error?.code ?? `HTTP_${res.status}`;
    throw new Error(`${code}: ${data?.error?.message ?? text}`);
  }
  return data;
}

/** Upload every --upload file, then hand the references to the task. */
async function uploadInputs(files) {
  const refs = [];
  for (const file of files) {
    const abs = path.resolve(file);
    const buf = fs.readFileSync(abs);
    if (buf.length > 24 * 1024 * 1024) fail(`${file} is larger than the 24MiB attachment limit`);
    const name = path.basename(abs);
    const uploaded = await call("/api/v1/sideload/attachments", {
      method: "POST",
      body: { name, media_type: mediaFor(name), data_base64: buf.toString("base64") },
    });
    refs.push(uploaded);
    console.log(`uploaded ${name} (${buf.length} B)`);
  }
  return refs;
}

const collect = args.collect ?? ["."];
const attachments = await uploadInputs(args.upload ?? []);

const deadline = new Date(Date.now() + timeoutSec * 1000).toISOString();
const created = await call("/api/v1/sideload/tasks", {
  method: "POST",
  body: {
    task_type: "task.console.builder",
    priority_class: 0,
    max_attempts: 1,
    deadline_at: deadline,
    requirements: {
      ...(args.instance ? { target_instance_id: args.instance } : {}),
      console: {
        command: args.command,
        operator: "sideload-project",
        collect,
        ...(attachments.length ? { attachments } : {}),
      },
    },
  },
});
const taskId = String(created.task_id ?? "");
if (!taskId) fail(`the scheduler did not return a task_id: ${JSON.stringify(created)}`);
console.log(`task ${taskId} created, waiting for a builder…`);

const stopAt = Date.now() + timeoutSec * 1000;
let task;
for (;;) {
  task = await call(`/api/v1/sideload/tasks/${encodeURIComponent(taskId)}`);
  if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(task.status)) break;
  if (Date.now() > stopAt) {
    await call(`/api/v1/sideload/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
    fail(`timed out after ${timeoutSec}s; the task was cancelled`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

const attempt = task.attempts?.[0];
const outputs = attempt?.outputs ?? {};
const stdout = String(outputs.stdout ?? "");
const stderr = String(outputs.stderr ?? "");
console.log(`state ${task.status} on ${attempt?.instance_id ?? "unknown builder"}, exit ${outputs.exit_code}`);
if (stdout.trim()) console.log(`--- output ---\n${stdout.trim()}`);
if (stderr.trim()) console.error(`--- stderr ---\n${stderr.trim()}`);
for (const skipped of outputs.collect_skipped ?? []) {
  console.error(`skipped ${skipped.path}: ${skipped.reason}`);
}

const listed = await call(`/api/v1/sideload/tasks/${encodeURIComponent(taskId)}/artifacts`);
// The scheduler returns the artifact rows directly; older gateways wrapped them in { items }.
const artifacts = (Array.isArray(listed) ? listed : listed.items ?? []).filter(
  (a) => a.status === "COMPLETE",
);
if (!artifacts.length) {
  console.error("no output files were produced; check --collect paths and the command's output above");
}

let saved = 0;
for (const artifact of artifacts) {
  const rel = String(artifact.name ?? "").replace(/^\.\/+/, "");
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) {
    console.error(`refusing unsafe artifact name: ${artifact.name}`);
    continue;
  }
  const res = await fetch(
    `${pcs}/api/v1/sideload/artifacts/${encodeURIComponent(artifact.artifact_id)}/download`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const text = await res.text();
    console.error(`download failed for ${rel}: HTTP ${res.status} ${text.slice(0, 200)}`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
  if (artifact.actual_sha256 && sha !== artifact.actual_sha256) {
    fail(`digest mismatch for ${rel}: scheduler says ${artifact.actual_sha256}, received ${sha}`);
  }
  const dest = path.resolve(outDir, rel);
  if (!dest.startsWith(outDir + path.sep) && dest !== outDir) {
    console.error(`refusing path outside --out: ${rel}`);
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  saved += 1;
  console.log(`  saved ${rel} (${buf.length} B, ${artifact.media_type ?? "application/octet-stream"})`);
}
console.log(`--- saved ${saved} file(s) to ${outDir} ---`);

process.exit(Number.isInteger(outputs.exit_code) ? outputs.exit_code : task.status === "SUCCEEDED" ? 0 : 1);
