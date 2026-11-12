import { timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { ApiError } from "./errors.js";
import { jwtEnabled, verifyJwt, type TokenClaims } from "./jwt.js";

/**
 * 实例侧鉴权（规范 §3.2）。
 *
 * 首选：PCS 签发的实例 JWT（ES256）。`sub` 就是 instance_id，scope 决定能做什么。
 * 过渡：未配置 PCS 公钥时退回 AUTH_TOKEN 共享令牌，仅限本地开发；启动时告警。
 *
 * 验签只回答「你是谁、你有什么 scope」；「这个 instance_id 和你请求里的
 * instance_id 是否一致」由路由层用 `assertSelf` 检查。
 */

export interface AuthContext {
  kind: "jwt" | "shared";
  /** JWT 模式下为令牌 sub；共享令牌模式为 null */
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

/** 常量时间比较；长度不同直接拒绝，避免 timingSafeEqual 抛错 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function bearer(req: http.IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) throw new ApiError(401, "UNAUTHENTICATED", "缺少 Bearer 令牌");
  return m[1];
}

export function requireInstanceAuth(req: http.IncomingMessage): AuthContext | null {
  if (jwtEnabled()) {
    const claims = verifyJwt(bearer(req), { issuer: "platform-control", audience: "scheduler" });
    if (!claims.sub) throw new ApiError(401, "TOKEN_INVALID", "实例令牌缺少 sub");
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
    throw new ApiError(401, "UNAUTHENTICATED", "令牌无效");
  }
  return { kind: "shared", instance_id: null, scopes: [] };
}

/** JWT 模式下，令牌主体必须等于请求里的 instance_id */
export function assertSelf(auth: AuthContext | null, instanceId: string | undefined): void {
  if (auth?.kind !== "jwt") return;
  if (!instanceId || instanceId !== auth.instance_id) {
    throw new ApiError(403, "ROLE_NOT_ALLOWED", "实例令牌只能操作自身实例", {
      token_sub: auth.instance_id,
      requested: instanceId ?? null,
    });
  }
}

/** 审批不再接受共享管理员令牌：要么有 PCS 公钥能验签，要么拒绝（fail closed）。 */
export function requireApprovalConfigured(): void {
  if (!jwtEnabled()) {
    throw new ApiError(503, "APPROVAL_NOT_CONFIGURED", "未配置 PCS 公钥，审批接口不可用");
  }
}
