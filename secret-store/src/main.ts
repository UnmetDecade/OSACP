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
  if (!v) throw new Error(`Missing environment variable ${name}`);
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
    if (size > 64 * 1024) throw new SecretError("BODY_TOO_LARGE", "Request body too large", 413);
    chunks.push(b);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new SecretError("INVALID_JSON", "Request body is not JSON", 400);
  }
}

function instanceFrom(req: http.IncomingMessage): string {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m) throw new SecretError("TOKEN_REQUIRED", "Missing instance token", 401);
  try {
    return verifyInstanceToken(m[1], publicKey, audience).sub;
  } catch (e) {
    throw new SecretError("TOKEN_INVALID", e instanceof Error ? e.message : "Invalid token", 401);
  }
}

const tlsCertFile = (process.env.SECRET_STORE_TLS_CERT_FILE ?? "").trim();
const tlsKeyFile = (process.env.SECRET_STORE_TLS_KEY_FILE ?? "").trim();
const tlsCaFile = (process.env.SECRET_STORE_TLS_CA_FILE ?? "").trim();
const requireClientCert = process.env.SECRET_STORE_MTLS === "1";
if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
  throw new Error("SECRET_STORE_TLS_CERT_FILE and SECRET_STORE_TLS_KEY_FILE must be configured together");
}
if (requireClientCert && (!tlsCertFile || !tlsCaFile)) {
  throw new Error("SECRET_STORE_MTLS=1 requires both a TLS certificate and a client CA");
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
          throw new SecretError("ADMIN_AUTH_REQUIRED", "Writing secrets requires an admin token", 401);
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
          throw new SecretError("ADMIN_AUTH_REQUIRED", "Revocation requires an admin token", 401);
        }
        const b = await body(req);
        store.revoke(String(b.instance_id ?? ""));
        return send(res, 200, { ok: true });
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: "No such endpoint" } });
    } catch (e) {
      if (e instanceof SecretError) {
        send(res, e.status, { error: { code: e.code, message: e.message } });
      } else {
        console.error("[secret-store]", e instanceof Error ? e.message : String(e));
        send(res, 500, { error: { code: "INTERNAL", message: "Internal error" } });
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
    `[secret-store] listening on ${tlsCertFile ? "https" : "http"}://${host}:${port} (TTL ${ttl}s; secret values are never logged)`,
  );
});
