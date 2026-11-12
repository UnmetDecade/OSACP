import fs from "node:fs";
import path from "node:path";

export interface InstanceConfig {
  instance_id: string;
  role_id: string;
  host_id: string;
  agent_profile_id: string;
  /** Actual loaded Agent Profile version; if empty, register with the version in the Profile file */
  agent_profile_version?: string;
  /** API Profiles bound to this instance; the APIs in the task envelope must be a subset of these */
  api_profile_ids?: string[];
  /** API Adapter listen port; defaults to 8090, independent per instance inside the container. 0 means random */
  api_adapter_port?: number;
  task_types: string[];
  capabilities: { healthy: string[]; unhealthy?: string[] };
  /**
   * Work capability score W (0–1000) and its six-item detail. Computed by PCS when the builder is created and injected into the container environment,
   * then reported verbatim to the scheduler at registration; absent means 0, which the scheduler treats as "no difficulty limit".
   */
  capability_score?: number;
  capability_detail?: {
    cores?: number;
    freq_ghz?: number;
    mem_gb?: number;
    disk_gb?: number;
    model?: number;
    api?: number;
  };
  /** How many tasks this instance runs concurrently; defaults to 1, aligned with the scheduler's instance_limit */
  slots?: number;
  /** Memory reserved per slot by local second-stage admission; defaults to 1GiB */
  slot_memory_bytes?: number;
  enabled?: boolean;
}

export interface RuntimeConfig {
  scheduler_url: string;
  /** P6: internal CA used to verify the scheduler's server certificate */
  scheduler_ca_file?: string;
  /** P6 mTLS: instance client certificate and key; both must be configured together */
  scheduler_client_cert_file?: string;
  scheduler_client_key_file?: string;
  heartbeat_seconds: number;
  claim_interval_seconds: number;
  lease_renew_seconds: number;
  progress_seconds: number;
  /** Config sync interval; the scheduler returns 304 when the version is unchanged, so there is no extra overhead */
  config_sync_seconds: number;
  request_timeout_ms: number;
  /** Directory holding instance JWTs: <dir>/<instance_id>.jwt. Token files mounted by PCS. */
  token_dir?: string;
  /** Host Runtime's local admission unix socket; when set, recheck before start-ack (§8.4) */
  host_admission_socket?: string;
  /** Workspace root for role executors; one subdirectory per attempt, defaults to data/workspace */
  workspace_dir?: string;
  /** Debug use: keep attempt workspaces (by default they are deleted when the task ends) */
  keep_workspace?: boolean;
  /** Agent/API Profile file exported by PCS; if not configured, only the deterministic role executors are used */
  profiles_file?: string;
  /** Secret Store URL; only the API Adapter accesses it */
  secret_store_url?: string;
  /** Egress policy name -> allowed hosts (exact or *.suffix); policies not listed are denied by default */
  egress_policies?: Record<string, string[]>;
  /** Local development only: allow the API Adapter to reach loopback addresses */
  allow_loopback_egress?: boolean;
  /** Tool/API audit JSONL directory; contains no request bodies or secrets */
  audit_dir?: string;
  instances: InstanceConfig[];
}

const DEFAULTS = {
  scheduler_url: "http://127.0.0.1:7801",
  heartbeat_seconds: 10,
  claim_interval_seconds: 2,
  lease_renew_seconds: 60,
  progress_seconds: 3,
  config_sync_seconds: 30,
  request_timeout_ms: 5000,
  workspace_dir: "data/workspace",
  keep_workspace: false,
  audit_dir: "data/audit",
};

/**
 * The container entrypoint injects CAPABILITY_SCORE / CAPABILITY_DETAIL into the environment.
 * This is a one-time fallback: only override the detail already specified in config when the environment actually carries a value.
 * If all values are invalid, return undefined so the registration request keeps the old format.
 */
function applyCapabilityEnv(instances: InstanceConfig[]): InstanceConfig[] {
  const rawScore = process.env.CAPABILITY_SCORE;
  const rawDetail = process.env.CAPABILITY_DETAIL;
  if (!rawScore && !rawDetail) return instances;
  const score = rawScore !== undefined ? Number(rawScore) : undefined;
  let detail: InstanceConfig["capability_detail"];
  if (rawDetail) {
    try {
      const parsed = JSON.parse(rawDetail);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed;
    } catch {
      // A bad detail does not block registration: the score alone is enough.
    }
  }
  return instances.map((i) => ({
    ...i,
    capability_score:
      i.capability_score ??
      (Number.isFinite(score) ? Math.max(0, Math.min(1000, Math.round(score as number))) : undefined),
    capability_detail: i.capability_detail ?? detail,
  }));
}

/** Positive-integer-seconds env override; invalid values are treated as unset so a unit typo does not turn polling off. */
function secondsEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function loadConfig(configPath?: string): RuntimeConfig {
  const file = configPath ?? process.env.RUNTIME_CONFIG ?? "runtime.config.json";
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new Error(`找不到配置文件：${abs}（可从 runtime.config.example.json 复制）`);
  }
  const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as Partial<RuntimeConfig>;
  const cfg = {
    ...DEFAULTS,
    ...raw,
    // Perceived console latency comes mainly from "task enqueued → instance claims it". The default 2 seconds is a DB-saving
    // conservative value; small deployments (a few builders) can drop it to 0.5 seconds to trade for interactive latency.
    claim_interval_seconds:
      secondsEnv("CLAIM_INTERVAL_SECONDS") ??
      raw.claim_interval_seconds ??
      DEFAULTS.claim_interval_seconds,
    progress_seconds:
      secondsEnv("PROGRESS_SECONDS") ?? raw.progress_seconds ?? DEFAULTS.progress_seconds,
    scheduler_url: process.env.SCHEDULER_URL ?? raw.scheduler_url ?? DEFAULTS.scheduler_url,
    scheduler_ca_file: process.env.SCHEDULER_CA_FILE ?? raw.scheduler_ca_file,
    scheduler_client_cert_file:
      process.env.SCHEDULER_CLIENT_CERT_FILE ?? raw.scheduler_client_cert_file,
    scheduler_client_key_file:
      process.env.SCHEDULER_CLIENT_KEY_FILE ?? raw.scheduler_client_key_file,
    host_admission_socket:
      process.env.HOST_ADMISSION_SOCKET ?? raw.host_admission_socket,
    instances: applyCapabilityEnv(raw.instances ?? []),
  } as RuntimeConfig;
  if (Boolean(cfg.scheduler_client_cert_file) !== Boolean(cfg.scheduler_client_key_file)) {
    throw new Error("scheduler_client_cert_file 与 scheduler_client_key_file 必须同时配置");
  }
  for (const f of [cfg.scheduler_ca_file, cfg.scheduler_client_cert_file, cfg.scheduler_client_key_file]) {
    if (f && !fs.existsSync(f)) throw new Error(`找不到 TLS 文件：${f}`);
  }
  return cfg;
}

/** --instance builder-ubuntu22-a picks just one; without it, all are started */
export function selectInstances(cfg: RuntimeConfig, argv: string[]): InstanceConfig[] {
  const idx = argv.indexOf("--instance");
  const wanted = idx >= 0 ? argv[idx + 1] : undefined;
  const list = cfg.instances.filter((i) => i.enabled !== false);
  if (!wanted) return list;
  const one = list.filter((i) => i.instance_id === wanted);
  if (!one.length) throw new Error(`配置里没有实例 ${wanted}`);
  return one;
}
