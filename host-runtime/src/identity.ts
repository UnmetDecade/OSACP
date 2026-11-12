import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export interface HostIdentity {
  host_id: string;
  host_token: string;
  expires_at: string;
  pcs_url: string;
  enrolled_at: string;
}

function identityFile(dir: string): string {
  return path.join(dir, "host.json");
}

export function loadIdentity(dir: string): HostIdentity | null {
  try {
    const raw = JSON.parse(fs.readFileSync(identityFile(dir), "utf8")) as HostIdentity;
    if (!raw.host_id || !raw.host_token) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveIdentity(dir: string, identity: HostIdentity): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = identityFile(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Whether the token is still usable: keep a one-hour margin for renewal. */
export function tokenUsable(identity: HostIdentity, marginSeconds = 3600): boolean {
  return Date.parse(identity.expires_at) - marginSeconds * 1000 > Date.now();
}

/** Machine fingerprint: prefer machine-id so it does not change in containers or across reboots. */
export function machineFingerprint(): string {
  let machineId = "";
  try {
    machineId = fs.readFileSync("/etc/machine-id", "utf8").trim();
  } catch {
    // Absent on macOS / in containers
  }
  const seed = `${machineId || os.hostname()}|${os.arch()}|${os.hostname()}`;
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

export function hostInfo(): {
  hostname: string;
  os: string;
  arch: string;
  fingerprint: string;
} {
  return {
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    fingerprint: machineFingerprint(),
  };
}
