import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { PcsError } from "./errors.js";

/**
 * Static encryption of SSH private keys.
 *
 * The PCS must hold remote hosts' SSH private keys long-term in order to reconnect, probe, and rolling-upgrade.
 * Private keys must not be stored in plaintext or appear in API responses:
 *   - at rest: AES-256-GCM, with an independent random IV per record;
 *   - key: the 32-byte file (0600) pointed to by PCS_CREDENTIAL_KEY_FILE, kept separate from the database;
 *   - API: returns only the fingerprint; the private key value is never echoed.
 *
 * When no key file is configured, SSH host features are rejected outright rather than falling back to plaintext storage.
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

/** Accepts raw 32 bytes, or 64-char hex / base64 text, so it is easy to generate with openssl. */
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

/** Used only for UI identification; it cannot be reversed to the private key. */
export function secretFingerprint(plaintext: string): string {
  return `sha256:${createHash("sha256").update(plaintext).digest("hex").slice(0, 32)}`;
}

/** Rough validation of the private key format: whether it actually works is decided by SSH probing. */
export function looksLikePrivateKey(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value) && /-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(value);
}

/**
 * Decide whether this SSH host logs in with a private key or a password.
 * When neither is provided: adding a new host fails; updating a host returns null to keep the existing credential.
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
