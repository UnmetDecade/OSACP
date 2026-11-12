/**
 * Secret Store 客户端（§4.2）。
 *
 * 只把短期凭据放进内存；不写日志、不上报、不传给 Adapter。
 * 凭据绑定实例身份：Secret Store 用这里的实例 JWT 的 sub 做授权。
 */

export class SecretDenied extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SecretDenied";
  }
}

interface Cached {
  credential: string;
  expiresAt: number;
}

export interface SecretClientOptions {
  url: string;
  token: string | (() => string | undefined);
  timeoutMs?: number;
  /** 本地缓存窗口；默认 0（每次出站都向 Store 复核，吊销立即生效） */
  cacheMs?: number;
}

export class SecretClient {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly opts: SecretClientOptions) {}

  /** 令牌只在请求头里出现；错误信息里也绝不回显凭据。 */
  private authToken(): string {
    const token = typeof this.opts.token === "function" ? this.opts.token() : this.opts.token;
    if (!token) throw new SecretDenied("SECRET_TOKEN_MISSING", "实例没有可用的身份令牌");
    return token;
  }

  async resolve(secretRef: string): Promise<{ credential: string; expiresAt: number }> {
    const cacheMs = this.opts.cacheMs ?? 0;
    const hit = this.cache.get(secretRef);
    if (cacheMs > 0 && hit && Math.min(hit.expiresAt - 60_000, Date.now() + cacheMs) > Date.now()) {
      return { credential: hit.credential, expiresAt: hit.expiresAt };
    }

    let res: Response;
    try {
      res = await fetch(`${this.opts.url.replace(/\/+$/, "")}/v1/secrets/resolve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.authToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ secret_ref: secretRef }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3000),
      });
    } catch (e) {
      throw new SecretDenied(
        "SECRET_STORE_UNAVAILABLE",
        `Secret Store 不可达：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new SecretDenied(
        String(err.code ?? `SECRET_HTTP_${res.status}`),
        String(err.message ?? `Secret Store 返回 ${res.status}`),
      );
    }
    const credential = String(data.credential ?? "");
    const expiresAt = Date.parse(String(data.expires_at ?? ""));
    if (!credential || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new SecretDenied("SECRET_RESPONSE_INVALID", "Secret Store 返回的凭据无效");
    }
    this.cache.set(secretRef, { credential, expiresAt });
    return { credential, expiresAt };
  }

  /** 吊销/轮换后立即丢弃本地缓存，下一次请求重新解析。 */
  invalidate(secretRef?: string): void {
    if (secretRef) this.cache.delete(secretRef);
    else this.cache.clear();
  }
}
