import { createPublicKey, verify } from "node:crypto";

export interface InstanceClaims {
  sub: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  scopes?: string[];
}

/**
 * Minimal ES256 JWT verification: only checks the signature, audience, and time.
 * Tokens are issued by the PCS; the private key is not in the Secret Store.
 */
export function verifyInstanceToken(
  token: string,
  publicKeyPem: string,
  audience: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): InstanceClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token format");
  let header: Record<string, unknown>;
  let claims: InstanceClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Token is not valid JSON");
  }
  if (header.alg !== "ES256") throw new Error(`Unsupported algorithm: ${header.alg}`);
  const key = createPublicKey(publicKeyPem);
  const ok = verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url"),
  );
  if (!ok) throw new Error("Signature verification failed");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw new Error("Token audience mismatch");
  if (!claims.sub) throw new Error("Token is missing sub");
  if (claims.exp !== undefined && claims.exp <= nowSeconds) throw new Error("Token has expired");
  if (claims.nbf !== undefined && claims.nbf > nowSeconds + 30) throw new Error("Token is not valid yet");
  return claims;
}
