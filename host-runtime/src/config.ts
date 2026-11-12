import fs from "node:fs";
import path from "node:path";

export interface InstanceConfig {
  instance_id: string;
  role_id: string;
  host_id: string;
  agent_profile_id: string;
  /** Agent Profile 实际加载版本；不填时以 Profile 文件里的 version 注册 */
  agent_profile_version?: string;
  /** 本实例绑定的 API Profile；任务信封里的 API 必须是它的子集 */
  api_profile_ids?: string[];
  /** API Adapter 监听端口；默认 8090，容器内每实例独立。0 表示随机 */
  api_adapter_port?: number;
  task_types: string[];
  capabilities: { healthy: string[]; unhealthy?: string[] };
  /**
   * 工作能力值 W（0–1000）与六项明细。由 PCS 创建构建机时算好并注入容器环境，
   * 注册时原样上报给调度机；没有就是 0，调度机按“不限制难度”处理。
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
  /** 该实例同时跑几个任务；默认 1，与调度机 instance_limit 对齐 */
  slots?: number;
  /** 本机二次准入为每个槽位预留的内存；默认 1GiB */
  slot_memory_bytes?: number;
  enabled?: boolean;
}

export interface RuntimeConfig {
  scheduler_url: string;
  /** P6：校验调度机服务端证书的内部 CA */
  scheduler_ca_file?: string;
  /** P6 mTLS：实例客户端证书与私钥；两者必须同时配置 */
  scheduler_client_cert_file?: string;
  scheduler_client_key_file?: string;
  heartbeat_seconds: number;
  claim_interval_seconds: number;
  lease_renew_seconds: number;
  progress_seconds: number;
  /** 配置同步周期；调度机版本未变时回 304，不产生额外开销 */
  config_sync_seconds: number;
  request_timeout_ms: number;
  /** 实例 JWT 所在目录：<dir>/<instance_id>.jwt。PCS 挂载的令牌文件。 */
  token_dir?: string;
  /** Host Runtime 的本机准入 unix socket；设置后 start-ack 前必须复检（§8.4） */
  host_admission_socket?: string;
  /** 角色执行器的工作目录根；每个 attempt 一个子目录，默认 data/workspace */
  workspace_dir?: string;
  /** 调试用：保留 attempt 工作目录（默认任务结束即删除） */
  keep_workspace?: boolean;
  /** PCS 导出的 Agent/API Profile 文件；不配置则只用确定性角色执行器 */
  profiles_file?: string;
  /** Secret Store 地址；只有 API Adapter 会访问 */
  secret_store_url?: string;
  /** egress 策略名 -> 允许的 host（精确或 *.suffix）；未列出的策略默认拒绝 */
  egress_policies?: Record<string, string[]>;
  /** 仅本地开发：允许 API Adapter 访问回环地址 */
  allow_loopback_egress?: boolean;
  /** 工具/API 审计 JSONL 目录；不含请求体与密钥 */
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
 * 容器入口会把 CAPABILITY_SCORE / CAPABILITY_DETAIL 注入环境。
 * 这里兜底一次：只有环境里确实带值时，才覆盖配置里已经写明的明细。
 * 数值全部非法时返回 undefined，让注册请求保持旧格式。
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
      // 明细坏了不影响注册：用分值即可。
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

/** 正整数秒的环境变量覆盖；非法值当作未设置，不因为写错单位而把轮询关掉。 */
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
    // 控制台的体感延迟主要来自“任务入队 → 实例来领”。默认 2 秒是省数据库的
    // 保守值；小规模平台（几台构建机）可以调到 0.5 秒换取交互时延。
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

/** --instance builder-ubuntu22-a 只挑一个；不给就全起 */
export function selectInstances(cfg: RuntimeConfig, argv: string[]): InstanceConfig[] {
  const idx = argv.indexOf("--instance");
  const wanted = idx >= 0 ? argv[idx + 1] : undefined;
  const list = cfg.instances.filter((i) => i.enabled !== false);
  if (!wanted) return list;
  const one = list.filter((i) => i.instance_id === wanted);
  if (!one.length) throw new Error(`配置里没有实例 ${wanted}`);
  return one;
}
