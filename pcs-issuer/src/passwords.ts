import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing for accounts.
 *
 * scrypt is memory-hard, available in node:crypto without a dependency, and the
 * parameters are stored with the hash so they can be raised later without
 * invalidating existing accounts.
 */
const N = 2 ** 15; // 32768; ~32 MiB per hash at r=8
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", String(N), String(R), String(P), salt.toString("base64"), hash.toString("base64")].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Reject absurd parameters rather than allocating unbounded memory for a crafted row.
  if (n < 2 ** 12 || n > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (!salt.length || !expected.length) return false;
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 32 random bytes, base64url: used for session and CSRF tokens. */
export function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
