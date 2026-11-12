import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SecretError, SecretStore } from "./store.js";
import { verifyInstanceToken } from "./verify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

const port = Number(process.env.SECRET_STORE_PORT ?? 7902);
const host = process.env.SECRET_STORE_HOST ?? "127.0.0.1";
const audience = process.env.SECRET_STORE_AUDIENCE ?? "scheduler";
const publicKeyFile =
  process.env.PCS_PUBLIC_KEY_FILE ?? path.resolve(root, "..", "pcs-issuer", "keys", "public.pem");
const auditFile = process.env.SECRET_STORE_AUDIT_FILE;
const adminToken = process.env.SECRET_STORE_ADMIN_TOKEN ?? "";

const publicKey = fs.readFileSync(publicKeyFile, "utf8");
const ttl = Number(process.env.SECRET_STORE_TTL_SECONDS ?? 300);

function audit(record: Record<string, unknown>): void {
  if (!auditFile) return;
  fs.mkdirSync(path.dirname(path.resolve(auditFile)), { recursive: true, mode: 0o700 });
  fs.appendFileSync(auditFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

const store = new SecretStore({
  secretsFile: env("SECRET_STORE_SECRETS_FILE"),
  policyFile: env("SECRET_STORE_POLICY_FILE"),
  ttlSeconds: ttl,
  audit,
});

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

async function body(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > 64 * 1024) throw new SecretError("BODY_TOO_LARGE", "请求体过大", 413);
    chunks.push(b);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new SecretError("INVALID_JSON", "请求体不是 JSON", 400);
  }
}

function instanceFrom(req: http.IncomingMessage): string {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m) throw new SecretError("TOKEN_REQUIRED", "缺少实例令牌", 401);
  try {
    return verifyInstanceToken(m[1], publicKey, audience).sub;
  } catch (e) {
    throw new SecretError("TOKEN_INVALID", e instanceof Error ? e.message : "令牌无效", 401);
  }
}

const tlsCertFile = (process.env.SECRET_STORE_TLS_CERT_FILE ?? "").trim();
const tlsKeyFile = (process.env.SECRET_STORE_TLS_KEY_FILE ?? "").trim();
const tlsCaFile = (process.env.SECRET_STORE_TLS_CA_FILE ?? "").trim();
const requireClientCert = process.env.SECRET_STORE_MTLS === "1";
if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
  throw new Error("SECRET_STORE_TLS_CERT_FILE 与 SECRET_STORE_TLS_KEY_FILE 必须同时配置");
}
if (requireClientCert && (!tlsCertFile || !tlsCaFile)) {
  throw new Error("SECRET_STORE_MTLS=1 需要同时配置 TLS 证书与客户端 CA");
}

const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(res, 200, { ok: true, service: "secret-store", ttl_seconds: ttl });
      }

      if (req.method === "POST" && url.pathname === "/v1/secrets/resolve") {
        const instanceId = instanceFrom(req);
        const b = await body(req);
        const out = store.resolve(instanceId, String(b.secret_ref ?? ""));
        return send(res, 200, out);
      }

      if (req.method === "PUT" && url.pathname === "/v1/secrets") {
        if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}`) {
          throw new SecretError("ADMIN_AUTH_REQUIRED", "写入密钥需要管理员令牌", 401);
        }
        const b = await body(req);
        const out = store.put(
          String(b.secret_ref ?? ""),
          String(b.value ?? ""),
          b.platform_wide !== false,
        );
        return send(res, 200, { ok: true, ...out });
      }

      if (req.method === "POST" && url.pathname === "/v1/secrets/revoke") {
        if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}`) {
          throw new SecretError("ADMIN_AUTH_REQUIRED", "吊销需要管理员令牌", 401);
        }
        const b = await body(req);
        store.revoke(String(b.instance_id ?? ""));
        return send(res, 200, { ok: true });
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: "没有这个接口" } });
    } catch (e) {
      if (e instanceof SecretError) {
        send(res, e.status, { error: { code: e.code, message: e.message } });
      } else {
        console.error("[secret-store]", e instanceof Error ? e.message : String(e));
        send(res, 500, { error: { code: "INTERNAL", message: "内部错误" } });
      }
    }
};

const server: http.Server | https.Server = tlsCertFile
  ? https.createServer(
      {
        cert: fs.readFileSync(tlsCertFile),
        key: fs.readFileSync(tlsKeyFile),
        ...(tlsCaFile ? { ca: fs.readFileSync(tlsCaFile) } : {}),
        ...(requireClientCert ? { requestCert: true, rejectUnauthorized: true } : {}),
      },
      handler,
    )
  : http.createServer(handler);

server.listen(port, host, () => {
  console.log(
    `[secret-store] 监听 ${tlsCertFile ? "https" : "http"}://${host}:${port}（TTL ${ttl}s，密钥值不落日志）`,
  );
});
