import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Assignment } from "../client.js";
import { TaskAborted, TaskFailed, type ExecContext } from "../exec-types.js";

/**
 * 角色执行器的公共部分。
 *
 * 铁律：上游制品只能从调度机交接的 `requirements.upstream_artifacts` 里拿；
 * 拿到之后必须按交接单里的 sha256 自己重算一遍。传输成功不等于内容可信。
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

/** 可中断的 sleep：租约丢了就立刻停手，不要继续干活 */
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

/** 按产出阶段挑制品。交接单里的 task_type 是调度机写入的，不是执行器自报。 */
export function refFromTask(task: Assignment, taskType: string): UpstreamRef | undefined {
  return upstreamRefs(task).find((r) => r.task_type === taskType);
}

export function refByDigest(task: Assignment, digest: string): UpstreamRef | undefined {
  return upstreamRefs(task).find((r) => r.sha256 === digest);
}

/** 下载并复核交接摘要；不一致立即失败，不进入后续步骤 */
export async function fetchVerified(ctx: ExecContext, ref: UpstreamRef): Promise<Buffer> {
  const got = await ctx.downloadArtifact(ref.artifact_id);
  const actual = sha256Of(got.data);
  if (ref.sha256 && actual !== ref.sha256) {
    throw new TaskFailed(
      "UPSTREAM_ARTIFACT_DIGEST_MISMATCH",
      `上游制品 ${ref.artifact_id} 摘要不符：交接 ${ref.sha256}，实际 ${actual}`,
      { artifact_id: ref.artifact_id, expected: ref.sha256, actual },
    );
  }
  if (got.sha256 && got.sha256 !== actual) {
    throw new TaskFailed(
      "UPSTREAM_ARTIFACT_DIGEST_MISMATCH",
      `上游制品 ${ref.artifact_id} 与调度机确认的摘要不符`,
      { artifact_id: ref.artifact_id, scheduler: got.sha256, actual },
    );
  }
  return got.data;
}

/** 严格 JSON 解析：制品是外部输入，坏格式按不可重试的产物错误处理 */
export function parseJson<T = any>(buf: Buffer, what: string): T {
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    throw new TaskFailed("UPSTREAM_ARTIFACT_INVALID", `${what} 不是合法 JSON`, {
      bytes: buf.length,
    });
  }
}

/** 工作目录内的相对路径，拒绝绝对路径与 ..，避免制品清单把文件写到目录外 */
export function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new TaskFailed("PAYLOAD_INVALID", `工作目录路径越界: ${rel}`);
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
 * 在交接过来的内容里找凭据样式。发现即拒绝，不做“也许没事”的判断。
 * 制品多是 JSON，先把 `\"` 之类的转义还原，否则值里的引号会把匹配截断。
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
