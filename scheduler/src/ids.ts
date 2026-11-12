import { createHash, randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Stable serialization: sort object keys, used for digest calculation */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
