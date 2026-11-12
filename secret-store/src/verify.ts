import { createPublicKey, verify } from "node:crypto";

export interface InstanceClaims {
  sub: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  scopes?: string[];
}

/**
 * 最小 ES256 JWT 验签：只验证签名、受众与时间。
 * 令牌由 PCS 签发，私钥不在 Secret Store。
 */
export function verifyInstanceToken(
  token: string,
  publicKeyPem: string,
  audience: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): InstanceClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("令牌格式非法");
  let header: any;
  let claims: InstanceClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("令牌不是合法 JSON");
  }
  if (header.alg !== "ES256") throw new Error(`不支持的算法：${header.alg}`);
  const key = createPublicKey(publicKeyPem);
  const ok = verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url"),
  );
  if (!ok) throw new Error("签名校验失败");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw new Error("令牌受众不匹配");
  if (!claims.sub) throw new Error("令牌缺少 sub");
  if (claims.exp !== undefined && claims.exp <= nowSeconds) throw new Error("令牌已过期");
  if (claims.nbf !== undefined && claims.nbf > nowSeconds + 30) throw new Error("令牌尚未生效");
  return claims;
}
