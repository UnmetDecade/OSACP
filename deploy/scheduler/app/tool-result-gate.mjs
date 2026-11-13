/**
 * Tool result gate for the scheduler Agent's builder tools.
 *
 * A single `apt install` or test run can return hundreds of kilobytes of output. Pasting that into the
 * conversation costs tokens on every later turn and pushes the useful tail (the error) out of reach.
 * The gate keeps the head and the tail, writes the full text to a file next to the scheduler, and hands
 * back a handle. The Agent reads what it actually needs through `read_result`, one bounded slice at a
 * time. Nothing is silently dropped: every cut names its size and the handle that holds the rest.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** Characters the gate is willing to put into one tool result. */
export const RESULT_BUDGET = 8_000;
/** Split of an oversized section: enough head for context, enough tail for the error. */
export const SAMPLE_HEAD = 3_000;
export const SAMPLE_TAIL = 2_000;
/** Full text kept on disk; past this only the head and tail survive. */
const MAX_SPILL = 2_000_000;
const MAX_HANDLES = 32;

const HANDLE_DIR = process.env.OSACP_TOOL_RESULT_DIR || path.join(os.tmpdir(), "osacp-tool-results");

/** handle → absolute file path, newest last; bounded so a long session cannot fill the disk. */
const handles = new Map();
let sequence = 0;

function spill(text) {
  const capped =
    text.length <= MAX_SPILL
      ? text
      : `${text.slice(0, MAX_SPILL / 2)}\n[... ${text.length - MAX_SPILL} chars lost: the result exceeded the ${MAX_SPILL}-char spill limit]\n${text.slice(-MAX_SPILL / 2)}`;
  fs.mkdirSync(HANDLE_DIR, { recursive: true, mode: 0o700 });
  const handle = `r${++sequence}`;
  const file = path.join(HANDLE_DIR, `${handle}-${crypto.randomBytes(4).toString("hex")}.log`);
  fs.writeFileSync(file, capped, { mode: 0o600 });
  handles.set(handle, file);
  while (handles.size > MAX_HANDLES) {
    const oldest = handles.keys().next().value;
    const oldFile = handles.get(oldest);
    handles.delete(oldest);
    try {
      fs.unlinkSync(oldFile);
    } catch {
      /* the file may already be gone; the handle is what matters */
    }
  }
  return { handle, file, truncated: capped.length !== text.length };
}

/**
 * Return `text` unchanged when it fits the budget; otherwise keep the head and tail, spill the rest,
 * and say exactly what was kept and where the full text went.
 */
export function boundedSection(label, text) {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (value.length <= RESULT_BUDGET) return label ? `${label}:\n${value}` : value;
  const { handle, file, truncated } = spill(value);
  const head = value.slice(0, SAMPLE_HEAD);
  const tail = value.slice(-SAMPLE_TAIL);
  const omitted = value.length - SAMPLE_HEAD - SAMPLE_TAIL;
  const lines = [
    `${label || "output"}: ${value.length} chars, too large for one result; showing the first ${SAMPLE_HEAD} and last ${SAMPLE_TAIL}.`,
    head,
    `[... ${omitted} chars omitted; full text kept as handle ${handle}${truncated ? " (itself capped)" : ""} at ${file}]`,
    tail,
    `Read only what you need with read_result { "handle": "${handle}", "grep": "pattern" } or { "handle": "${handle}", "offset": <chars>, "limit": <chars up to ${RESULT_BUDGET}> }. Do not ask for the whole file.`,
  ];
  return lines.join("\n");
}

/** One bounded slice of a spilled result: a line window, a grep with context, or a character range. */
export function readResult(handle, args = {}) {
  const key = String(handle ?? "").trim();
  const file = handles.get(key);
  if (!file) {
    const known = [...handles.keys()].slice(-8).join(", ") || "none";
    throw new Error(`unknown result handle "${key}" (handles from this session: ${known}); handles are discarded as new results arrive`);
  }
  const text = fs.readFileSync(file, "utf8");
  const limit = Math.min(Math.max(Number(args.limit) || RESULT_BUDGET, 1), RESULT_BUDGET);
  const pattern = String(args.grep ?? "").trim();

  if (pattern) {
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch (e) {
      throw new Error(`invalid grep pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
    const context = Math.min(Math.max(Number(args.context) || 2, 0), 20);
    const lines = text.split("\n");
    const picked = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!re.test(lines[i])) continue;
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) {
        if (picked[picked.length - 1] !== j) picked.push(j);
        if (picked.length > 400) break;
      }
      if (picked.length > 400) break;
    }
    if (!picked.length) return `No line in ${key} matches /${pattern}/i (${lines.length} lines).`;
    const out = [];
    let size = 0;
    for (const index of picked) {
      const line = `${index + 1}\t${lines[index]}`;
      if (size + line.length > limit) {
        out.push(`[... stopped at ${limit} chars; narrow the pattern, or use read_result with offset]`);
        break;
      }
      out.push(line);
      size += line.length + 1;
    }
    return `${key}: ${picked.length} matching line(s), showing a ${limit}-char window\n${out.join("\n")}`;
  }

  const offset = Math.min(Math.max(Number(args.offset) || 0, 0), text.length);
  const slice = text.slice(offset, offset + limit);
  const remaining = text.length - offset - slice.length;
  return `${key}: chars ${offset}–${offset + slice.length} of ${text.length}\n${slice}${remaining > 0 ? `\n[... ${remaining} chars remain; continue with offset=${offset + slice.length}]` : ""}`;
}

/** Test seam: forget every handle this process handed out. */
export function resetHandles() {
  for (const file of handles.values()) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* best effort */
    }
  }
  handles.clear();
}
