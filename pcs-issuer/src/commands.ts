import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { PcsError } from "./errors.js";

export type CommandType = "DEPLOY" | "START" | "STOP" | "RESTART" | "REMOVE";

export interface ResourceProfile {
  cpu_limit: number;
  memory_limit_bytes: number;
  memory_reservation_bytes?: number;
  pids_limit?: number;
  io_weight?: number;
}

/** 容器端口 → 宿主端口（仅 TCP）。构建机用 2222 → 2222+ 暴露 SSH。 */
export interface PortMapping {
  container: number;
  host: number;
}

export interface InstanceSpec {
  instance_id: string;
  role_id: string;
  display_name: string | null;
  /**
   * container = Docker 容器；native = 主机运行时直接在宿主机上拉起角色进程。
   * 省略按 container 处理，保持旧命令兼容。
   */
  execution?: "container" | "native";
  /** native 没有镜像；容器角色必填且必须固定 digest。 */
  image: string;
  resource_profile: ResourceProfile;
  env: Record<string, string>;
  volumes: Array<{ name: string; mount: string }>;
  ports?: PortMapping[];
  network_policy: string;
  config_version: number;
  command?: string[];
  /** 启动前写进容器的配置文件（例如 Agent Profile 视图）。 */
  files?: Array<{ path: string; content: string }>;
  /** 由主机从本地凭据文件补齐的变量名；控制面只传名字，不传值。 */
  agent_env?: string[];
}

export interface ResourceGrant {
  grant_id: string;
  kind: "DEPLOYMENT";
  cpu_limit: number;
  memory_limit_bytes: number;
}

export interface CommandPayload {
  command_id: string;
  command_type: CommandType;
  host_id: string;
  deployment_id: string | null;
  instance_id: string | null;
  generation: number;
  issued_at: string;
  expires_at: string;
  resource_grant: ResourceGrant | null;
  instance: InstanceSpec | null;
  signature: string;
}

/** 稳定的 JSON 序列化：对象键排序、无多余空白。验签双方必须逐字节一致。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function unsignedPayload(payload: CommandPayload): Omit<CommandPayload, "signature"> {
  const { signature: _signature, ...rest } = payload;
  return rest;
}

export function signCommand(
  payload: Omit<CommandPayload, "signature">,
  privateKeyPem: string,
): CommandPayload {
  const signature = sign(null, Buffer.from(canonicalJson(payload)), createPrivateKey(privateKeyPem));
  return { ...payload, signature: `ed25519:${signature.toString("base64url")}` };
}

export function verifyCommandSignature(payload: CommandPayload, publicKeyPem: string): boolean {
  if (!payload.signature?.startsWith("ed25519:")) return false;
  const raw = Buffer.from(payload.signature.slice("ed25519:".length), "base64url");
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(unsignedPayload(payload))),
      createPublicKey(publicKeyPem),
      raw,
    );
  } catch {
    return false;
  }
}

/** 镜像必须 digest 固定，且仓库命中白名单。 */
export function assertPinnedImage(image: string, allowlist: string[]): void {
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new PcsError(400, "IMAGE_NOT_PINNED", "镜像必须用 @sha256:<64 位十六进制> 固定 digest");
  }
  const repo = image.replace(/@sha256:[0-9a-f]{64}$/, "");
  const allowed = allowlist.some((prefix) =>
    prefix.endsWith("/") ? repo.startsWith(prefix) : repo === prefix || repo.startsWith(`${prefix}/`),
  );
  if (!allowed) {
    throw new PcsError(400, "IMAGE_NOT_ALLOWED", `镜像仓库不在白名单：${repo}`, {
      allowlist,
    });
  }
}

const SECRET_KEY = /(secret|token|password|passwd|credential|private[_-]?key)/i;

/**
 * 控制面自己注入的凭据变量：值由 PCS 生成，只随签名命令下发，
 * 计划视图里仍会被遮成 ***，调用方不需要也不应该自己填。
 */
const PLATFORM_INJECTED_SECRETS = new Set(["SCHEDULER_FEDERATION_TOKEN"]);

/** 部署意图里不允许出现明文凭据；Secret 只能走 secret_refs（本阶段未实现）。 */
export function assertNoSecretsInEnv(env: Record<string, string>): void {
  const bad = Object.keys(env).filter(
    (k) => SECRET_KEY.test(k) && !PLATFORM_INJECTED_SECRETS.has(k),
  );
  if (bad.length) {
    throw new PcsError(400, "SECRET_IN_ENVELOPE", "部署意图的 env 不能包含凭据类键", { keys: bad });
  }
  for (const [key, value] of Object.entries(env)) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
      throw new PcsError(400, "SECRET_IN_ENVELOPE", `env ${key} 含私钥内容`);
    }
  }
}

/**
 * 部署时写进容器的配置文件和凭据变量名。
 *
 * 文件只允许落在 /opt/platform 下，且不能夹带私钥；agent_env 只有变量名，
 * 值由主机自己的 600 凭据文件补齐，永远不进控制面。
 */
export function validateFilesAndAgentEnv(
  files: Array<{ path: string; content: string }> | undefined,
  agentEnv: string[] | undefined,
  env: Record<string, string>,
): void {
  if (files !== undefined) {
    if (!Array.isArray(files) || files.length > 16) {
      throw new PcsError(400, "INVALID_FILES", "files 必须是最多 16 项的数组");
    }
    for (const f of files) {
      if (
        typeof f?.path !== "string" ||
        !f.path.startsWith("/opt/platform/") ||
        f.path.includes("..") ||
        f.path.length > 200 ||
        typeof f.content !== "string" ||
        Buffer.byteLength(f.content) > 1024 * 1024
      ) {
        throw new PcsError(400, "INVALID_FILES", `文件规格非法：${String(f?.path)}`);
      }
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(f.content)) {
        throw new PcsError(400, "SECRET_IN_ENVELOPE", `文件 ${f.path} 含私钥内容`);
      }
    }
  }
  if (agentEnv !== undefined) {
    if (!Array.isArray(agentEnv) || agentEnv.length > 32) {
      throw new PcsError(400, "INVALID_AGENT_ENV", "agent_env 必须是最多 32 项的数组");
    }
    for (const name of agentEnv) {
      if (
        typeof name !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) ||
        Object.prototype.hasOwnProperty.call(env, name)
      ) {
        throw new PcsError(400, "INVALID_AGENT_ENV", `agent_env 变量名非法：${String(name)}`);
      }
    }
  }
}

/**
 * 预览/回执是给浏览器看的，不能带凭据值：
 * 键名像凭据的、或者值是带账号密码的 URL（例如 DATABASE_URL），一律遮成 ***。
 * 真正的 env 只随签名命令下发到主机运行时。
 */
export function redactEnvForView(env: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    safe[key] = SECRET_KEY.test(key) || /\/\/[^/@\s]+:[^/@\s]+@/.test(value) ? "***" : value;
  }
  return safe;
}

export function normalizeResourceProfile(input: Partial<ResourceProfile>): ResourceProfile {
  const cpu = Number(input.cpu_limit ?? 1);
  const memory = Number(input.memory_limit_bytes ?? 1024 ** 3);
  if (!Number.isFinite(cpu) || cpu <= 0 || cpu > 128) {
    throw new PcsError(400, "INVALID_RESOURCE_PROFILE", "cpu_limit 必须在 (0, 128] 内");
  }
  if (!Number.isFinite(memory) || memory < 64 * 1024 ** 2 || memory > 1024 ** 4) {
    throw new PcsError(400, "INVALID_RESOURCE_PROFILE", "memory_limit_bytes 必须在 64MiB..1TiB 内");
  }
  const pids = Number(input.pids_limit ?? 512);
  if (!Number.isInteger(pids) || pids < 16 || pids > 1_000_000) {
    throw new PcsError(400, "INVALID_RESOURCE_PROFILE", "pids_limit 必须在 16..1000000 内");
  }
  const io = Number(input.io_weight ?? 500);
  if (!Number.isInteger(io) || io < 10 || io > 1000) {
    throw new PcsError(400, "INVALID_RESOURCE_PROFILE", "io_weight 必须在 10..1000 内");
  }
  return {
    cpu_limit: cpu,
    memory_limit_bytes: Math.round(memory),
    memory_reservation_bytes: Math.round(Number(input.memory_reservation_bytes ?? memory / 2)),
    pids_limit: pids,
    io_weight: io,
  };
}
