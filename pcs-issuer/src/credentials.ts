import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { PcsError } from "./errors.js";

/**
 * SSH 私钥的静态加密。
 *
 * PCS 需要长期持有远程主机的 SSH 私钥，才能重连、探测和滚动升级。私钥不能
 * 明文落库，也不能出现在接口返回值里：
 *   - 落库：AES-256-GCM，每条记录独立随机 IV；
 *   - 密钥：PCS_CREDENTIAL_KEY_FILE 指向的 32 字节文件（0600），与数据库分离；
 *   - 接口：只返回 fingerprint，私钥值永不回显。
 *
 * 没配置密钥文件时，SSH 主机功能直接拒绝，而不是退回明文存储。
 */
export type SealedSecret = {
  ciphertext: string;
  iv: string;
  tag: string;
};

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function loadCredentialKey(file: string | null): Buffer | null {
  if (!file) return null;
  const raw = fs.readFileSync(file);
  const key = parseKey(raw);
  if (key.length !== 32) {
    throw new Error(`SSH 凭据密钥必须是 32 字节（当前 ${key.length}）：${file}`);
  }
  return key;
}

/** 允许原始 32 字节，或 64 位 hex / base64 文本，方便用 openssl 生成。 */
function parseKey(raw: Buffer): Buffer {
  if (raw.length === 32) return raw;
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/=]{43,44}$/.test(text)) {
    const decoded = Buffer.from(text, "base64");
    if (decoded.length === 32) return decoded;
  }
  return raw;
}

export function sealSecret(key: Buffer, plaintext: string): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function openSecret(key: Buffer, sealed: SealedSecret): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** 只用于界面辨认，不能反推私钥。 */
export function secretFingerprint(plaintext: string): string {
  return `sha256:${createHash("sha256").update(plaintext).digest("hex").slice(0, 32)}`;
}

/** 私钥格式的粗校验：真正能不能用由 SSH 探测说了算。 */
export function looksLikePrivateKey(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value) && /-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(value);
}

/**
 * 决定这台 SSH 主机用私钥还是密码登录。
 * 两个都没填时：新增主机直接报错；改主机则返回 null 表示沿用原凭据。
 */
export function resolveAuthType(privateKey: string, password: string): "key" | "password";
export function resolveAuthType(
  privateKey: string,
  password: string,
  opts: { optional: true },
): "key" | "password" | null;
export function resolveAuthType(
  privateKey: string,
  password: string,
  opts: { optional?: boolean } = {},
): "key" | "password" | null {
  if (password && /[\r\n\0]/.test(password)) {
    throw new PcsError(400, "INVALID_PASSWORD", "密码不能包含换行或空字节");
  }
  if (privateKey && password) {
    throw new PcsError(400, "CREDENTIAL_CONFLICT", "私钥和密码只填一个");
  }
  if (privateKey) {
    if (!looksLikePrivateKey(privateKey)) {
      throw new PcsError(400, "INVALID_PRIVATE_KEY", "私钥看起来不是 PEM/OpenSSH 私钥");
    }
    return "key";
  }
  if (password) {
    if (password.length > 1024) {
      throw new PcsError(400, "INVALID_PASSWORD", "密码过长");
    }
    return "password";
  }
  if (opts.optional) return null;
  throw new PcsError(400, "CREDENTIAL_REQUIRED", "需要填写 SSH 密码或私钥");
}
