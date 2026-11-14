import { t } from "../i18n";
import { getLiveConnection } from "./config";
import { ApiError, pcs } from "./client";

/** Preview cap: anything larger is downloaded instead of rendered in the page. */
export const PREVIEW_LIMIT_BYTES = 256 * 1024;

export type WorkspaceEntry = {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number | null;
  modified_at: string | null;
};

export type WorkspaceListing = {
  path: string;
  root: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
};

function filesPath(instanceId: string, hostId: string, path: string): string {
  const q = new URLSearchParams({ host_id: hostId, path });
  return `/api/v1/platform/instances/${encodeURIComponent(instanceId)}/files?${q.toString()}`;
}

export async function listWorkspace(
  hostId: string,
  instanceId: string,
  path: string,
): Promise<WorkspaceListing> {
  return pcs(getLiveConnection(), filesPath(instanceId, hostId, path));
}

export async function deleteWorkspaceEntry(
  hostId: string,
  instanceId: string,
  path: string,
): Promise<void> {
  const connection = getLiveConnection();
  await pcs(connection, filesPath(instanceId, hostId, path), { method: "DELETE" });
}

/**
 * The download runs as a browser navigation so a folder archive streams to disk instead of
 * passing through JavaScript memory. The PCS issues a single-use URL for one instance and path.
 */
export async function downloadWorkspaceEntry(
  hostId: string,
  instanceId: string,
  path: string,
): Promise<void> {
  const connection = getLiveConnection();
  const out = await pcs(
    connection,
    `/api/v1/platform/instances/${encodeURIComponent(instanceId)}/files/download`,
    { method: "POST", body: { host_id: hostId, path } },
  );
  const link = document.createElement("a");
  link.href = `${connection.pcsUrl}${out.url}`;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * Text preview reuses the download ticket: the one-time URL needs no bearer, so the page can read it
 * with fetch instead of navigating. Callers check the size first; the cap below is the backstop.
 */
export async function readWorkspaceFile(
  hostId: string,
  instanceId: string,
  path: string,
): Promise<string> {
  const connection = getLiveConnection();
  const out = await pcs(
    connection,
    `/api/v1/platform/instances/${encodeURIComponent(instanceId)}/files/download`,
    { method: "POST", body: { host_id: hostId, path } },
  );
  const res = await fetch(`${connection.pcsUrl}${out.url}`, { cache: "no-store" });
  if (!res.ok) {
    throw new ApiError(res.status, "PREVIEW_FAILED", t("无法读取文件内容。"));
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > PREVIEW_LIMIT_BYTES) {
    throw new ApiError(413, "FILE_TOO_LARGE", t("文件过大，无法预览（上限 256 KiB）。"));
  }
  const text = new TextDecoder().decode(buf);
  if (text.includes("\u0000")) {
    throw new ApiError(415, "BINARY_FILE", t("这是二进制文件，无法以文本方式预览。"));
  }
  return text;
}
