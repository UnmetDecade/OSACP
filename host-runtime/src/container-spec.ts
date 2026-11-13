import fs from "node:fs";
import path from "node:path";
import type { InstanceSpec } from "./command-verify.js";
import type { RuntimeHostConfig } from "./runtime-config.js";

/** Fixed mount point for the host cache inside the container. */
export const CACHE_MOUNT = "/opt/platform/cache";

export interface ContainerSpecInput {
  deployment_id: string;
  grant_id: string;
  host_id: string;
  instance: InstanceSpec;
  /** cgroup v2 path under the host pool; omitted keeps Docker's default cgroup placement. */
  cgroup_parent?: string;
}

export function containerName(instanceId: string): string {
  return `platform-${instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48)}`;
}

export function volumeName(instanceId: string, name: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "-");
  // The shared- prefix means shared by all instances on the same host (e.g. apt's deb cache):
  // the volume name carries no instance prefix, so builders reuse downloaded packages without sharing their own environments.
  if (name.startsWith("shared-")) return `platform-${safe(name)}`;
  return `platform-${safe(instanceId)}-${safe(name)}`;
}

/**
 * v4 container spec: development containers default to root + writable root + full capabilities, and SSH in is full power.
 * The isolation boundary is no longer privilege reduction inside the container, but:
 *   * the container boundary (not a host process);
 *   * CPU / memory / PID / IO resource limits;
 *   * no Docker Socket, no host paths (named-volume Mounts only);
 *   * network policy (host / container networks are still rejected).
 * This lets the builder apt install and run any toolchain, and SSH can directly change system config.
 */
export function buildContainerConfig(
  input: ContainerSpecInput,
  cfg: RuntimeHostConfig,
  /** Values resolved from the host-local credentials file; for variables of the same name, these take precedence. */
  agentEnv: Record<string, string> = {},
): Record<string, unknown> {
  const spec = input.instance;
  const profile = spec.resource_profile;
  const networkMode = cfg.network_policies[spec.network_policy] ?? "bridge";
  if (networkMode === "host" || networkMode.startsWith("container:")) {
    throw new Error(`Network policy ${spec.network_policy} maps to an unsafe network mode ${networkMode}`);
  }

  const mounts: Array<Record<string, unknown>> = (spec.volumes ?? []).map((v) => ({
    Type: "volume",
    Source: volumeName(spec.instance_id, v.name),
    Target: v.mount,
    ReadOnly: false,
  }));
  // The runtime environment (Node / Agent CLI / deb packages) lives in the host cache and is mounted read-only into the container:
  // images stay pure OS, so upgrading the runtime needs neither an image rebuild nor a re-download on every host.
  if (cfg.cache_dir) {
    mounts.unshift({
      Type: "bind",
      Source: cfg.cache_dir,
      Target: CACHE_MOUNT,
      ReadOnly: true,
      BindOptions: { Propagation: "rprivate" },
    });
  }

  const mergedEnv: Record<string, string> = { ...(spec.env ?? {}), ...agentEnv };
  // The container sshd only allows key login; by default the host's existing login public keys are injected,
  // so anyone who can log in to this host can root directly into the container. If the deployer provides a key explicitly, it is not overridden.
  if (!mergedEnv.SSH_AUTHORIZED_KEY) {
    const keys = hostAuthorizedKeys(cfg);
    if (keys) mergedEnv.SSH_AUTHORIZED_KEY = keys;
  }
  const env = Object.keys(mergedEnv)
    .sort()
    .map((k) => `${k}=${mergedEnv[k]}`);

  const hostConfig: Record<string, unknown> = {
    NanoCpus: Math.round(profile.cpu_limit * 1e9),
    Memory: Math.round(profile.memory_limit_bytes),
    // Forbid unbounded swap: MemorySwap = Memory disables swap
    MemorySwap: Math.round(profile.memory_limit_bytes),
    PidsLimit: Number(profile.pids_limit ?? 512),
    BlkioWeight: Number(profile.io_weight ?? 500),
    ReadonlyRootfs: false,
    Tmpfs: {
      "/tmp": "rw,size=256m",
      "/run": "rw,size=64m",
    },
    CapDrop: [],
    CapAdd: ["ALL"],
    Privileged: false,
    NetworkMode: networkMode,
    RestartPolicy: { Name: "unless-stopped" },
    LogConfig: { Type: "json-file", Config: { "max-size": "50m", "max-file": "5" } },
    Mounts: mounts,
    OomKillDisable: false,
    Init: true,
  };
  if (profile.memory_reservation_bytes) {
    hostConfig.MemoryReservation = Math.round(profile.memory_reservation_bytes);
  }
  // Dynamic builds live under the host pool; grants edit this scope (memory.low/max, cpu.weight),
  // while Docker's NanoCpus/Memory enforce the deployment cap inside it.
  if (input.cgroup_parent) {
    hostConfig.CgroupParent = input.cgroup_parent;
  }

  const ports = spec.ports ?? [];
  const config: Record<string, unknown> = {
    Image: spec.image,
    User: "0:0",
    Env: env,
    Labels: {
      "platform.managed": "true",
      "platform.host_id": input.host_id,
      "platform.deployment_id": input.deployment_id,
      "platform.grant_id": input.grant_id,
      "platform.instance_id": spec.instance_id,
      "platform.role_id": spec.role_id,
    },
    HostConfig: hostConfig,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
  };
  if (ports.length) {
    const bindings: Record<string, Array<{ HostPort: string }>> = {};
    for (const p of ports) bindings[`${p.container}/tcp`] = [{ HostPort: String(p.host) }];
    config.ExposedPorts = Object.fromEntries(ports.map((p) => [`${p.container}/tcp`, {}]));
    hostConfig.PortBindings = bindings;
  }
  if (spec.command?.length) config.Cmd = spec.command;
  return config;
}

/**
 * Collect login public keys on the host (authorized_keys + ~/.platform/keys/*.pub).
 * Only valid public-key lines are accepted: root access inside the container is fully open, so arbitrary text must not be written into
 * authorized_keys. An empty return means the host has no usable public keys yet, and the container can only be entered via the PCS console.
 */
function hostAuthorizedKeys(cfg: RuntimeHostConfig): string {
  const lines: string[] = [];
  const collect = (text: string) => {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-(ssh-ed25519|ecdsa-sha2-nistp256)) /.test(line)) {
        continue;
      }
      lines.push(line);
    }
  };
  const readFile = (file: string) => {
    try {
      collect(fs.readFileSync(file, "utf8"));
    } catch {
      /* File does not exist or is unreadable: skip */
    }
  };
  if (cfg.ssh_authorized_keys_file) readFile(cfg.ssh_authorized_keys_file);
  // host-runtime often runs as root, while the managed user may not be root: include the public keys of all
  // accounts that can log in to this host, so in effect "whoever can SSH into this host can enter the container".
  if (process.getuid?.() === 0) {
    readFile("/root/.ssh/authorized_keys");
    for (const home of safeList("/home")) {
      readFile(path.join("/home", home, ".ssh", "authorized_keys"));
    }
    // Compatible with the public key directory from the compose era.
    for (const dir of ["/opt/platform/keys"]) {
      for (const name of safeList(dir)) {
        if (name.endsWith(".pub")) readFile(path.join(dir, name));
      }
    }
  }
  if (cfg.ssh_pubkey_dir) {
    for (const name of safeList(cfg.ssh_pubkey_dir)) {
      if (name.endsWith(".pub")) readFile(path.join(cfg.ssh_pubkey_dir, name));
    }
  }
  return [...new Set(lines)].join("\n").slice(0, 64 * 1024);
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}
