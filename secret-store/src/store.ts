import fs from "node:fs";
import path from "node:path";

export class SecretError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 403,
  ) {
    super(message);
    this.name = "SecretError";
  }
}

export interface SecretStoreOptions {
  secretsFile: string;
  policyFile: string;
  ttlSeconds?: number;
  audit?: (record: Record<string, unknown>) => void;
}

interface Policy {
  [instanceId: string]: string[];
}

/**
 * 参考实现的 Secret Store。
 *
 * 授权只有一条规则：实例令牌的 sub 必须被 policy 允许读取该 secret_ref。
 * 因此 Worker A 拿到自己的令牌也解析不了 Worker B 的引用。
 */
export class SecretStore {
  private revoked = new Set<string>();
  private readonly ttl: number;

  constructor(private readonly opts: SecretStoreOptions) {
    this.ttl = Math.max(1, Math.min(opts.ttlSeconds ?? 300, 3600));
    assertPrivateFile(opts.secretsFile);
    assertPrivateFile(opts.policyFile);
  }

  /** 每次读取文件，轮换 secrets 文件后下一次解析立即生效。 */
  private secrets(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.opts.secretsFile, "utf8")) as Record<string, string>;
    } catch (e) {
      throw new SecretError("SECRET_STORE_BROKEN", "Secret Store 数据不可读", 503);
    }
  }

  private policy(): Policy {
    try {
      return JSON.parse(fs.readFileSync(this.opts.policyFile, "utf8")) as Policy;
    } catch (e) {
      throw new SecretError("SECRET_STORE_BROKEN", "Secret Store 策略不可读", 503);
    }
  }

  resolve(instanceId: string, secretRef: string): { credential: string; expires_at: string } {
    if (!instanceId) throw new SecretError("SECRET_INSTANCE_REQUIRED", "缺少实例身份", 401);
    if (this.revoked.has(instanceId)) {
      this.record("resolve", instanceId, secretRef, "DENY", "INSTANCE_REVOKED");
      throw new SecretError("INSTANCE_REVOKED", "实例凭据已被吊销", 403);
    }
    if (!/^secret:\/\/[A-Za-z0-9._\-\/]+$/.test(secretRef)) {
      this.record("resolve", instanceId, secretRef, "DENY", "SECRET_REF_INVALID");
      throw new SecretError("SECRET_REF_INVALID", "secret_ref 格式非法", 400);
    }
    const policy = this.policy();
    // "*" 表示平台级密钥：所有已入网实例都可读取（控制台写入的 API 服务商密钥）。
    const allowed = [...(policy[instanceId] ?? []), ...(policy["*"] ?? [])];
    if (!allowed.includes(secretRef)) {
      this.record("resolve", instanceId, secretRef, "DENY", "SECRET_NOT_ALLOWED");
      throw new SecretError("SECRET_NOT_ALLOWED", "该实例无权读取此 secret_ref", 403);
    }
    const value = this.secrets()[secretRef];
    if (typeof value !== "string" || !value) {
      this.record("resolve", instanceId, secretRef, "DENY", "SECRET_NOT_FOUND");
      throw new SecretError("SECRET_NOT_FOUND", "secret_ref 没有对应值", 404);
    }
    const expiresAt = new Date(Date.now() + this.ttl * 1000).toISOString();
    this.record("resolve", instanceId, secretRef, "ALLOW", "OK", { expires_at: expiresAt });
    return { credential: value, expires_at: expiresAt };
  }

  /**
   * 管理面写入（控制台的「API Key」）。值只落 secrets 文件，审计只记引用。
   * platformWide 为真时把引用写进 policy 的 "*"，所有实例可解析。
   */
  put(secretRef: string, value: string, platformWide = true): { secret_ref: string; updated_at: string } {
    if (!/^secret:\/\/[A-Za-z0-9._\-\/]+$/.test(secretRef)) {
      throw new SecretError("SECRET_REF_INVALID", "secret_ref 格式非法", 400);
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
      throw new SecretError("SECRET_VALUE_INVALID", "密钥值必须是 1..8192 字符", 400);
    }
    if (/[\r\n\0]/.test(value)) {
      throw new SecretError("SECRET_VALUE_INVALID", "密钥值不能包含换行或 NUL", 400);
    }
    const secrets = this.secrets();
    secrets[secretRef] = value;
    writePrivateJson(this.opts.secretsFile, secrets);
    if (platformWide) {
      const policy = this.policy();
      const list = new Set(policy["*"] ?? []);
      list.add(secretRef);
      policy["*"] = [...list].sort();
      writePrivateJson(this.opts.policyFile, policy);
    }
    this.record("put", "*", secretRef, "ALLOW", "OK");
    return { secret_ref: secretRef, updated_at: new Date().toISOString() };
  }

  revoke(instanceId: string): void {
    if (!instanceId) throw new SecretError("SECRET_INSTANCE_REQUIRED", "缺少实例 id", 400);
    this.revoked.add(instanceId);
    this.record("revoke", instanceId, "*", "ALLOW", "REVOKED");
  }

  isRevoked(instanceId: string): boolean {
    return this.revoked.has(instanceId);
  }

  private record(
    action: string,
    instanceId: string,
    secretRef: string,
    decision: string,
    code: string,
    extra: Record<string, unknown> = {},
  ): void {
    try {
      this.opts.audit?.({
        ts: new Date().toISOString(),
        action,
        instance_id: instanceId,
        secret_ref: secretRef,
        decision,
        code,
        // 绝不记录 credential 或 secret 值
        ...extra,
      });
    } catch {
      // 审计失败不返回给调用方，避免把内部信息带出去
    }
  }
}

/** 原子写入：同目录临时文件 0600 → fsync → rename，失败不会留下半个 JSON。 */
function writePrivateJson(file: string, data: unknown): void {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function assertPrivateFile(file: string): void {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`${file} 不是普通文件`);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`${file} 权限过宽（必须 0600 或更严格）`);
  }
}
