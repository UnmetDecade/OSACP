import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import fs from "node:fs";
import { ApiError } from "./errors.js";

/**
 * 最小 JWT（ES256）实现，不引第三方库。
 *
 * 规范 §3.2 要求实例令牌由 PCS 签发、调度机验签。这里只做验证侧；
 * 签发在 `pcs-issuer/`（PCS 的替身），私钥永远不出现在调度机进程里。
 *
 * 密钥来源：
 *   PCS_PUBLIC_KEY       PEM 内容（换行可用 \n）
 *   PCS_PUBLIC_KEY_FILE  PEM 文件路径
 * 两者都没配置时，实例鉴权退回 AUTH_TOKEN 共享令牌（仅限本地开发），
 * 审批接口则直接 503 —— 审批不允许降级。
 */

export const ISSUER = "platform-control";
export const AUDIENCE = "scheduler";

export interface TokenClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  jti?: string;
  scopes?: string[];
  role?: string;
  host_id?: string;
  typ?: string;
  [key: string]: unknown;
}

/** 读取 PCS 公钥；每次调用都重新读，方便测试和轮换 */
export function pcsPublicKeyPem(): string | null {
  const inline = process.env.PCS_PUBLIC_KEY;
  if (inline) return inline.replace(/\\n/g, "\n");
  const file = process.env.PCS_PUBLIC_KEY_FILE;
  if (file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      throw new ApiError(503, "AUTH_NOT_CONFIGURED", `无法读取 PCS 公钥：${file}`);
    }
  }
  return null;
}

export function jwtEnabled(): boolean {
  return !!pcsPublicKeyPem();
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parsePart<T>(part: string, what: string): T {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
  } catch {
    throw new ApiError(401, "TOKEN_INVALID", `令牌 ${what} 不是合法 JSON`);
  }
}

/** 签发（测试与 pcs-issuer 共用同一算法实现） */
export function signJwt(
  claims: TokenClaims,
  privateKeyPem: string,
  header: Record<string, unknown> = { alg: "ES256", typ: "JWT" },
): string {
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

export interface VerifyOptions {
  issuer?: string;
  audience?: string;
  /** 允许的时钟偏差（秒） */
  skewSeconds?: number;
  nowSeconds?: number;
}

export function verifyJwt(token: string, opts: VerifyOptions = {}): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ApiError(401, "TOKEN_INVALID", "令牌格式无效");

  const header = parsePart<{ alg?: string; typ?: string }>(parts[0], "头部");
  if (header.alg !== "ES256") {
    throw new ApiError(401, "TOKEN_INVALID", `不支持的签名算法：${header.alg ?? "none"}`);
  }

  const pem = pcsPublicKeyPem();
  if (!pem) {
    throw new ApiError(503, "AUTH_NOT_CONFIGURED", "未配置 PCS 公钥，无法验签");
  }

  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new ApiError(503, "AUTH_NOT_CONFIGURED", "PCS 公钥格式无效");
  }

  const ok = verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url"),
  );
  if (!ok) throw new ApiError(401, "TOKEN_INVALID", "令牌签名无效");

  const claims = parsePart<TokenClaims>(parts[1], "载荷");
  const skew = opts.skewSeconds ?? 60;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (typeof claims.exp !== "number") {
    throw new ApiError(401, "TOKEN_INVALID", "令牌缺少 exp");
  }
  if (claims.exp + skew < now) throw new ApiError(401, "TOKEN_EXPIRED", "令牌已过期");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) {
    throw new ApiError(401, "TOKEN_INVALID", "令牌尚未生效");
  }
  if (opts.issuer && claims.iss !== opts.issuer) {
    throw new ApiError(401, "TOKEN_INVALID", `签发者不受信任：${claims.iss ?? "-"}`);
  }
  if (opts.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.audience)) {
      throw new ApiError(401, "TOKEN_INVALID", "令牌受众不匹配");
    }
  }
  return claims;
}

/** 验签 + 校验 scope。scope 不是提示信息，是硬性边界。 */
export function requireScope(claims: TokenClaims, scope: string): void {
  const scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
  if (!scopes.includes(scope)) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", `令牌缺少权限范围：${scope}`, {
      required: scope,
      scopes,
    });
  }
}

export interface ApprovalClaims extends TokenClaims {
  typ: "approval";
  approval_request_id: string;
  operator_id: string;
  subject_digest: string | null;
  action_scope: string[];
}

/**
 * 验证审批令牌。除了签名与有效期，还要满足：
 *   - typ = approval，且带 approval:decide scope
 *   - 声明了 approval_request_id / operator_id / action_scope
 * 与具体审批请求的绑定在 decideApproval 里做（需要读库）。
 */
export function verifyApprovalToken(token: string): ApprovalClaims {
  const claims = verifyJwt(token, { issuer: ISSUER, audience: AUDIENCE });
  if (claims.typ !== "approval") {
    throw new ApiError(401, "TOKEN_INVALID", "不是审批令牌");
  }
  requireScope(claims, "approval:decide");

  for (const k of ["approval_request_id", "operator_id"] as const) {
    if (typeof claims[k] !== "string" || !claims[k]) {
      throw new ApiError(401, "TOKEN_INVALID", `审批令牌缺少 ${k}`);
    }
  }
  if (!Array.isArray(claims.action_scope)) {
    throw new ApiError(401, "TOKEN_INVALID", "审批令牌缺少 action_scope");
  }
  return claims as ApprovalClaims;
}
