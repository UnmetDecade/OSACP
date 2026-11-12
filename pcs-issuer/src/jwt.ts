import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { PcsError } from "./errors.js";

export const ISSUER = "platform-control";
export const SCHEDULER_AUDIENCE = "scheduler";
export const RUNTIME_AUDIENCE = "host-runtime";
export const ADMIN_AUDIENCE = "platform-control";

export const HOST_SCOPES = [
  "runtime:heartbeat",
  "runtime:commands",
  "runtime:report",
  "runtime:token",
];

export const ADMIN_SCOPES = [
  "host:read",
  "host:admin",
  "deployment:read",
  "deployment:write",
  "profile:read",
  "profile:write",
  "approval:issue",
];

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  typ?: string;
  scopes?: string[];
  iat?: number;
  exp?: number;
  nbf?: number;
  jti?: string;
  [key: string]: unknown;
}

const b64urlJson = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** 与调度机 src/jwt.ts 的 signJwt 同一算法：ES256 + ieee-p1363 */
export function signJwt(claims: JwtClaims, privateKeyPem: string): string {
  const header = { alg: "ES256", typ: "JWT" };
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

export interface VerifyOptions {
  audience: string;
  typ?: string;
  nowSeconds?: number;
  skewSeconds?: number;
}

export function verifyJwt(token: string, publicKeyPem: string, opts: VerifyOptions): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new PcsError(401, "TOKEN_INVALID", "令牌格式错误");
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; typ?: string };
  let claims: JwtClaims;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new PcsError(401, "TOKEN_INVALID", "令牌内容不是合法 JSON");
  }
  if (header.alg !== "ES256") throw new PcsError(401, "TOKEN_INVALID", "只接受 ES256 令牌");

  const input = Buffer.from(`${headerB64}.${payloadB64}`);
  const ok = verify(
    "sha256",
    input,
    { key: createPublicKey(publicKeyPem), dsaEncoding: "ieee-p1363" },
    Buffer.from(signatureB64, "base64url"),
  );
  if (!ok) throw new PcsError(401, "TOKEN_INVALID", "签名校验失败");

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? 5;
  if (typeof claims.exp === "number" && now > claims.exp + skew) {
    throw new PcsError(401, "TOKEN_EXPIRED", "令牌已过期");
  }
  if (typeof claims.nbf === "number" && now + skew < claims.nbf) {
    throw new PcsError(401, "TOKEN_NOT_YET_VALID", "令牌尚未生效");
  }
  if (claims.iss !== ISSUER) throw new PcsError(401, "TOKEN_INVALID", "签发方不匹配");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(opts.audience)) {
    throw new PcsError(401, "TOKEN_INVALID", `受众不匹配：需要 ${opts.audience}`);
  }
  if (opts.typ && claims.typ !== opts.typ) {
    throw new PcsError(401, "TOKEN_INVALID", `令牌类型不是 ${opts.typ}`);
  }
  return claims;
}

export function requireClaimScope(claims: JwtClaims, scope: string): void {
  if (!claims.scopes?.includes(scope)) {
    throw new PcsError(403, "ROLE_NOT_ALLOWED", `缺少 scope：${scope}`);
  }
}
