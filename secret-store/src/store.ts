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
 * Reference Secret Store implementation.
 *
 * Authorization follows a single rule: the instance token's sub must be allowed by the policy to read
 * that secret_ref. So Worker A cannot resolve Worker B's reference even with its own token.
 */
export class SecretStore {
  private revoked = new Set<string>();
  private readonly ttl: number;

  constructor(private readonly opts: SecretStoreOptions) {
    this.ttl = Math.max(1, Math.min(opts.ttlSeconds ?? 300, 3600));
    assertPrivateFile(opts.secretsFile);
    assertPrivateFile(opts.policyFile);
  }

  /** Read the file on every call, so rotating the secrets file takes effect on the next resolve. */
  private secrets(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.opts.secretsFile, "utf8")) as Record<string, string>;
    } catch (e) {
      throw new SecretError("SECRET_STORE_BROKEN", "Secret Store data is unreadable", 503);
    }
  }

  private policy(): Policy {
    try {
      return JSON.parse(fs.readFileSync(this.opts.policyFile, "utf8")) as Policy;
    } catch (e) {
      throw new SecretError("SECRET_STORE_BROKEN", "Secret Store policy is unreadable", 503);
    }
  }

  resolve(instanceId: string, secretRef: string): { credential: string; expires_at: string } {
    if (!instanceId) throw new SecretError("SECRET_INSTANCE_REQUIRED", "Missing instance identity", 401);
    if (this.revoked.has(instanceId)) {
      this.record("resolve", instanceId, secretRef, "DENY", "INSTANCE_REVOKED");
      throw new SecretError("INSTANCE_REVOKED", "Instance credentials have been revoked", 403);
    }
    if (!/^secret:\/\/[A-Za-z0-9._\-\/]+$/.test(secretRef)) {
      this.record("resolve", instanceId, secretRef, "DENY", "SECRET_REF_INVALID");
      throw new SecretError("SECRET_REF_INVALID", "Invalid secret_ref format", 400);
    }
    const policy = this.policy();
    // "*" denotes a platform-wide secret: every enrolled instance can read it (API provider keys written from the console).
    const allowed = [...(policy[instanceId] ?? []), ...(policy["*"] ?? [])];
    if (!allowed.includes(secretRef)) {
      this.record("resolve", instanceId, secretRef, "DENY", "SECRET_NOT_ALLOWED");
      throw new SecretError("SECRET_NOT_ALLOWED", "This instance is not allowed to read this secret_ref", 403);
    }
    const value = this.secrets()[secretRef];
    if (typeof value !== "string" || !value) {
      this.record("resolve", instanceId, secretRef, "DENY", "SECRET_NOT_FOUND");
      throw new SecretError("SECRET_NOT_FOUND", "secret_ref has no corresponding value", 404);
    }
    const expiresAt = new Date(Date.now() + this.ttl * 1000).toISOString();
    this.record("resolve", instanceId, secretRef, "ALLOW", "OK", { expires_at: expiresAt });
    return { credential: value, expires_at: expiresAt };
  }

  /**
   * Management-plane write (the console's "API Key"). Only the value is written to the secrets file; the audit log records only the reference.
   * When platformWide is true, the reference is written into the policy's "*", so all instances can resolve it.
   */
  put(secretRef: string, value: string, platformWide = true): { secret_ref: string; updated_at: string } {
    if (!/^secret:\/\/[A-Za-z0-9._\-\/]+$/.test(secretRef)) {
      throw new SecretError("SECRET_REF_INVALID", "Invalid secret_ref format", 400);
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
      throw new SecretError("SECRET_VALUE_INVALID", "Secret value must be 1..8192 characters", 400);
    }
    if (/[\r\n\0]/.test(value)) {
      throw new SecretError("SECRET_VALUE_INVALID", "Secret value must not contain newlines or NUL", 400);
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
    if (!instanceId) throw new SecretError("SECRET_INSTANCE_REQUIRED", "Missing instance id", 400);
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
        // Never record the credential or secret value
        ...extra,
      });
    } catch {
      // Audit failures are not surfaced to the caller, to avoid leaking internal information
    }
  }
}

/** Atomic write: temp file 0600 in the same directory → fsync → rename; a failure never leaves half a JSON file. */
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
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`${file} permissions are too broad (must be 0600 or stricter)`);
  }
}
