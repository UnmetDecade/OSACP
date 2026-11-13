import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import fs from "node:fs";
import { ApiError } from "./errors.js";

/**
 * Minimal JWT (ES256) implementation with no third-party libraries.
 *
 * Spec §3.2 requires instance tokens to be issued by PCS and verified by the scheduler. This is the verification side only;
 * issuance lives in `pcs-issuer/` (a PCS stand-in); the private key never appears in the scheduler process.
 *
 * Key sources:
 *   PCS_PUBLIC_KEY       PEM contents (newlines may be written as \n)
 *   PCS_PUBLIC_KEY_FILE  path to a PEM file
 * When neither is configured, instance auth falls back to the shared AUTH_TOKEN (local development only),
 * while the approval endpoint returns 503 directly — approvals may not degrade.
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

/** Read the PCS public key; re-read on every call to ease testing and rotation */
export function pcsPublicKeyPem(): string | null {
  const inline = process.env.PCS_PUBLIC_KEY;
  if (inline) return inline.replace(/\\n/g, "\n");
  const file = process.env.PCS_PUBLIC_KEY_FILE;
  if (file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      throw new ApiError(503, "AUTH_NOT_CONFIGURED", `failed to read PCS public key: ${file}`);
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
    throw new ApiError(401, "TOKEN_INVALID", `token ${what} is not valid JSON`);
  }
}

/** Sign (tests and pcs-issuer share the same algorithm implementation) */
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
  /** Allowed clock skew (seconds) */
  skewSeconds?: number;
  nowSeconds?: number;
}

export function verifyJwt(token: string, opts: VerifyOptions = {}): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ApiError(401, "TOKEN_INVALID", "invalid token format");

  const header = parsePart<{ alg?: string; typ?: string }>(parts[0], "header");
  if (header.alg !== "ES256") {
    throw new ApiError(401, "TOKEN_INVALID", `unsupported signature algorithm: ${header.alg ?? "none"}`);
  }

  const pem = pcsPublicKeyPem();
  if (!pem) {
    throw new ApiError(503, "AUTH_NOT_CONFIGURED", "PCS public key is not configured; cannot verify signature");
  }

  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new ApiError(503, "AUTH_NOT_CONFIGURED", "invalid PCS public key format");
  }

  const ok = verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url"),
  );
  if (!ok) throw new ApiError(401, "TOKEN_INVALID", "invalid token signature");

  const claims = parsePart<TokenClaims>(parts[1], "payload");
  const skew = opts.skewSeconds ?? 60;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (typeof claims.exp !== "number") {
    throw new ApiError(401, "TOKEN_INVALID", "token is missing exp");
  }
  if (claims.exp + skew < now) throw new ApiError(401, "TOKEN_EXPIRED", "token has expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) {
    throw new ApiError(401, "TOKEN_INVALID", "token is not valid yet");
  }
  if (opts.issuer && claims.iss !== opts.issuer) {
    throw new ApiError(401, "TOKEN_INVALID", `untrusted issuer: ${claims.iss ?? "-"}`);
  }
  if (opts.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.audience)) {
      throw new ApiError(401, "TOKEN_INVALID", "token audience mismatch");
    }
  }
  return claims;
}

/** Verify signature + check scope. Scope is not a hint; it is a hard boundary. */
export function requireScope(claims: TokenClaims, scope: string): void {
  const scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
  if (!scopes.includes(scope)) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", `token is missing required scope: ${scope}`, {
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
 * Validate an approval token. Beyond signature and validity, it must satisfy:
 *   - typ = approval, with the approval:decide scope
 *   - declares approval_request_id / operator_id / action_scope
 * Binding to the specific approval request happens in decideApproval (which needs database access).
 */
export function verifyApprovalToken(token: string): ApprovalClaims {
  const claims = verifyJwt(token, { issuer: ISSUER, audience: AUDIENCE });
  if (claims.typ !== "approval") {
    throw new ApiError(401, "TOKEN_INVALID", "not an approval token");
  }
  requireScope(claims, "approval:decide");

  for (const k of ["approval_request_id", "operator_id"] as const) {
    if (typeof claims[k] !== "string" || !claims[k]) {
      throw new ApiError(401, "TOKEN_INVALID", `approval token is missing ${k}`);
    }
  }
  if (!Array.isArray(claims.action_scope)) {
    throw new ApiError(401, "TOKEN_INVALID", "approval token is missing action_scope");
  }
  return claims as ApprovalClaims;
}
