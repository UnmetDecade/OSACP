import { timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { ApiError } from "./errors.js";
import { jwtEnabled, verifyJwt, type TokenClaims } from "./jwt.js";

/**
 * Instance-side authentication (spec §3.2).
 *
 * Preferred: instance JWT issued by PCS (ES256). `sub` is the instance_id; scope decides what it can do.
 * Transitional: without a PCS public key, fall back to the shared AUTH_TOKEN, local development only; warn at startup.
 *
 * Verification only answers "who you are and what scope you have"; "whether this instance_id matches the one in your request"
 * is checked by the routing layer with `assertSelf`.
 */

export interface AuthContext {
  kind: "jwt" | "shared";
  /** Token sub in JWT mode; null in shared-token mode */
  instance_id: string | null;
  scopes: string[];
  claims?: TokenClaims;
}

export function authToken(): string | undefined {
  return process.env.AUTH_TOKEN || undefined;
}

export function authEnabled(): boolean {
  return jwtEnabled() || !!authToken();
}

/** Constant-time comparison; reject differing lengths up front to avoid timingSafeEqual throwing */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Parse `Bearer <token>` without a regular expression: a linear scan cannot be made to backtrack. */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const prefix = "bearer ";
  if (header.length <= prefix.length) return null;
  if (header.slice(0, prefix.length).toLowerCase() !== prefix) return null;
  const token = header.slice(prefix.length).trim();
  return token.length ? token : null;
}

function bearer(req: http.IncomingMessage): string {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new ApiError(401, "UNAUTHENTICATED", "missing Bearer token");
  return token;
}

export function requireInstanceAuth(req: http.IncomingMessage): AuthContext | null {
  if (jwtEnabled()) {
    const claims = verifyJwt(bearer(req), { issuer: "platform-control", audience: "scheduler" });
    if (!claims.sub) throw new ApiError(401, "TOKEN_INVALID", "instance token is missing sub");
    return {
      kind: "jwt",
      instance_id: claims.sub,
      scopes: Array.isArray(claims.scopes) ? claims.scopes : [],
      claims,
    };
  }

  const expected = authToken();
  if (!expected) return null;
  if (!safeEqual(bearer(req), expected)) {
    throw new ApiError(401, "UNAUTHENTICATED", "invalid token");
  }
  return { kind: "shared", instance_id: null, scopes: [] };
}

/** In JWT mode the token subject must equal the instance_id in the request */
export function assertSelf(auth: AuthContext | null, instanceId: string | undefined): void {
  if (auth?.kind !== "jwt") return;
  if (!instanceId || instanceId !== auth.instance_id) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "instance tokens may only operate on their own instance", {
      token_sub: auth.instance_id,
      requested: instanceId ?? null,
    });
  }
}

/** Approvals no longer accept shared admin tokens: either a PCS public key is available for verification, or reject (fail closed). */
export function requireApprovalConfigured(): void {
  if (!jwtEnabled()) {
    throw new ApiError(503, "APPROVAL_NOT_CONFIGURED", "PCS public key is not configured; approval endpoints are unavailable");
  }
}
