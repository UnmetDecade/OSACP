import { createPublicKey, verify } from "node:crypto";
import type { RuntimeHostConfig } from "./runtime-config.js";

export type CommandType = "DEPLOY" | "START" | "STOP" | "RESTART" | "REMOVE";

export interface ResourceProfile {
  cpu_limit: number;
  memory_limit_bytes: number;
  memory_reservation_bytes?: number;
  pids_limit?: number;
  io_weight?: number;
}

export interface PortMapping {
  container: number;
  host: number;
}

export interface InstanceSpec {
  instance_id: string;
  role_id: string;
  display_name: string | null;
  /** container = Docker container (default); native = launch the role process directly on the host. */
  execution?: "container" | "native";
  /** native has no image; container roles require one, pinned to a digest. */
  image: string;
  resource_profile: ResourceProfile;
  env: Record<string, string>;
  volumes: Array<{ name: string; mount: string }>;
  ports?: PortMapping[];
  network_policy: string;
  config_version: number;
  command?: string[];
  /**
   * Config files written into the container at deploy time (e.g. an Agent Profile view).
   * The content arrives with the signed command and does not pass through the browser.
   */
  files?: Array<{ path: string; content: string }>;
  /**
   * Variable names read from the host-local credentials file (default $HOME/.config/platform/agent-env).
   * Only names are sent; the host runtime fills in the values, which neither the control plane nor the logs can see.
   */
  agent_env?: string[];
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
  resource_grant: {
    grant_id: string;
    kind: "DEPLOYMENT";
    cpu_limit: number;
    memory_limit_bytes: number;
  } | null;
  instance: InstanceSpec | null;
  signature: string;
}

export class CommandRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "CommandRejected";
  }
}

/** Must match PCS's canonicalJson byte for byte. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function verifyCommandSignature(payload: CommandPayload, publicKeyPem: string): boolean {
  if (!payload.signature?.startsWith("ed25519:")) return false;
  try {
    const { signature, ...unsigned } = payload;
    return verify(
      null,
      Buffer.from(canonicalJson(unsigned)),
      createPublicKey(publicKeyPem),
      Buffer.from(signature.slice("ed25519:".length), "base64url"),
    );
  } catch {
    return false;
  }
}

const COMMAND_TYPES = new Set(["DEPLOY", "START", "STOP", "RESTART", "REMOVE"]);
const SECRET_KEY = /(secret|token|password|passwd|credential|private[_-]?key)/i;
// The federation token issued by the control plane is not a user credential: the root uses it to verify child-node reports, and nodes use it to report.
// It arrives with the signed command and, unlike API keys, is not written into the instance's PROFILE file.
const PLATFORM_INJECTED_SECRETS = new Set(["SCHEDULER_FEDERATION_TOKEN"]);

function assertArray<T>(value: unknown, name: string): asserts value is T[] {
  if (!Array.isArray(value)) throw new CommandRejected("INVALID_COMMAND", `${name} 必须是数组`);
}

/**
 * Signature verification + every policy check. Any failure rejects execution and records this command_id as failed,
 * preventing PCS from repeatedly redelivering the same command.
 */
export function validateCommand(
  payload: CommandPayload,
  opts: {
    publicKeyPem: string;
    hostId: string;
    allowlist: string[];
    networkPolicies: Record<string, string>;
    nowMs?: number;
  },
): CommandPayload {
  if (!payload || typeof payload !== "object") {
    throw new CommandRejected("INVALID_COMMAND", "命令不是对象");
  }
  if (!verifyCommandSignature(payload, opts.publicKeyPem)) {
    throw new CommandRejected("COMMAND_SIGNATURE_INVALID", "命令签名校验失败");
  }
  if (payload.host_id !== opts.hostId) {
    throw new CommandRejected("COMMAND_WRONG_HOST", "命令不是发给本主机的");
  }
  if (!COMMAND_TYPES.has(payload.command_type)) {
    throw new CommandRejected("COMMAND_TYPE_NOT_ALLOWED", `不接受命令类型 ${payload.command_type}`);
  }
  if (!Number.isInteger(payload.generation) || payload.generation < 1) {
    throw new CommandRejected("INVALID_GENERATION", "generation 必须是正整数");
  }
  const now = opts.nowMs ?? Date.now();
  if (!payload.expires_at || Date.parse(payload.expires_at) <= now - 5000) {
    throw new CommandRejected("COMMAND_EXPIRED", "命令已过期");
  }
  const issued = Date.parse(payload.issued_at);
  if (!Number.isFinite(issued) || issued > now + 60_000) {
    throw new CommandRejected("COMMAND_CLOCK_SKEW", "命令签发时间在未来");
  }
  if (!payload.deployment_id || !payload.instance_id) {
    throw new CommandRejected("INVALID_COMMAND", "缺少 deployment_id / instance_id");
  }

  if (payload.command_type !== "DEPLOY") return payload;

  const spec = payload.instance;
  if (!spec || spec.instance_id !== payload.instance_id) {
    throw new CommandRejected("INVALID_COMMAND", "DEPLOY 缺少实例规格");
  }
  if (spec.execution !== undefined && spec.execution !== "container" && spec.execution !== "native") {
    throw new CommandRejected("INVALID_COMMAND", `不支持的执行方式：${String(spec.execution)}`);
  }
  const native = spec.execution === "native";
  if (!native) {
    if (!/@sha256:[0-9a-f]{64}$/.test(spec.image)) {
      throw new CommandRejected("IMAGE_NOT_PINNED", "镜像必须固定 digest");
    }
    const repo = spec.image.replace(/@sha256:[0-9a-f]{64}$/, "");
    const allowed = opts.allowlist.some((prefix) =>
      prefix.endsWith("/") ? repo.startsWith(prefix) : repo === prefix || repo.startsWith(`${prefix}/`),
    );
    if (!allowed) throw new CommandRejected("IMAGE_NOT_ALLOWED", `镜像仓库不在白名单：${repo}`);
  }

  const profile = spec.resource_profile;
  if (
    !profile ||
    !(profile.cpu_limit > 0) ||
    !(profile.memory_limit_bytes >= 64 * 1024 ** 2) ||
    !(Number(profile.pids_limit) >= 16)
  ) {
    throw new CommandRejected("INVALID_RESOURCE_PROFILE", "资源画像不合法");
  }
  if (!Object.prototype.hasOwnProperty.call(opts.networkPolicies, spec.network_policy)) {
    throw new CommandRejected("NETWORK_POLICY_NOT_ALLOWED", `网络策略不合法：${spec.network_policy}`);
  }
  const badEnv = Object.keys(spec.env ?? {}).filter(
    (k) => SECRET_KEY.test(k) && !PLATFORM_INJECTED_SECRETS.has(k),
  );
  if (badEnv.length) {
    throw new CommandRejected("SECRET_IN_ENVELOPE", "部署意图 env 含凭据类键", { keys: badEnv });
  }
  assertArray<{ name: string; mount: string }>(spec.volumes ?? [], "volumes");
  for (const v of spec.volumes ?? []) {
    if (!v?.mount?.startsWith("/opt/platform/") || v.mount.includes("..")) {
      throw new CommandRejected("INVALID_VOLUME", `卷挂载点非法：${v?.mount}`);
    }
  }
  assertArray<PortMapping>(spec.ports ?? [], "ports");
  if ((spec.ports ?? []).length > 8) {
    throw new CommandRejected("INVALID_COMMAND", "端口映射最多 8 条");
  }
  const seenContainer = new Set<number>();
  const seenHost = new Set<number>();
  for (const p of spec.ports ?? []) {
    if (
      !Number.isInteger(p?.container) ||
      !Number.isInteger(p?.host) ||
      p.container < 1 ||
      p.container > 65535 ||
      p.host < 1 ||
      p.host > 65535 ||
      seenContainer.has(p.container) ||
      seenHost.has(p.host)
    ) {
      throw new CommandRejected("INVALID_COMMAND", "端口映射必须是唯一且合法的 1–65535 TCP 端口");
    }
    seenContainer.add(p.container);
    seenHost.add(p.host);
  }
  if (spec.command !== undefined) {
    assertArray<string>(spec.command, "command");
    if (!spec.command.length || spec.command.some((x) => typeof x !== "string" || x.length > 4096)) {
      throw new CommandRejected("INVALID_COMMAND", "command 参数非法");
    }
  }
  if (spec.files !== undefined) {
    assertArray<{ path: string; content: string }>(spec.files, "files");
    if (spec.files.length > 16) {
      throw new CommandRejected("INVALID_COMMAND", "files 最多 16 个");
    }
    for (const f of spec.files) {
      if (
        typeof f?.path !== "string" ||
        !f.path.startsWith("/opt/platform/") ||
        f.path.includes("..") ||
        f.path.length > 200 ||
        typeof f.content !== "string" ||
        Buffer.byteLength(f.content) > 1024 * 1024
      ) {
        throw new CommandRejected("INVALID_COMMAND", `文件规格非法：${f?.path}`);
      }
    }
  }
  if (spec.agent_env !== undefined) {
    assertArray<string>(spec.agent_env, "agent_env");
    if (spec.agent_env.length > 32) {
      throw new CommandRejected("INVALID_COMMAND", "agent_env 最多 32 项");
    }
    for (const name of spec.agent_env) {
      if (
        typeof name !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) ||
        Object.prototype.hasOwnProperty.call(spec.env ?? {}, name)
      ) {
        throw new CommandRejected("INVALID_COMMAND", `agent_env 变量名非法：${name}`);
      }
    }
  }
  if (!payload.resource_grant?.grant_id?.startsWith("rgr_")) {
    throw new CommandRejected("INVALID_GRANT", "DEPLOY 缺少资源 grant");
  }
  return payload;
}

export type GenerationDecision = "APPLY" | "STALE";

export function generationDecision(
  command: CommandPayload,
  appliedGeneration: number | undefined,
): GenerationDecision {
  if (!appliedGeneration) return "APPLY";
  return command.generation <= appliedGeneration ? "STALE" : "APPLY";
}
