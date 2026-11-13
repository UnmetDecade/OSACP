import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The gate reads its spill directory once at import time, so point it at a scratch directory first.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "osacp-gate-test-"));
process.env.OSACP_TOOL_RESULT_DIR = DIR;
const gate = await import("../tool-result-gate.mjs");
const { boundedSection, readResult, resetHandles, RESULT_BUDGET } = gate as {
  boundedSection: (label: string, text: string) => string;
  readResult: (handle: string, args?: Record<string, unknown>) => string;
  resetHandles: () => void;
  RESULT_BUDGET: number;
};

test.after(() => {
  resetHandles();
  fs.rmSync(DIR, { recursive: true, force: true });
});

const handleOf = (text: string) => /handle (r\d+)/.exec(text)?.[1] ?? "";

test("small output passes through untouched", () => {
  const text = boundedSection("stdout", "installed 3 packages\n");
  assert.equal(text, "stdout:\ninstalled 3 packages\n");
});

test("oversized output becomes head + tail + handle", () => {
  // A realistic build log: the useful part is the last line, which must survive.
  const lines = Array.from({ length: 4_000 }, (_, i) => `compiling module ${i} ... ok`);
  const log = `${lines.join("\n")}\nerror: linker failed\n`;
  const text = boundedSection("stdout", log);
  assert.ok(text.length <= RESULT_BUDGET + 600, `gate kept ${text.length} chars`);
  assert.match(text, /handle r\d+/);
  assert.match(text, /chars omitted/);
  assert.match(text, /^compiling module 0 /m, "head is kept");
  assert.match(text, /error: linker failed/, "tail is kept");
  assert.doesNotMatch(text, /compiling module 2000 /m, "the middle is not sent");
});

test("read_result pages through characters", () => {
  const log = Array.from({ length: 2_000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
  const handle = handleOf(boundedSection("stdout", log));
  const first = readResult(handle, { offset: 0, limit: 100 });
  assert.match(first, new RegExp(`chars 0–100 of ${log.length}`));
  assert.match(first, /continue with offset=100/);
  const second = readResult(handle, { offset: log.length - 50, limit: 100 });
  assert.match(second, /chars \d+–\d+ of \d+/);
  assert.doesNotMatch(second, /continue with offset=/, "the last page says nothing remains");
});

test("read_result greps with context and line numbers", () => {
  const log = Array.from({ length: 500 }, (_, i) => `step ${i} ${"z".repeat(40)}`).join("\n");
  const handle = handleOf(boundedSection("stdout", log));
  const hit = readResult(handle, { grep: "step 250", context: 1 });
  assert.match(hit, /3 matching line\(s\)/);
  assert.match(hit, /250\tstep 249/, "line numbers are 1-based");
  assert.match(hit, /251\tstep 250/, "the match itself is included");
  assert.match(hit, /252\tstep 251/, "context lines follow the match");
  assert.doesNotMatch(hit, /step 100/, "unrelated lines stay out");
});

test("read_result reports a pattern that matches nothing", () => {
  const handle = handleOf(boundedSection("stdout", `${"all good\n".repeat(1_200)}`));
  assert.match(readResult(handle, { grep: "ENOENT" }), /No line in r\d+ matches/);
});

test("read_result rejects unknown handles and bad patterns", () => {
  assert.throws(() => readResult("r999"), /unknown result handle/);
  const handle = handleOf(boundedSection("stdout", "x".repeat(RESULT_BUDGET + 10)));
  assert.throws(() => readResult(handle, { grep: "(" }), /invalid grep pattern/);
});

test("old handles are dropped as new results arrive", () => {
  const first = handleOf(boundedSection("stdout", "y".repeat(RESULT_BUDGET + 10)));
  for (let i = 0; i < 40; i += 1) boundedSection("stdout", `${i}`.repeat(RESULT_BUDGET + 10));
  assert.throws(() => readResult(first), /unknown result handle/);
});
