/**
 * Secret Store client (§4.2).
 *
 * Only short-lived credentials are kept in memory; they are never logged, reported, or passed to the Adapter.
 * Credentials are bound to instance identity: the Secret Store authorizes using the sub of the instance JWT here.
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
  /** Local cache window; defaults to 0 (recheck with the Store on every egress, so revocation takes effect immediately) */
  cacheMs?: number;
}

export class SecretClient {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly opts: SecretClientOptions) {}

  /** The token appears only in the request header; credentials are never echoed in error messages either. */
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

  /** Drop the local cache immediately after revocation/rotation; the next request resolves again. */
  invalidate(secretRef?: string): void {
    if (secretRef) this.cache.delete(secretRef);
    else this.cache.clear();
  }
}
