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

export interface RuntimeHostConfig {
  pcs_url: string;
  enrollment_token?: string;
  /** P6：校验 PCS 服务端证书的内部 CA */
  pcs_ca_file?: string;
  /** P6 mTLS：本机主机证书与私钥；两者必须同时配置 */
  pcs_client_cert_file?: string;
  pcs_client_key_file?: string;
  identity_dir: string;
  state_dir: string;
  command_public_key_file?: string;
  jwt_public_key_file?: string;
  /** 允许拉取的镜像仓库前缀；空数组 = 全部拒绝 */
  image_allowlist: string[];
  /** 网络策略名 → Docker 网络；host 不在白名单里 */
  network_policies: Record<string, string>;
  docker_socket: string;
  /**
   * 主机本地凭据文件（KEY=VALUE，权限 600）。部署命令只下发变量名，
   * 值在这里读取后注入容器，因此模型密钥不进入控制面、命令与日志。
   */
  agent_env_file: string;
  /**
   * 主机本地运行环境缓存：Node、Agent CLI、deb 包。部署时以只读 bind mount
   * 挂进容器（/opt/platform/cache），镜像里不再烘焙这些内容。
   */
  cache_dir: string;
  /**
   * 容器默认登录公钥的来源：主机自己的 authorized_keys，以及存放 *.pub 的目录。
   * 容器里 sshd 只允许密钥登录，部署时把这些公钥写进 root 的 authorized_keys，
   * 于是能登录主机的人就能 root 进容器，不需要密码。
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
    throw new Error("pcs_client_cert_file 与 pcs_client_key_file 必须同时配置");
  }
  for (const f of [cfg.pcs_ca_file, cfg.pcs_client_cert_file, cfg.pcs_client_key_file]) {
    if (f && !fs.existsSync(path.resolve(f))) throw new Error(`找不到 TLS 文件：${f}`);
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
