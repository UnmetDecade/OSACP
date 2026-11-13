import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WatchdogThresholds {
  mem_available_ratio_below?: number;
  load1_per_cpu_above?: number;
  disk_free_ratio_below?: number;
}

export interface WatchdogConfig {
  sample_seconds: number;
  warning: WatchdogThresholds;
  throttled: WatchdogThresholds;
  protecting: WatchdogThresholds;
  sustain_seconds: { warning: number; throttled: number; protecting: number };
  recover_seconds: number;
  recovering_seconds: number;
  pcs_lost_seconds: number;
}

export interface AdmissionConfig {
  host_reserve_bytes: number;
  system_reserve_bytes: number;
  safety_margin_bytes: number;
  max_task_grant_bytes: number;
  grant_ttl_seconds: number;
}

export interface ResourcePoolRuntimeConfig {
  /** Enabled by default; the manager still degrades to "unavailable" when cgroup v2 is missing. */
  enabled: boolean;
  base_path: string;
  pool_id: string;
  platform_memory_min_bytes: number;
  /** 0 = host total memory. */
  pool_memory_max_bytes: number;
  cpu_period_us: number;
}

export interface RuntimeHostConfig {
  pcs_url: string;
  /** Dynamic scheduling pool; disabled leaves static-mode containers untouched. */
  resource_pool: ResourcePoolRuntimeConfig;
  /** How often to pull per-instance grants from the scheduler (seconds). */
  grant_poll_seconds: number;
  enrollment_token?: string;
  /** P6: internal CA used to verify the PCS server certificate */
  pcs_ca_file?: string;
  /** P6 mTLS: this host's certificate and key; both must be configured together */
  pcs_client_cert_file?: string;
  pcs_client_key_file?: string;
  identity_dir: string;
  state_dir: string;
  command_public_key_file?: string;
  jwt_public_key_file?: string;
  /** Allowed image registry prefixes; an empty array = deny all */
  image_allowlist: string[];
  /** Network policy name → Docker network; host is not in the allowlist */
  network_policies: Record<string, string>;
  docker_socket: string;
  /**
   * Host-local credentials file (KEY=VALUE, mode 600). Deployment commands send only variable names;
   * values are read here and injected into the container, so model keys never enter the control plane, commands, or logs.
   */
  agent_env_file: string;
  /**
   * Host-local runtime cache: Node, Agent CLI, deb packages. Mounted into the container as a read-only bind mount
   * at deploy time (/opt/platform/cache), so images no longer bake these in.
   */
  cache_dir: string;
  /**
   * Sources of default login public keys for containers: the host's own authorized_keys, and the directory holding *.pub files.
   * Inside the container sshd only allows key login; at deploy time these public keys are written into root's authorized_keys,
   * so anyone who can log in to the host can root into the container without a password.
   */
  ssh_authorized_keys_file?: string;
  ssh_pubkey_dir?: string;
  admission_socket: string;
  admission: AdmissionConfig;
  heartbeat_seconds: number;
  report_seconds: number;
  command_wait_seconds: number;
  command_concurrency: number;
  container_stop_timeout_seconds: number;
  docker_timeout_ms: number;
  remove_volumes_on_remove: boolean;
  watchdog: WatchdogConfig;
}

const DEFAULTS: RuntimeHostConfig = {
  pcs_url: "http://127.0.0.1:7901",
  resource_pool: {
    enabled: true,
    base_path: "/sys/fs/cgroup",
    pool_id: "osacp.slice/pool.slice",
    platform_memory_min_bytes: 512 * 1024 ** 2,
    pool_memory_max_bytes: 0,
    cpu_period_us: 100_000,
  },
  grant_poll_seconds: 5,
  identity_dir: "run/identity",
  state_dir: "run/state",
  image_allowlist: [],
  network_policies: { default: "bridge" },
  docker_socket: "/var/run/docker.sock",
  agent_env_file: path.join(os.homedir(), ".config", "platform", "agent-env"),
  cache_dir: path.join(os.homedir(), ".platform", "cache"),
  ssh_authorized_keys_file: path.join(os.homedir(), ".ssh", "authorized_keys"),
  ssh_pubkey_dir: path.join(os.homedir(), ".platform", "keys"),
  admission_socket: "run/runtime.sock",
  admission: {
    host_reserve_bytes: 512 * 1024 ** 2,
    system_reserve_bytes: 1024 ** 3,
    safety_margin_bytes: 512 * 1024 ** 2,
    max_task_grant_bytes: 4 * 1024 ** 3,
    grant_ttl_seconds: 3600,
  },
  heartbeat_seconds: 15,
  report_seconds: 15,
  command_wait_seconds: 30,
  command_concurrency: 1,
  container_stop_timeout_seconds: 30,
  docker_timeout_ms: 60_000,
  remove_volumes_on_remove: false,
  watchdog: {
    sample_seconds: 5,
    warning: { mem_available_ratio_below: 0.2, load1_per_cpu_above: 1.5, disk_free_ratio_below: 0.15 },
    throttled: { mem_available_ratio_below: 0.12, load1_per_cpu_above: 2.5, disk_free_ratio_below: 0.08 },
    protecting: { mem_available_ratio_below: 0.05, load1_per_cpu_above: 4, disk_free_ratio_below: 0.03 },
    sustain_seconds: { warning: 60, throttled: 120, protecting: 5 },
    recover_seconds: 300,
    recovering_seconds: 60,
    pcs_lost_seconds: 60,
  },
};

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) ? deepMerge(b, v) : v;
  }
  return out as T;
}

export function loadRuntimeHostConfig(configPath?: string): RuntimeHostConfig {
  const file = configPath ?? process.env.RUNTIME_HOST_CONFIG ?? "runtime.host.json";
  const abs = path.resolve(file);
  const raw = fs.existsSync(abs)
    ? (JSON.parse(fs.readFileSync(abs, "utf8")) as Partial<RuntimeHostConfig>)
    : {};
  const cfg = deepMerge(DEFAULTS, raw);

  cfg.pcs_url = process.env.PCS_URL ?? cfg.pcs_url;
  cfg.enrollment_token = process.env.PCS_ENROLLMENT_TOKEN ?? cfg.enrollment_token;
  cfg.identity_dir = process.env.RUNTIME_IDENTITY_DIR ?? cfg.identity_dir;
  cfg.state_dir = process.env.RUNTIME_STATE_DIR ?? cfg.state_dir;
  cfg.command_public_key_file =
    process.env.PCS_COMMAND_PUBLIC_KEY_FILE ?? cfg.command_public_key_file;
  cfg.jwt_public_key_file = process.env.PCS_JWT_PUBLIC_KEY_FILE ?? cfg.jwt_public_key_file;
  cfg.pcs_ca_file = process.env.PCS_CA_FILE ?? cfg.pcs_ca_file;
  cfg.pcs_client_cert_file = process.env.PCS_CLIENT_CERT_FILE ?? cfg.pcs_client_cert_file;
  cfg.pcs_client_key_file = process.env.PCS_CLIENT_KEY_FILE ?? cfg.pcs_client_key_file;
  if (Boolean(cfg.pcs_client_cert_file) !== Boolean(cfg.pcs_client_key_file)) {
    throw new Error("pcs_client_cert_file and pcs_client_key_file must be configured together");
  }
  for (const f of [cfg.pcs_ca_file, cfg.pcs_client_cert_file, cfg.pcs_client_key_file]) {
    if (f && !fs.existsSync(path.resolve(f))) throw new Error(`TLS file not found: ${f}`);
  }
  cfg.docker_socket = process.env.DOCKER_SOCKET ?? cfg.docker_socket;
  cfg.agent_env_file = process.env.PLATFORM_AGENT_ENV_FILE ?? cfg.agent_env_file;
  cfg.cache_dir = process.env.PLATFORM_CACHE_DIR ?? cfg.cache_dir;
  cfg.ssh_authorized_keys_file =
    process.env.PLATFORM_SSH_AUTHORIZED_KEYS_FILE ?? cfg.ssh_authorized_keys_file;
  cfg.ssh_pubkey_dir = process.env.PLATFORM_SSH_PUBKEY_DIR ?? cfg.ssh_pubkey_dir;
  cfg.admission_socket = process.env.ADMISSION_SOCKET ?? cfg.admission_socket;
  if (process.env.RUNTIME_IMAGE_ALLOWLIST) {
    cfg.image_allowlist = process.env.RUNTIME_IMAGE_ALLOWLIST.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  cfg.identity_dir = path.resolve(cfg.identity_dir);
  cfg.state_dir = path.resolve(cfg.state_dir);
  cfg.cache_dir = path.resolve(cfg.cache_dir);
  cfg.admission_socket = path.resolve(cfg.admission_socket);
  if (cfg.pcs_ca_file) cfg.pcs_ca_file = path.resolve(cfg.pcs_ca_file);
  if (cfg.pcs_client_cert_file) cfg.pcs_client_cert_file = path.resolve(cfg.pcs_client_cert_file);
  if (cfg.pcs_client_key_file) cfg.pcs_client_key_file = path.resolve(cfg.pcs_client_key_file);
  return cfg;
}

export function readPem(file: string | undefined): string | undefined {
  return file ? fs.readFileSync(file, "utf8") : undefined;
}
