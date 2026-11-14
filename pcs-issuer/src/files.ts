import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import type { ServerResponse } from "node:http";
import { PcsError } from "./errors.js";
import type { PcsService } from "./service.js";
import { spawnSshExec, type SshTarget } from "./ssh.js";

/**
 * Workspace file browser.
 *
 * The scheduler has no file API and host-runtime only ever calls out, so the control plane reads the
 * workspace the same way the terminal reaches the container: `docker exec` on the host (or a plain
 * SSH command for a bare-metal builder). Listing and deletion are ordinary commands; downloads go
 * through a one-time ticket so the browser can stream a file or a tar.gz straight to disk without
 * holding it in memory.
 *
 * Every path is relative to the workspace root. Absolute paths and `..` are rejected: the terminal
 * already offers the whole filesystem, and this endpoint should not become a second way around it.
 */

const CONTAINER_WORKSPACE = "/opt/platform/workspace";
/** Bare-metal builders run as the host login user; keep in sync with NATIVE_WORKSPACE_DIR in host-runtime. */
const NATIVE_WORKSPACE = "$HOME/platform/workspace";
const MAX_ENTRIES = 5_000;
const TICKET_TTL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

type Target = {
  transport: "local" | "ssh";
  container: string;
  native?: boolean;
  ssh?: SshTarget;
  workspace?: string;
};

export type FileEntry = {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number | null;
  modified_at: string | null;
};

type Ticket = {
  rel: string;
  kind: "file" | "dir";
  name: string;
  target: Target;
  expiresAt: number;
};

const tickets = new Map<string, Ticket>();

/** Workspace-relative path; `..`, absolute paths and NUL bytes never reach a shell. */
export function normalizeRelPath(raw: unknown): string {
  const value = String(raw ?? "");
  if (value.includes("\0")) throw new PcsError(400, "PATH_INVALID", "path contains a NUL byte");
  if (value.startsWith("/")) {
    throw new PcsError(400, "PATH_DENIED", "path must be relative to the workspace root");
  }
  const segments = value.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new PcsError(400, "PATH_DENIED", "path must stay inside the workspace");
  }
  const rel = segments.join("/");
  if (Buffer.byteLength(rel) > 4_096) throw new PcsError(400, "PATH_INVALID", "path is too long");
  return rel;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function displayRoot(target: Target): string {
  return target.native ? "~/platform/workspace" : target.workspace || CONTAINER_WORKSPACE;
}

function cdRoot(target: Target): string {
  const root = target.native ? NATIVE_WORKSPACE : quote(target.workspace || CONTAINER_WORKSPACE);
  return `cd ${root} 2>/dev/null || exit 4`;
}

function startOnTarget(target: Target, script: string): { child: ChildProcess; cleanup: () => void } {
  const command = target.native
    ? script
    : `docker exec ${quote(target.container)} sh -c ${quote(script)}`;
  if (target.transport === "ssh" && target.ssh) {
    return spawnSshExec(target.ssh, command);
  }
  if (target.native) {
    const child = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    return { child, cleanup: () => {} };
  }
  const child = spawn("docker", ["exec", target.container, "sh", "-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, cleanup: () => {} };
}

function execOnTarget(
  target: Target,
  script: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const { child, cleanup } = startOnTarget(target, script);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (b: Buffer) => chunks.push(b));
    child.stderr?.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString("utf8")).slice(-4_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      reject(new PcsError(502, "HOST_UNREACHABLE", `cannot reach the instance: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

/** Exit codes are shared by every command below: 3 = missing, 4 = workspace root unavailable. */
function commandFailure(code: number, stderr: string): never {
  if (code === 3) throw new PcsError(404, "FILE_NOT_FOUND", "no such file or directory");
  if (code === 4) {
    throw new PcsError(409, "WORKSPACE_UNAVAILABLE", "the workspace directory does not exist on this instance");
  }
  throw new PcsError(502, "HOST_ERROR", stderr.trim() || `command exited with code ${code}`);
}

async function targetFor(service: PcsService, hostId: string, instanceId: string): Promise<Target> {
  return (await service.terminalTarget(hostId, instanceId)) as Target;
}

export async function listInstanceFiles(
  service: PcsService,
  hostId: string,
  instanceId: string,
  rawPath: unknown,
): Promise<{ path: string; root: string; entries: FileEntry[]; truncated: boolean }> {
  const rel = normalizeRelPath(rawPath);
  const target = await targetFor(service, hostId, instanceId);
  const dir = quote(rel ? `./${rel}` : ".");
  const script = [
    cdRoot(target),
    `dir=${dir}`,
    '[ -d "$dir" ] || exit 3',
    "n=0",
    'for f in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do',
    '  if [ ! -e "$f" ] && [ ! -L "$f" ]; then continue; fi',
    "  n=$((n+1))",
    `  if [ "$n" -gt ${MAX_ENTRIES} ]; then printf 'T\\0'; break; fi`,
    '  if [ -L "$f" ]; then t=l; elif [ -d "$f" ]; then t=d; elif [ -f "$f" ]; then t=f; else t=o; fi',
    '  size=""',
    '  if [ "$t" = f ]; then size=$(wc -c < "$f" 2>/dev/null | tr -d " "); fi',
    '  mt=$(stat -c %Y "$f" 2>/dev/null); [ -n "$mt" ] || mt=$(stat -f %m "$f" 2>/dev/null)',
    '  name=${f##*/}',
    '  printf \'%s\\0%s\\0%s\\0%s\\0\' "$t" "$mt" "$size" "$name"',
    "done",
  ].join("\n");

  const out = await execOnTarget(target, script);
  if (out.code !== 0) commandFailure(out.code, out.stderr);

  return { path: rel, root: displayRoot(target), ...parseListing(out.stdout) };
}

/**
 * The listing command prints one record per entry: type, mtime (epoch seconds), size (files only) and
 * name, all NUL separated. A lone `T` record means the directory exceeded MAX_ENTRIES.
 */
export function parseListing(stdout: Buffer): { entries: FileEntry[]; truncated: boolean } {
  const parts = stdout.toString("utf8").split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  const entries: FileEntry[] = [];
  let truncated = false;
  for (let i = 0; i < parts.length; ) {
    if (parts[i] === "T") {
      truncated = true;
      break;
    }
    if (i + 3 >= parts.length) break;
    const [kind, rawModified, rawSize, name] = parts.slice(i, i + 4);
    i += 4;
    if (!name) continue;
    const type = kind === "d" ? "dir" : kind === "f" ? "file" : kind === "l" ? "symlink" : "other";
    const size = rawSize && Number.isFinite(Number(rawSize)) ? Number(rawSize) : null;
    const seconds = rawModified && Number.isFinite(Number(rawModified)) ? Number(rawModified) : null;
    entries.push({
      name,
      type,
      size,
      modified_at: seconds !== null ? new Date(seconds * 1_000).toISOString() : null,
    });
  }

  entries.sort((a, b) => {
    const rank = (e: FileEntry) => (e.type === "dir" ? 0 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  return { entries, truncated };
}

export async function deleteInstanceFile(
  service: PcsService,
  hostId: string,
  instanceId: string,
  rawPath: unknown,
  operator: string,
): Promise<{ deleted: string }> {
  const rel = normalizeRelPath(rawPath);
  if (!rel) throw new PcsError(400, "PATH_REQUIRED", "the workspace root cannot be deleted");
  const target = await targetFor(service, hostId, instanceId);
  const script = [
    cdRoot(target),
    `p=${quote(`./${rel}`)}`,
    '[ -e "$p" ] || [ -L "$p" ] || exit 3',
    'rm -rf "$p"',
  ].join("\n");
  const out = await execOnTarget(target, script);
  if (out.code !== 0) commandFailure(out.code, out.stderr);
  await service.audit(operator, "instance.workspace.delete", instanceId, instanceId, {
    host_id: hostId,
    path: rel,
  });
  return { deleted: rel };
}

/**
 * Downloads need a ticket because a browser navigation cannot carry the Bearer token. The ticket is
 * single-use, expires in 60 seconds and is bound to one instance and one path before issuance.
 */
export async function issueFileDownloadTicket(
  service: PcsService,
  input: { host_id: string; instance_id: string; path?: unknown },
): Promise<{ url: string; expires_in: number }> {
  const rel = normalizeRelPath(input.path);
  const target = await targetFor(service, input.host_id, input.instance_id);
  const script = [
    cdRoot(target),
    `p=${quote(rel ? `./${rel}` : ".")}`,
    '[ -e "$p" ] || [ -L "$p" ] || exit 3',
    'if [ -d "$p" ]; then echo dir; else echo file; fi',
  ].join("\n");
  const out = await execOnTarget(target, script);
  if (out.code !== 0) commandFailure(out.code, out.stderr);
  const kind = out.stdout.toString("utf8").trim() === "dir" ? "dir" : "file";
  if (kind === "file" && !rel) {
    throw new PcsError(400, "PATH_REQUIRED", "the workspace root is a directory");
  }

  const now = Date.now();
  for (const [key, value] of tickets) {
    if (value.expiresAt <= now) tickets.delete(key);
  }
  const token = crypto.randomBytes(24).toString("base64url");
  tickets.set(token, {
    rel,
    kind,
    name: kind === "dir" ? `${rel ? rel.split("/").pop() : input.instance_id}.tar.gz` : rel.split("/").pop()!,
    target,
    expiresAt: now + TICKET_TTL_MS,
  });
  return { url: `/api/v1/platform/files/download?token=${token}`, expires_in: TICKET_TTL_MS / 1000 };
}

function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function streamFileDownload(res: ServerResponse, url: URL): void {
  const token = url.searchParams.get("token") ?? "";
  const ticket = tickets.get(token);
  if (ticket) tickets.delete(token);
  if (!ticket || ticket.expiresAt <= Date.now()) {
    res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "TICKET_INVALID", message: "download ticket is missing or expired" } }));
    return;
  }

  const path = quote(ticket.kind === "dir" ? (ticket.rel ? `./${ticket.rel}` : ".") : `./${ticket.rel}`);
  const script = [
    cdRoot(ticket.target),
    ticket.kind === "dir" ? `exec tar -czf - ${path}` : `exec cat ${path}`,
  ].join("\n");

  const { child, cleanup } = startOnTarget(ticket.target, script);
  let started = false;
  let stderr = "";
  const begin = () => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      "content-type": ticket.kind === "dir" ? "application/gzip" : "application/octet-stream",
      "content-disposition": disposition(ticket.name),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    begin();
    // Respect backpressure so a slow client does not make us buffer the whole archive in memory.
    if (!res.write(chunk)) child.stdout?.pause();
  });
  res.on("drain", () => child.stdout?.resume());
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
  });
  child.on("error", (e) => {
    cleanup();
    if (!started) {
      sendJson(res, 502, { error: { code: "HOST_UNREACHABLE", message: e.message } });
    } else {
      res.destroy();
    }
  });
  child.on("close", (code) => {
    cleanup();
    if (started) {
      res.end();
      return;
    }
    if (code === 3) {
      sendJson(res, 404, { error: { code: "FILE_NOT_FOUND", message: "no such file or directory" } });
    } else if (code === 4) {
      sendJson(res, 409, {
        error: { code: "WORKSPACE_UNAVAILABLE", message: "the workspace directory does not exist" },
      });
    } else if (code === 0) {
      // Empty file or empty archive: send valid headers with no body.
      begin();
      res.end();
    } else {
      sendJson(res, 502, {
        error: { code: "HOST_ERROR", message: stderr.trim() || `command exited with code ${code}` },
      });
    }
  });
  res.on("close", () => {
    if (!res.writableEnded) child.kill("SIGKILL");
  });
}
