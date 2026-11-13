import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Assignment } from "../client.js";
import { TaskAborted, TaskFailed, type ExecContext } from "../exec-types.js";

/**
 * Shared parts of role executors.
 *
 * Iron rule: upstream artifacts may only come from `requirements.upstream_artifacts` handed over by the scheduler;
 * once received, recompute the sha256 yourself against the handoff record. A successful transfer does not mean the content is trustworthy.
 */

export interface UpstreamRef {
  artifact_id: string;
  sha256?: string;
  media_type?: string;
  task_id?: string;
  task_type?: string;
}

export const MEDIA = {
  build: "application/vnd.platform.build-manifest+json",
  log: "text/plain; charset=utf-8",
  review: "application/vnd.platform.review-report+json",
  commit: "application/vnd.platform.commit-record+json",
  test: "application/vnd.platform.test-report+json",
  ticket: "application/vnd.platform.ticket-intake+json",
  analysis: "application/vnd.platform.ticket-analysis+json",
  response: "text/plain; charset=utf-8",
} as const;

/** Abortable sleep: stop immediately once the lease is lost; do not keep working */
export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  const abortReason = (): "cancelled" | "lease_lost" | "shutdown" => {
    const r = signal.reason;
    return r === "cancelled" || r === "shutdown" ? r : "lease_lost";
  };
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new TaskAborted(abortReason()));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(new TaskAborted(abortReason()));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function sha256Of(data: Buffer | string): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

export function upstreamRefs(task: Assignment): UpstreamRef[] {
  const raw = (task.requirements ?? {}) as Record<string, unknown>;
  const list = raw.upstream_artifacts;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (v): v is UpstreamRef =>
      !!v && typeof v === "object" && typeof (v as any).artifact_id === "string",
  );
}

/** Pick an artifact by output stage. The task_type in the handoff record is written by the scheduler, not self-reported by the executor. */
export function refFromTask(task: Assignment, taskType: string): UpstreamRef | undefined {
  return upstreamRefs(task).find((r) => r.task_type === taskType);
}

export function refByDigest(task: Assignment, digest: string): UpstreamRef | undefined {
  return upstreamRefs(task).find((r) => r.sha256 === digest);
}

/** Download and re-verify the handoff digest; fail immediately on mismatch and do not proceed to later steps */
export async function fetchVerified(ctx: ExecContext, ref: UpstreamRef): Promise<Buffer> {
  const got = await ctx.downloadArtifact(ref.artifact_id);
  const actual = sha256Of(got.data);
  if (ref.sha256 && actual !== ref.sha256) {
    throw new TaskFailed(
      "UPSTREAM_ARTIFACT_DIGEST_MISMATCH",
      `Upstream artifact ${ref.artifact_id} digest mismatch: handoff ${ref.sha256}, actual ${actual}`,
      { artifact_id: ref.artifact_id, expected: ref.sha256, actual },
    );
  }
  if (got.sha256 && got.sha256 !== actual) {
    throw new TaskFailed(
      "UPSTREAM_ARTIFACT_DIGEST_MISMATCH",
      `Upstream artifact ${ref.artifact_id} does not match the digest confirmed by the scheduler`,
      { artifact_id: ref.artifact_id, scheduler: got.sha256, actual },
    );
  }
  return got.data;
}

/** Strict JSON parsing: artifacts are external input, so bad format is treated as a non-retryable artifact error */
export function parseJson<T = any>(buf: Buffer, what: string): T {
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    throw new TaskFailed("UPSTREAM_ARTIFACT_INVALID", `${what} is not valid JSON`, {
      bytes: buf.length,
    });
  }
}

/** Relative path within the workspace; reject absolute paths and .. so an artifact manifest cannot write files outside the directory */
export function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new TaskFailed("PAYLOAD_INVALID", `Workdir path escapes the boundary: ${rel}`);
  }
  return abs;
}

export function writeWorkspaceFile(root: string, rel: string, content: string): { path: string; sha256: string; size_bytes: number } {
  const file = safeJoin(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.from(content);
  fs.writeFileSync(file, buf);
  return { path: rel, sha256: sha256Of(buf), size_bytes: buf.length };
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["credential_assignment", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*["']?[^\s"',}]{8,}/i],
  ["svn_url_credentials", /\bsvn(?:\+ssh)?:\/\/[^\s/@]+:[^\s/@]+@/i],
];

/**
 * Look for credential patterns in handed-over content. Any hit is rejected; no "it is probably fine" judgement.
 * Artifacts are mostly JSON, so unescape sequences such as `\"` first; otherwise quotes inside values truncate the match.
 */
export function scanForSecrets(text: string): Array<{ rule: string; sample: string }> {
  const normalized = text.replace(/\\(["'\\/bfnrt])/g, "$1");
  const hits: Array<{ rule: string; sample: string }> = [];
  for (const [rule, re] of SECRET_PATTERNS) {
    const m = re.exec(normalized);
    if (m) hits.push({ rule, sample: `${m[0].slice(0, 24)}…` });
  }
  return hits;
}
