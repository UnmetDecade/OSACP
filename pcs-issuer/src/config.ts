import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface PcsConfig {
  host: string;
  port: number;
  databaseUrl: string;
  jwtPrivateKeyFile: string;
  jwtPublicKeyFile: string;
  commandPrivateKeyFile: string;
  commandPublicKeyFile: string;
  /** SSH 私钥静态加密密钥（32 字节）；未配置时只能接入本地主机 */
  credentialKeyFile: string | null;
  /** 仓库前缀白名单，例如 ["docker.m.daocloud.io/library/"] */
  imageAllowlist: string[];
  /** 允许的网络策略名；Host Runtime 侧映射到具体 Docker 网络 */
  networkPolicies: string[];
  /** 策略名 → Docker 网络名，引导 host-runtime 时写入；未列出的按默认规则。 */
  networkPolicyMap: Record<string, string>;
  /** 仅本地开发：允许 API Profile 指向 http://127.0.0.1（生产必须 https） */
  allowInsecureApiUrls: boolean;
  enrollmentTtlSeconds: number;
  hostTokenHours: number;
  commandTtlSeconds: number;
  commandMaxAttempts: number;
  commandRedeliverSeconds: number;
  hostOfflineSeconds: number;
  tickMs: number;
  /** 审批令牌签发的 MFA 断言（参考实现的开发替身）；未配置时签发接口 fail closed */
  approvalMfaCode: string | null;
  /** 管理应用来源白名单；为空时不发送 CORS 头 */
  adminOrigins: string[];
  /** P6：直连 TLS。证书与私钥必须同时配置；未配置时保持 HTTP（仅本地开发）。 */
  tlsCertFile: string | null;
  tlsKeyFile: string | null;
  /** 客户端 CA；配置后要求并校验客户端证书（mTLS） */
  tlsCaFile: string | null;
  requireClientCert: boolean;
  /** 服务端公开地址（反向代理后面时用于 install_hint）；不填则按请求推断 */
  publicUrl: string | null;
  /** host-runtime 访问 PCS 的地址；远程主机必须填它能直连的局域网/公网地址 */
  runtimeUrl: string | null;
  /** 远程主机上的 node 可执行文件（需要 Node 22+）；默认 node */
  runtimeNode: string;
  /**
   * 主机本地模型凭据文件（KEY=VALUE）。引导主机时原样同步到
   * $HOME/.config/platform/agent-env（600），部署只需下发变量名。
   */
  agentEnvFile: string | null;
  /** 调度机容器的默认镜像（digest 固定）；裸 ubuntu 镜像即可，运行时由主机缓存提供 */
  schedulerImage: string | null;
  /**
   * 调度机部署载荷目录（main.mjs / migrate.mjs / sql / entrypoint.sh …）。
   * 由 scripts/build-app-payload.mjs 生成，随部署以 files 下发，镜像里不烘焙应用。
   */
  schedulerAppDir: string;
  /**
   * 构建机镜像：builder_os → 官方 ubuntu 镜像（digest 固定）。
   * 配置了哪个系统，就用官方镜像 + 部署载荷，不再构建 platform/builder 镜像。
   */
  builderImages: Record<string, string>;
  /** 构建机部署载荷目录（agent-runtime.mjs / entrypoint.sh / sshd_config …） */
  builderAppDir: string;
  /** 调度机容器使用的数据库地址；调度机部署计划由控制面注入，不经过界面 */
  schedulerDatabaseUrl: string | null;
  /** 按主机覆盖调度机数据库地址（每台主机一个调度机、各自一套库）。 */
  schedulerDatabaseUrls: Record<string, string>;
  /** 按主机覆盖该主机上构建机注册到哪个调度机。 */
  schedulerUrls: Record<string, string>;
  /** 构建机容器访问调度机 API 的地址（同一容器网络内的服务名或可达地址） */
  schedulerUrl: string | null;
  /** PCS 自己访问调度机的地址（主机视角，通常是 127.0.0.1:端口）；未配置时用 schedulerUrl */
  schedulerSyncUrl: string | null;
  /**
   * 结点调度机向上级上报时共用的令牌。未配置时由控制面从命令签名私钥派生，
   * 同一套部署重启后保持不变；值只注入调度机容器，不回显。
   */
  federationToken: string | null;
  /** 控制台写入 API 密钥的 Secret Store 地址；未配置时界面只能填 secret:// 引用 */
  secretStoreUrl: string | null;
  /** Secret Store 管理令牌（只用于写入，不返回给浏览器） */
  secretStoreAdminToken: string | null;
}

/** `ubuntu24.04=镜像,ubuntu22.04=镜像` → { "ubuntu24.04": "镜像", … } */
function parseHostValueMap(raw: string | undefined, envName: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) throw new Error(`${envName} 每项必须是 host_id=值：${item}`);
    const hostId = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (!hostId || !value) throw new Error(`${envName} 每项必须是 host_id=值：${item}`);
    out[hostId] = value;
  }
  return out;
}

function parseImageMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) throw new Error(`PCS_BUILDER_IMAGES 每项必须是 os=镜像：${item}`);
    const os = item.slice(0, eq).trim();
    const image = item.slice(eq + 1).trim();
    if (!os || !image) throw new Error(`PCS_BUILDER_IMAGES 每项必须是 os=镜像：${item}`);
    out[os] = image;
  }
  return out;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} 必须是正数：${raw}`);
  return n;
}

export function loadConfig(overrides: Partial<PcsConfig> = {}): PcsConfig {
  const allow = (process.env.PCS_IMAGE_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cfg: PcsConfig = {
    host: process.env.PCS_HOST ?? "127.0.0.1",
    port: intEnv("PCS_PORT", 7901),
    databaseUrl:
      process.env.PCS_DATABASE_URL ??
      "postgres://postgres:sched_dev_pw@127.0.0.1:5432/platform_control",
    jwtPrivateKeyFile:
      process.env.PCS_JWT_PRIVATE_KEY_FILE ?? path.join(root, "keys", "private.pem"),
    jwtPublicKeyFile:
      process.env.PCS_JWT_PUBLIC_KEY_FILE ?? path.join(root, "keys", "public.pem"),
    commandPrivateKeyFile:
      process.env.PCS_COMMAND_PRIVATE_KEY_FILE ?? path.join(root, "keys", "command-private.pem"),
    commandPublicKeyFile:
      process.env.PCS_COMMAND_PUBLIC_KEY_FILE ?? path.join(root, "keys", "command-public.pem"),
    credentialKeyFile: (process.env.PCS_CREDENTIAL_KEY_FILE ?? "").trim() || null,
    imageAllowlist: allow,
    networkPolicyMap: (() => {
      const raw = (process.env.PCS_NETWORK_POLICY_MAP ?? "").trim();
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`PCS_NETWORK_POLICY_MAP 必须是 JSON 对象：${raw}`);
      }
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    })(),
    networkPolicies: (process.env.PCS_NETWORK_POLICIES ?? "default")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowInsecureApiUrls: process.env.PCS_ALLOW_INSECURE_API_URLS === "1",
    enrollmentTtlSeconds: intEnv("PCS_ENROLLMENT_TTL_SECONDS", 600),
    hostTokenHours: intEnv("PCS_HOST_TOKEN_HOURS", 24),
    commandTtlSeconds: intEnv("PCS_COMMAND_TTL_SECONDS", 600),
    commandMaxAttempts: intEnv("PCS_COMMAND_MAX_ATTEMPTS", 3),
    commandRedeliverSeconds: intEnv("PCS_COMMAND_REDELIVER_SECONDS", 30),
    hostOfflineSeconds: intEnv("PCS_HOST_OFFLINE_SECONDS", 90),
    tickMs: intEnv("PCS_TICK_MS", 15000),
    approvalMfaCode: (process.env.PCS_APPROVAL_MFA_CODE ?? "").trim() || null,
    adminOrigins: (process.env.PCS_ADMIN_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    tlsCertFile: (process.env.PCS_TLS_CERT_FILE ?? "").trim() || null,
    tlsKeyFile: (process.env.PCS_TLS_KEY_FILE ?? "").trim() || null,
    tlsCaFile: (process.env.PCS_TLS_CA_FILE ?? "").trim() || null,
    requireClientCert: process.env.PCS_MTLS === "1",
    publicUrl: (process.env.PCS_PUBLIC_URL ?? "").trim() || null,
    runtimeUrl: (process.env.PCS_RUNTIME_URL ?? "").trim() || null,
    runtimeNode: (process.env.PCS_RUNTIME_NODE ?? "node").trim() || "node",
    agentEnvFile:
      (process.env.PCS_AGENT_ENV_FILE ?? path.join(os.homedir(), ".config", "platform", "agent-env")).trim() ||
      null,
    schedulerImage: (process.env.PCS_SCHEDULER_IMAGE ?? "").trim() || null,
    schedulerAppDir: path.resolve(
      (process.env.PCS_SCHEDULER_APP_DIR ?? "").trim() || path.join(root, "app", "scheduler"),
    ),
    builderImages: parseImageMap(process.env.PCS_BUILDER_IMAGES),
    builderAppDir: path.resolve(
      (process.env.PCS_BUILDER_APP_DIR ?? "").trim() || path.join(root, "app", "builder"),
    ),
    schedulerDatabaseUrl:
      (process.env.PCS_SCHEDULER_DATABASE_URL ?? "").trim() || null,
    schedulerDatabaseUrls: parseHostValueMap(
      process.env.PCS_SCHEDULER_DATABASE_URLS,
      "PCS_SCHEDULER_DATABASE_URLS",
    ),
    schedulerUrls: parseHostValueMap(process.env.PCS_SCHEDULER_URLS, "PCS_SCHEDULER_URLS"),
    federationToken: (process.env.PCS_FEDERATION_TOKEN ?? "").trim() || null,
    schedulerUrl: (process.env.PCS_SCHEDULER_URL ?? "").trim() || null,
    schedulerSyncUrl: (process.env.PCS_SCHEDULER_SYNC_URL ?? "").trim() || null,
    secretStoreUrl: (process.env.PCS_SECRET_STORE_URL ?? "").trim() || null,
    secretStoreAdminToken: (process.env.PCS_SECRET_STORE_ADMIN_TOKEN ?? "").trim() || null,
    ...overrides,
  };
  if (Boolean(cfg.tlsCertFile) !== Boolean(cfg.tlsKeyFile)) {
    throw new Error("PCS_TLS_CERT_FILE 与 PCS_TLS_KEY_FILE 必须同时配置");
  }
  if (cfg.tlsCertFile && !fs.existsSync(cfg.tlsCertFile)) {
    throw new Error(`找不到 TLS 证书 ${cfg.tlsCertFile}`);
  }
  if (cfg.tlsKeyFile && !fs.existsSync(cfg.tlsKeyFile)) {
    throw new Error(`找不到 TLS 私钥 ${cfg.tlsKeyFile}`);
  }
  if (cfg.requireClientCert && (!cfg.tlsCertFile || !cfg.tlsCaFile)) {
    throw new Error("PCS_MTLS=1 需要同时配置 TLS 证书与客户端 CA（PCS_TLS_CA_FILE）");
  }
  if (cfg.tlsCaFile && !fs.existsSync(cfg.tlsCaFile)) {
    throw new Error(`找不到客户端 CA ${cfg.tlsCaFile}`);
  }
  if (!fs.existsSync(cfg.jwtPrivateKeyFile)) {
    throw new Error(`找不到 JWT 私钥 ${cfg.jwtPrivateKeyFile}，先执行 npm run keygen`);
  }
  if (!fs.existsSync(cfg.commandPrivateKeyFile)) {
    throw new Error(`找不到命令私钥 ${cfg.commandPrivateKeyFile}，先执行 npm run keygen`);
  }
  if (cfg.credentialKeyFile && !fs.existsSync(cfg.credentialKeyFile)) {
    throw new Error(`找不到 SSH 凭据密钥 ${cfg.credentialKeyFile}`);
  }
  return cfg;
}

export function readKey(file: string): string {
  return fs.readFileSync(file, "utf8");
}
