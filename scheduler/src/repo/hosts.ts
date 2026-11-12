import { q } from "../db.js";
import { ApiError } from "../errors.js";

/** Host facts reported by the control plane (PCS); the scheduler uses them only to maintain the dispatchable host table. */
export interface HostSyncInput {
  host_id: string;
  name?: string;
  os?: string;
  arch?: string;
  host_state?: string;
  cpu_total?: number;
  mem_total_bytes?: number;
  mem_available_bytes?: number;
}

const STATES = new Set(["NORMAL", "WARNING", "THROTTLED", "PROTECTING", "RECOVERING"]);

/**
 * Host roster sync. Unknown states all collapse to PROTECTING: better to stop dispatching for now
 * than let a machine in an unknown state take tasks.
 */
export async function upsertHost(input: HostSyncInput) {
  const hostId = String(input.host_id ?? "").trim();
  if (!hostId) throw new ApiError(400, "BAD_REQUEST", "host_id 必填");
  const raw = String(input.host_state ?? "NORMAL").toUpperCase();
  const hostState = STATES.has(raw) ? raw : "PROTECTING";
  const memTotal = Math.max(0, Math.trunc(Number(input.mem_total_bytes) || 0));
  const memAvailable = Math.min(memTotal, Math.max(0, Math.trunc(Number(input.mem_available_bytes) || 0)));

  await q(
    `INSERT INTO hosts
       (host_id, name, os, arch, host_state, cpu_total, mem_total_bytes, mem_available_bytes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,app_now())
     ON CONFLICT (host_id) DO UPDATE SET
       name = EXCLUDED.name,
       os = EXCLUDED.os,
       arch = EXCLUDED.arch,
       host_state = EXCLUDED.host_state,
       cpu_total = EXCLUDED.cpu_total,
       mem_total_bytes = EXCLUDED.mem_total_bytes,
       mem_available_bytes = EXCLUDED.mem_available_bytes,
       updated_at = app_now()`,
    [
      hostId,
      String(input.name ?? hostId),
      String(input.os ?? "Linux"),
      String(input.arch ?? "-"),
      hostState,
      Math.max(1, Math.trunc(Number(input.cpu_total) || 4)),
      memTotal,
      memAvailable,
    ],
  );
  return { host_id: hostId, host_state: hostState };
}
