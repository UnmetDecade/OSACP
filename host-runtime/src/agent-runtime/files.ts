import fs from "node:fs";
import path from "node:path";
import type { Assignment } from "../client.js";
import { TaskFailed } from "../exec-types.js";

/**
 * File helpers shared by every executor.
 *
 * Attachments (inputs) and collected files (outputs) are ordinary bytes of any format: the runtime never
 * parses them, it only moves them between the control plane and the workspace. Media types are inferred
 * from the extension so a download arrives with a sensible content-type instead of octet-stream.
 */

/** Attachment limits: the task request body already has a limit; this adds another layer so an abnormal payload cannot fill the workspace. */
export const MAX_ATTACHMENT_FILES = 16;
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 128 * 1024 * 1024;

const MEDIA_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".rst": "text/plain",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/x-typescript",
  ".tsx": "text/x-typescript",
  ".jsx": "text/javascript",
  ".py": "text/x-python",
  ".sh": "application/x-sh",
  ".bash": "application/x-sh",
  ".zsh": "application/x-sh",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cc": "text/x-c++src",
  ".cpp": "text/x-c++src",
  ".cxx": "text/x-c++src",
  ".hpp": "text/x-c++hdr",
  ".hh": "text/x-c++hdr",
  ".java": "text/x-java-source",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".rb": "text/x-ruby",
  ".php": "text/x-php",
  ".sql": "application/sql",
  ".patch": "text/x-patch",
  ".diff": "text/x-patch",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
};

/** Best-effort media type from the file name; unknown formats stay application/octet-stream. */
export function mediaFor(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".tar.gz")) return "application/gzip";
  if (lower.endsWith(".tar.bz2")) return "application/x-bzip2";
  if (lower.endsWith(".tar.xz")) return "application/x-xz";
  return MEDIA_BY_EXT[path.extname(lower)] ?? "application/octet-stream";
}

/** A workspace-relative path that is safe to write into: no absolute paths, no `..`, no backslashes. */
export function safeRelativePath(raw: string): string {
  const rel = raw.replace(/^\.\/+/, "");
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) {
    throw new TaskFailed("FILE_PATH_DENIED", `path must be relative and inside the workspace: ${raw}`);
  }
  return rel;
}

/** Resolve a workspace-relative path and refuse anything that escapes the workspace through a symlink. */
export function resolveInsideWorkspace(rel: string, workspaceDir: string): string {
  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, safeRelativePath(rel));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new TaskFailed("FILE_PATH_DENIED", `path escapes the workspace: ${rel}`);
  }
  return target;
}

function attachmentName(raw: unknown, index: number): string {
  const source = typeof raw === "string" ? raw.replace(/\\/g, "/") : "";
  const base = path
    .basename(source)
    .replace(/[^\p{L}\p{N}._()\- ]/gu, "_")
    .trim()
    .slice(0, 120);
  const name = base && base !== "." && base !== ".." ? base : `attachment-${index + 1}`;
  return name.startsWith(".") ? `_${name}` : name;
}

/** Fetch attachment content: prefer the control plane's one-time URL, with compatibility for base64 in older tasks. */
async function loadAttachment(rec: Record<string, unknown>): Promise<Buffer | null> {
  let data = String(rec.data_base64 ?? "");
  const comma = data.indexOf(",");
  if (data.startsWith("data:") && comma >= 0) data = data.slice(comma + 1);
  if (data) {
    const buf = Buffer.from(data, "base64");
    return buf.length ? buf : null;
  }
  const rawUrl = typeof rec.url === "string" ? rec.url.trim() : "";
  if (!rawUrl) return null;
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new TaskFailed("ATTACHMENT_URL_INVALID", "Invalid attachment URL");
  }
  // Only http(s) is allowed; a task URL should not lead the builder to schemes such as file:/gopher:.
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TaskFailed("ATTACHMENT_URL_INVALID", "Attachment URL must use http or https");
  }
  let res: Response;
  try {
    res = await fetch(target, {
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
  } catch (err) {
    throw new TaskFailed(
      "ATTACHMENT_FETCH_FAILED",
      `Failed to fetch attachment: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new TaskFailed("ATTACHMENT_FETCH_FAILED", `Failed to fetch attachment: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length ? buf : null;
}

export interface MaterializedAttachment {
  name: string;
  path: string;
  media_type: string;
  size_bytes: number;
}

/**
 * Write a list of attachment references under <workspace>/attachments/.
 *
 * Attachment content enters memory only at this step; the executor receives file paths and metadata.
 * Large files are downloaded via the control plane's one-time URL, keeping the task JSON itself small.
 */
export async function materializeAttachmentList(
  list: unknown[],
  workspaceDir: string,
): Promise<MaterializedAttachment[]> {
  if (list.length === 0) return [];
  const dir = path.join(workspaceDir, "attachments");
  fs.mkdirSync(dir, { recursive: true });
  const materialized: MaterializedAttachment[] = [];
  const used = new Set<string>();
  let total = 0;

  for (let i = 0; i < list.length && materialized.length < MAX_ATTACHMENT_FILES; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const buf = await loadAttachment(rec);
    if (!buf) continue;
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      throw new TaskFailed("ATTACHMENT_TOO_LARGE", "Attachment exceeds 32MiB");
    }
    total += buf.length;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) break;

    let name = attachmentName(rec.name, i);
    if (used.has(name)) {
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n++;
      name = `${stem}-${n}${ext}`;
    }
    const file = path.join(dir, name);
    if (!file.startsWith(dir + path.sep)) continue;
    used.add(name);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    materialized.push({
      name,
      path: `attachments/${name}`,
      media_type: typeof rec.media_type === "string" ? rec.media_type : "application/octet-stream",
      size_bytes: buf.length,
    });
  }
  return materialized;
}

/** Materialize `requirements.build.attachments` for executors that only know the build shape (agent/build tasks). */
export async function materializeAttachments(
  task: Assignment,
  workspaceDir: string,
): Promise<Assignment> {
  const requirements = task.requirements ?? {};
  const build = requirements.build;
  if (!build || typeof build !== "object") return task;
  const list = (build as Record<string, unknown>).attachments;
  if (!Array.isArray(list) || list.length === 0) return task;
  const materialized = await materializeAttachmentList(list, workspaceDir);
  const nextBuild = { ...(build as Record<string, unknown>), attachments: materialized };
  return { ...task, requirements: { ...requirements, build: nextBuild } };
}
