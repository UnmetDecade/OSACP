import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { PcsConfig } from "./config.js";
import { PcsError } from "./errors.js";
import type {
  ApprovalTokenInput,
  CreateAgentProfileInput,
  CreateApiProfileInput,
  CreateDeploymentInput,
  CreateDeploymentPlanInput,
  EnrollInput,
  PcsService,
  MandateRow,
  SideloadRow,
  SideloadScope,
} from "./service.js";
import {
  deleteInstanceFile,
  issueFileDownloadTicket,
  listInstanceFiles,
  streamFileDownload,
} from "./files.js";
import { issueTerminalTicket } from "./terminal.js";
import type { AccountRole } from "./jwt.js";

// The scheduler proxy forwards task-creation requests; task attachments go as base64, so 1MiB would hit the limit quickly.
const MAX_BODY = 32 * 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Stream raw bytes (task files) without touching JSON. */
function sendRaw(
  res: http.ServerResponse,
  status: number,
  body: Buffer,
  headers: Record<string, string>,
): void {
  res.writeHead(status, {
    "content-length": String(body.length),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

/** RFC 6266: an ASCII fallback plus the UTF-8 name, so non-ASCII file names survive the download. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY) throw new PcsError(413, "BODY_TOO_LARGE", "request body exceeds 32MiB");
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new PcsError(400, "INVALID_JSON", "request body is not a valid JSON object");
  }
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
  if (!token) throw new PcsError(401, "TOKEN_REQUIRED", "Bearer token is required");
  return token;
}

function intParam(value: string | null, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

/** The mandate reference stored in task requirements; the full record stays in PCS. */
function mandateRef(m: MandateRow) {
  return {
    mandate_id: m.mandate_id,
    policy_version: m.policy_version,
    source: m.source,
    actor: m.actor,
    strength: m.strength,
    scopes: m.scopes,
  };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge: number; httpOnly: boolean; secure: boolean },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`,
    ...(opts.httpOnly ? ["HttpOnly"] : []),
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve the built admin app from PCS_WEB_DIR.
 *
 * API routes run first, so this only sees page and asset requests. Paths are
 * resolved against the root and must stay inside it; unknown non-asset paths
 * fall back to index.html so client-side routes survive a refresh.
 */
async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
  pathname: string,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (pathname.startsWith("/api/") || pathname.startsWith("/healthz")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes("\0")) return false;
  const base = path.resolve(root);
  const target = path.resolve(base, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }
  let file = target;
  try {
    const st = await fs.promises.stat(file);
    if (st.isDirectory()) file = path.join(file, "index.html");
  } catch {
    file = "";
  }
  const ext = path.extname(file).toLowerCase();
  if (!file || !fs.existsSync(file)) {
    // Client-side routes (no extension) get the SPA shell; missing assets stay 404.
    if (ext && ext !== ".html") return false;
    file = path.join(base, "index.html");
  }
  if (!fs.existsSync(file)) return false;
  const headers = {
    "content-type": MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control":
      path.basename(file) === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  };
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return true;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    res.writeHead(200, headers);
    stream.pipe(res);
    stream.on("end", () => resolve());
  });
  return true;
}

/** Forward a scheduler API call and stream the response back (SSE included). */
function proxyToScheduler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  base: string,
  rest: string,
  search: string,
): Promise<void> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(base);
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "SCHEDULER_URL_INVALID", message: "invalid scheduler URL" } }));
      resolve();
      return;
    }
    const isHttps = target.protocol === "https:";
    const upstream = (isHttps ? https : http).request(
      {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${rest}${search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        up.on("end", resolve);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { code: "SCHEDULER_UNREACHABLE", message: "scheduler is not reachable" } }),
        );
      } else {
        res.end();
      }
      resolve();
    });
    req.pipe(upstream);
  });
}

export function createPcsServer(service: PcsService, cfg: PcsConfig): http.Server | https.Server {
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      // The UI always speaks to /api/pcs (the reverse-proxy prefix used by the dev
      // server and the demo). Serving the app from PCS itself keeps the same URLs.
      let path = url.pathname;
      if (path === "/api/pcs" || path.startsWith("/api/pcs/")) {
        path = path.slice("/api/pcs".length) || "/";
      } else if (path === "/pcs" || path.startsWith("/pcs/")) {
        path = path.slice("/pcs".length) || "/";
      }
      const method = req.method ?? "GET";
      const cookieSecure =
        cfg.cookieSecure === "always" ||
        (cfg.cookieSecure === "auto" &&
          (Boolean((req.socket as { encrypted?: boolean }).encrypted) ||
            req.headers["x-forwarded-proto"] === "https"));
      const admin = (scope: string) =>
        service.authenticateRequest(
          {
            bearer: bearerToken(req.headers.authorization) ?? undefined,
            session: readCookie(req.headers.cookie, "pcs_session"),
            csrf: String(req.headers["x-csrf-token"] ?? ""),
            mutating: method !== "GET" && method !== "HEAD" && method !== "OPTIONS",
            ip: req.socket.remoteAddress,
          },
          scope,
        );
      const host = async () => service.authenticateHost(bearer(req));

      // The admin app is a browser / desktop WebView: only send CORS headers to explicitly configured origins.
      const origin = req.headers.origin;
      if (origin && cfg.adminOrigins.includes(origin)) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("access-control-allow-credentials", "true");
        res.setHeader("vary", "origin");
        res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        res.setHeader("access-control-allow-headers", "authorization,content-type,x-csrf-token");
        res.setHeader("access-control-max-age", "600");
      }
      if (method === "OPTIONS") {
        res.writeHead(origin && cfg.adminOrigins.includes(origin) ? 204 : 403);
        return res.end();
      }

      if (method === "GET" && path === "/healthz") {
        return send(res, 200, { ok: true, service: "platform-control", version: "0.2.0" });
      }

      // The UI talks to one scheduler through /api/scheduler; forward to the first
      // active root scheduler. Only the scheduler's /v1 API is exposed here.
      if (path === "/api/scheduler" || path.startsWith("/api/scheduler/")) {
        const rest = path.slice("/api/scheduler".length) || "/";
        if (rest !== "/healthz" && !rest.startsWith("/v1/")) {
          send(res, 404, { error: { code: "NOT_FOUND", message: "no such scheduler endpoint" } });
          return;
        }
        const target = await service.defaultSchedulerUrl();
        if (!target) {
          throw new PcsError(503, "SCHEDULER_NOT_READY", "deploy a scheduler before using the UI");
        }
        await proxyToScheduler(req, res, target, rest, url.search);
        return;
      }

      // ---- Accounts: registration, login, logout and session introspection (no admin scope)
      const sessionCookie = () => readCookie(req.headers.cookie, "pcs_session");
      const setSessionCookies = (session: { token: string; csrf: string; expires_at: string }) => {
        const maxAge = Math.max(0, (new Date(session.expires_at).getTime() - Date.now()) / 1000);
        res.setHeader("set-cookie", [
          serializeCookie("pcs_session", session.token, { maxAge, httpOnly: true, secure: cookieSecure }),
          serializeCookie("pcs_csrf", session.csrf, { maxAge, httpOnly: false, secure: cookieSecure }),
        ]);
      };

      // Public login-page hints: registration policy and whether this is the demo
      // (which prefills admin/admin). No account data is exposed here.
      if (method === "GET" && path === "/api/v1/auth/config") {
        return send(res, 200, {
          demo: cfg.demoMode,
          registration: cfg.registrationMode,
          has_accounts: await service.hasAccounts(),
          // Without a Secret Store the API Profile dialog can only store secret:// references.
          secret_store: Boolean(cfg.secretStoreUrl),
        });
      }

      if (method === "POST" && path === "/api/v1/auth/register") {        const body = await readJson(req);
        const out = await service.registerAccount({
          username: body.username as string | undefined,
          password: body.password as string | undefined,
          display_name: body.display_name as string | undefined,
          ip: req.socket.remoteAddress,
          user_agent: String(req.headers["user-agent"] ?? ""),
        });
        if (out.session) setSessionCookies(out.session);
        return send(res, 201, { account: out.account, logged_in: Boolean(out.session) });
      }

      if (method === "POST" && path === "/api/v1/auth/login") {
        const body = await readJson(req);
        const out = await service.loginAccount({
          username: body.username as string | undefined,
          password: body.password as string | undefined,
          ip: req.socket.remoteAddress,
          user_agent: String(req.headers["user-agent"] ?? ""),
        });
        setSessionCookies(out.session);
        return send(res, 200, { account: out.account, scopes: out.account.scopes });
      }

      if (method === "POST" && path === "/api/v1/auth/logout") {
        const session = sessionCookie();
        if (session) await service.logoutSession(session, req.socket.remoteAddress);
        res.setHeader("set-cookie", [
          serializeCookie("pcs_session", "", { maxAge: 0, httpOnly: true, secure: cookieSecure }),
          serializeCookie("pcs_csrf", "", { maxAge: 0, httpOnly: false, secure: cookieSecure }),
        ]);
        return send(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/api/v1/auth/me") {
        const session = sessionCookie();
        const bearerRaw = bearerToken(req.headers.authorization);
        if (!session && bearerRaw) {
          const claims = service.authenticateAdmin(bearerRaw, "host:read");
          return send(res, 200, {
            account: null,
            scopes: claims.scopes ?? [],
            operator: claims.operator_id ?? claims.sub ?? "operator",
          });
        }
        if (!session) throw new PcsError(401, "LOGIN_REQUIRED", "login required");
        const out = await service.sessionAccount(session);
        return send(res, 200, { account: out.account, scopes: out.scopes, operator: out.account.username });
      }

      // ---- Account management (RBAC)
      if (method === "GET" && path === "/api/v1/platform/accounts") {
        await admin("account:read");
        return send(res, 200, { accounts: await service.listAccounts() });
      }

      if (method === "POST" && path === "/api/v1/platform/accounts") {
        const claims = await admin("account:write");
        const body = await readJson(req);
        const account = await service.createAccount(
          {
            username: body.username as string | undefined,
            password: body.password as string | undefined,
            display_name: body.display_name as string | undefined,
            role: body.role as AccountRole | undefined,
            scopes: body.scopes,
          },
          String(claims.operator_id ?? claims.sub),
        );
        return send(res, 201, { account });
      }

      const accountOne = /^\/api\/v1\/platform\/accounts\/([^/]+)$/.exec(path);
      if (method === "PATCH" && accountOne) {
        const claims = await admin("account:write");
        const body = await readJson(req);
        const account = await service.updateAccount(
          decodeURIComponent(accountOne[1]),
          {
            display_name: body.display_name as string | undefined,
            role: body.role as AccountRole | undefined,
            scopes: body.scopes,
            status: body.status as "PENDING" | "ACTIVE" | "DISABLED" | undefined,
            password: body.password as string | undefined,
          },
          String(claims.operator_id ?? claims.sub),
        );
        return send(res, 200, { account });
      }

      if (method === "DELETE" && accountOne) {
        const claims = await admin("account:write");
        return send(res, 200, {
          account: await service.deleteAccount(
            decodeURIComponent(accountOne[1]),
            String(claims.operator_id ?? claims.sub),
          ),
        });
      }

      // ---- Enrollment (with a one-time token, no Bearer)
      if (method === "POST" && path === "/api/v1/platform/hosts/enroll") {
        const body = await readJson(req);
        return send(res, 200, await service.enroll(body as unknown as EnrollInput));
      }

      // ---- Task attachment download: builders use a one-time token to fetch content, no admin Bearer needed.
      const attachmentGet = /^\/api\/v1\/platform\/attachments\/([^/]+)$/.exec(path);
      if (method === "GET" && attachmentGet) {
        const out = await service.getTaskAttachment(
          decodeURIComponent(attachmentGet[1]),
          url.searchParams.get("token") ?? "",
        );
        res.writeHead(200, {
          "content-type": out.media_type || "application/octet-stream",
          "content-length": String(out.data.length),
          "cache-control": "no-store",
        });
        res.end(out.data);
        return;
      }

      // ---- Management plane
      if (method === "POST" && path === "/api/v1/platform/hosts") {
        await admin("host:admin");
        const body = await readJson(req);
        const out = await service.createHost({
          name: String(body.name ?? ""),
          labels: body.labels as Record<string, unknown> | undefined,
        });
        return send(res, 201, {
          ...out,
          install_hint:
            `PCS_URL=${publicUrl(req, cfg)} PCS_ENROLLMENT_TOKEN=${out.enrollment_token} ` +
            "./scripts/runtime.sh start",
        });
      }

      if (method === "GET" && path === "/api/v1/platform/hosts") {
        await admin("host:read");
        return send(res, 200, { hosts: await service.listHosts() });
      }

      if (method === "GET" && path === "/api/v1/platform/fleet") {
        await admin("host:read");
        return send(res, 200, await service.getFleetTree());
      }

      if (method === "POST" && path === "/api/v1/platform/attachments") {
        await admin("deployment:write");
        const body = await readJson(req);
        return send(
          res,
          201,
          await service.createTaskAttachment({
            name: body.name,
            media_type: body.media_type,
            data_base64: body.data_base64,
          }),
        );
      }

      // ---- Sideloads: per-host tokens so a device on the LAN can drive tasks with curl
      if (method === "POST" && path === "/api/v1/platform/sideloads") {
        const claims = await admin("host:admin");
        const body = await readJson(req);
        const out = await service.createSideload({
          host_id: String(body.host_id ?? ""),
          name: String(body.name ?? ""),
          scopes: body.scopes as SideloadScope[] | undefined,
          expires_in_days: body.expires_in_days as number | null | undefined,
          created_by: String(claims.operator_id ?? claims.sub),
        });
        // The plaintext token is returned exactly once, with the base URL the device should call.
        return send(res, 201, { ...out, base_url: publicUrl(req, cfg) });
      }

      if (method === "GET" && path === "/api/v1/platform/sideloads") {
        await admin("host:read");
        return send(res, 200, {
          sideloads: await service.listSideloads(url.searchParams.get("host_id") ?? undefined),
        });
      }

      const sideloadDelete = /^\/api\/v1\/platform\/sideloads\/([^/]+)$/.exec(path);
      if (method === "DELETE" && sideloadDelete) {
        const claims = await admin("host:admin");
        return send(res, 200, {
          sideload: await service.deleteSideload(
            decodeURIComponent(sideloadDelete[1]),
            String(claims.operator_id ?? claims.sub),
          ),
        });
      }

      // ---- Sideload channel: a device calls these with its sdl_ token; the token is bound to one host
      const sideloadAuth = () =>
        service.authenticateSideload(bearer(req), req.socket.remoteAddress ?? undefined);
      const requireSideloadScope = (s: SideloadRow, scope: SideloadScope): void => {
        if (!s.scopes.includes(scope)) {
          throw new PcsError(
            403,
            "SIDELOAD_SCOPE_DENIED",
            `this sideload does not have the ${scope} permission`,
          );
        }
      };

      if (method === "GET" && path === "/api/v1/sideload/me") {
        const s = await sideloadAuth();
        const owner = await service.getHost(s.host_id);
        return send(res, 200, {
          sideload: s,
          host: {
            host_id: s.host_id,
            name: owner?.hostname ?? s.host_id,
            status: owner?.status ?? "UNKNOWN",
          },
        });
      }

      if (method === "GET" && path === "/api/v1/sideload/builders") {
        const s = await sideloadAuth();
        requireSideloadScope(s, "builders:read");
        return send(res, 200, await service.sideloadBuilders(s));
      }

      if (method === "GET" && path === "/api/v1/sideload/tasks") {
        const s = await sideloadAuth();
        requireSideloadScope(s, "tasks:read");
        return send(
          res,
          200,
          await service.proxySideloadRequest(s, "GET", "/v1/tasks", url.search, undefined),
        );
      }

      if (method === "POST" && path === "/api/v1/sideload/tasks") {
        const s = await sideloadAuth();
        requireSideloadScope(s, "tasks:write");
        const body = await readJson(req);
        // A console task runs a shell command on a builder; keep it behind its own permission.
        if (String(body.task_type ?? "").startsWith("task.console.")) {
          requireSideloadScope(s, "console:run");
        }
        const decision = await service.admitTask({
          source: "sideload",
          sourceId: s.sideload_id,
          actor: s.name,
          scopes: s.scopes,
          hostId: s.host_id,
          taskType: String(body.task_type ?? ""),
          target: { host_id: s.host_id },
        });
        if (!decision.allowed) {
          throw new PcsError(403, "ADMISSION_DENIED", decision.reason, {
            policy_version: decision.policyVersion,
          });
        }
        const requirements =
          body.requirements && typeof body.requirements === "object"
            ? (body.requirements as Record<string, unknown>)
            : {};
        const out = await service.proxySideloadRequest(s, "POST", "/v1/tasks", "", {
          ...body,
          requirements: { ...requirements, mandate: mandateRef(decision.mandate) },
        });
        const taskId = (out as { task_id?: unknown } | null)?.task_id;
        if (taskId) await service.attachMandateTask(decision.mandate.mandate_id, String(taskId));
        return send(res, 201, out);
      }

      // Input files: upload first, then reference the returned URLs in requirements.console.attachments
      // (or requirements.build.attachments). Any media type is stored verbatim.
      if (method === "POST" && path === "/api/v1/sideload/attachments") {
        const s = await sideloadAuth();
        requireSideloadScope(s, "tasks:write");
        const body = await readJson(req);
        return send(
          res,
          201,
          await service.createTaskAttachment({
            name: body.name,
            media_type: body.media_type,
            data_base64: body.data_base64,
          }),
        );
      }

      // Output files: list a task's artifacts, then download each by id.
      const sideloadTaskArtifacts = /^\/api\/v1\/sideload\/tasks\/([^/]+)\/artifacts$/.exec(path);
      if (method === "GET" && sideloadTaskArtifacts) {
        const s = await sideloadAuth();
        requireSideloadScope(s, "tasks:read");
        return send(
          res,
          200,
          await service.sideloadTaskArtifacts(s, decodeURIComponent(sideloadTaskArtifacts[1])),
        );
      }

      const sideloadArtifactDownload = /^\/api\/v1\/sideload\/artifacts\/([^/]+)\/download$/.exec(
        path,
      );
      if (method === "GET" && sideloadArtifactDownload) {
        const s = await sideloadAuth();
        requireSideloadScope(s, "tasks:read");
        const out = await service.sideloadArtifactDownload(
          s,
          decodeURIComponent(sideloadArtifactDownload[1]),
        );
        return sendRaw(res, 200, out.data, {
          "content-type": out.media_type,
          "content-disposition": contentDisposition(out.name),
          "x-artifact-sha256": out.sha256,
          "x-artifact-name": encodeURIComponent(out.name),
        });
      }

      const sideloadTaskEvents = /^\/api\/v1\/sideload\/tasks\/([^/]+)\/events$/.exec(path);
      if (method === "GET" && sideloadTaskEvents) {
        const s = await sideloadAuth();
        requireSideloadScope(s, "tasks:read");
        return send(
          res,
          200,
          await service.proxySideloadRequest(
            s,
            "GET",
            `/v1/tasks/${encodeURIComponent(decodeURIComponent(sideloadTaskEvents[1]))}/events`,
            url.search,
            undefined,
          ),
        );
      }

      const sideloadTaskAction = /^\/api\/v1\/sideload\/tasks\/([^/]+)\/(cancel|retry|answer)$/.exec(
        path,
      );
      if (method === "POST" && sideloadTaskAction) {
        const s = await sideloadAuth();
        requireSideloadScope(s, "tasks:write");
        const body = await readJson(req);
        return send(
          res,
          200,
          await service.proxySideloadRequest(
            s,
            "POST",
            `/v1/tasks/${encodeURIComponent(decodeURIComponent(sideloadTaskAction[1]))}/${sideloadTaskAction[2]}`,
            "",
            body,
          ),
        );
      }

      const sideloadTask = /^\/api\/v1\/sideload\/tasks\/([^/]+)$/.exec(path);
      if (method === "GET" && sideloadTask) {
        const s = await sideloadAuth();
        requireSideloadScope(s, "tasks:read");
        return send(
          res,
          200,
          await service.proxySideloadRequest(
            s,
            "GET",
            `/v1/tasks/${encodeURIComponent(decodeURIComponent(sideloadTask[1]))}`,
            url.search,
            undefined,
          ),
        );
      }

      if (method === "GET" && path === "/api/v1/sideload/queue") {
        const s = await sideloadAuth();
        requireSideloadScope(s, "queue:read");
        return send(
          res,
          200,
          await service.proxySideloadRequest(s, "GET", "/v1/queue/stats", url.search, undefined),
        );
      }

      // ---- Scheduler proxy: forward task requests to the scheduler (root or node) that owns the target instance
      const schedProxy = /^\/api\/v1\/platform\/schedulers\/([^/]+)\/proxy(\/.*)$/.exec(path);
      if (schedProxy && (method === "GET" || method === "POST")) {
        const claims = await admin(method === "GET" ? "deployment:read" : "deployment:write");
        // Artifact bytes are raw; the JSON proxy would corrupt them (and base64-bloat a 64 MiB file).
        const artifactDownload = /^\/v1\/artifacts\/([^/]+)\/download$/.exec(schedProxy[2]);
        if (method === "GET" && artifactDownload) {
          const out = await service.proxySchedulerArtifactDownload(
            decodeURIComponent(schedProxy[1]),
            decodeURIComponent(artifactDownload[1]),
          );
          return sendRaw(res, 200, out.data, {
            "content-type": out.media_type,
            "content-disposition": contentDisposition(out.name),
            "x-artifact-sha256": out.sha256,
            "x-artifact-name": encodeURIComponent(out.name),
          });
        }
        let body = method === "GET" ? undefined : await readJson(req);
        let mandateId: string | null = null;
        // Task creation carries a mandate: the immutable record of why this
        // source may create work, under which policy version.
        if (method === "POST" && /^\/v1\/tasks$/.test(schedProxy[2])) {
          const deploymentId = decodeURIComponent(schedProxy[1]);
          const dep = await service.getDeployment(deploymentId);
          const decision = await service.admitTask({
            source: "admin",
            sourceId: claims.account_id,
            actor: String(claims.operator_id ?? claims.sub),
            scopes: claims.scopes ?? [],
            hostId: dep?.host_id,
            taskType: String((body as { task_type?: unknown } | null)?.task_type ?? ""),
            target: { deployment_id: deploymentId },
          });
          if (!decision.allowed) {
            throw new PcsError(403, "ADMISSION_DENIED", decision.reason, {
              policy_version: decision.policyVersion,
            });
          }
          mandateId = decision.mandate.mandate_id;
          const req = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
          const requirements =
            req.requirements && typeof req.requirements === "object"
              ? (req.requirements as Record<string, unknown>)
              : {};
          body = {
            ...req,
            requirements: { ...requirements, mandate: mandateRef(decision.mandate) },
          };
        }
        const out = await service.proxySchedulerDeployment(
          decodeURIComponent(schedProxy[1]),
          method,
          schedProxy[2],
          url.search,
          body,
        );
        if (mandateId) {
          const taskId = (out as { task_id?: unknown } | null)?.task_id;
          if (taskId) await service.attachMandateTask(mandateId, String(taskId));
        }
        return send(res, 200, out);
      }

      // ---- Host onboarding (v4.1): SSH hosts and local hosts
      if (method === "POST" && path === "/api/v1/platform/hosts/ssh") {
        await admin("host:admin");
        const body = await readJson(req);
        const out = await service.createSshHost({
          name: body.name as string | undefined,
          address: String(body.address ?? ""),
          port: body.port as number | undefined,
          user: body.user as string | undefined,
          private_key: String(body.private_key ?? ""),
          password: String(body.password ?? ""),
          labels: body.labels as Record<string, unknown> | undefined,
        });
        return send(res, 201, out);
      }

      if (method === "POST" && path === "/api/v1/platform/hosts/local") {
        await admin("host:admin");
        const body = await readJson(req);
        return send(
          res,
          200,
          await service.createLocalHost({ name: body.name as string | undefined }),
        );
      }

      const hostProbe = /^\/api\/v1\/platform\/hosts\/([^/]+)\/probe$/.exec(path);
      if (method === "POST" && hostProbe) {
        await admin("host:admin");
        return send(res, 200, { probe: await service.probeHost(decodeURIComponent(hostProbe[1])) });
      }

      const hostBootstrap = /^\/api\/v1\/platform\/hosts\/([^/]+)\/bootstrap$/.exec(path);
      if (method === "POST" && hostBootstrap) {
        const claims = await admin("host:admin");
        const out = await service.bootstrapHost(
          decodeURIComponent(hostBootstrap[1]),
          String(claims.operator_id ?? claims.sub),
        );
        return send(res, out.online ? 200 : 202, out);
      }

      // Host merge / unmerge: only changes the federation tree; running schedulers are not restarted.
      const hostMerge = /^\/api\/v1\/platform\/hosts\/([^/]+)\/merge$/.exec(path);
      if (method === "POST" && hostMerge) {
        const claims = await admin("host:admin");
        const body = await readJson(req);
        return send(
          res,
          200,
          await service.mergeHost(
            decodeURIComponent(hostMerge[1]),
            String(body.parent_host_id ?? ""),
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      const hostUnmerge = /^\/api\/v1\/platform\/hosts\/([^/]+)\/unmerge$/.exec(path);
      if (method === "POST" && hostUnmerge) {
        const claims = await admin("host:admin");
        return send(
          res,
          200,
          await service.unmergeHost(
            decodeURIComponent(hostUnmerge[1]),
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      const hostDetail = /^\/api\/v1\/platform\/hosts\/([^/]+)$/.exec(path);
      if (method === "GET" && hostDetail) {
        await admin("host:read");
        const out = await service.getHostDetail(decodeURIComponent(hostDetail[1]));
        if (!out) throw new PcsError(404, "HOST_NOT_FOUND", "host not found");
        return send(res, 200, out);
      }

      // Update host access info: name, address, port, user, private key (leave blank to keep unchanged).
      if (method === "PATCH" && hostDetail) {
        const claims = await admin("host:admin");
        const body = await readJson(req);
        const out = await service.updateHost(
          decodeURIComponent(hostDetail[1]),
          {
            name: body.name as string | undefined,
            address: body.address as string | undefined,
            port: body.port as number | undefined,
            user: body.user as string | undefined,
            private_key: body.private_key as string | undefined,
            password: body.password as string | undefined,
            role_mode: body.role_mode as "containers" | "builder" | "scheduler" | undefined,
            native_builder: body.native_builder as
              | {
                  display_name?: string;
                  agent_profile_id?: string;
                  api_profile_ids?: string[];
                }
              | undefined,
          },
          String(claims.operator_id ?? claims.sub),
        );
        return send(res, 200, out);
      }

      // Delete the host record outright: containers must be removed first, otherwise HOST_HAS_DEPLOYMENTS is returned.
      if (method === "DELETE" && hostDetail) {
        const claims = await admin("host:admin");
        return send(
          res,
          200,
          await service.deleteHost(
            decodeURIComponent(hostDetail[1]),
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      const revoke = /^\/api\/v1\/platform\/hosts\/([^/]+)\/revoke$/.exec(path);
      if (method === "POST" && revoke) {
        const claims = await admin("host:admin");
        const out = await service.revokeHost(
          decodeURIComponent(revoke[1]),
          String(claims.operator_id ?? claims.sub),
        );
        return send(res, 200, out);
      }

      // Interactive root terminal: only exchanges a one-time ticket (30 seconds); the actual byte stream goes over a
      // WebSocket upgrade (see terminal.ts). The ticket never goes into the URL or the logs.
      if (method === "POST" && path === "/api/v1/platform/terminal-ticket") {
        const claims = await admin("deployment:read");
        const body = await readJson(req);
        const out = await issueTerminalTicket(
          service,
          body,
          String(claims.operator_id ?? claims.sub),
        );
        return send(res, 200, out);
      }

      // Workspace files: listing and deletion run as host commands (docker exec / ssh), downloads use
      // a one-time ticket because a browser navigation cannot send the Bearer token.
      const instanceFiles = /^\/api\/v1\/platform\/instances\/([^/]+)\/files$/.exec(path);
      if (instanceFiles) {
        const instanceId = decodeURIComponent(instanceFiles[1]);
        const hostId = url.searchParams.get("host_id")?.trim() ?? "";
        if (!hostId) throw new PcsError(400, "HOST_ID_REQUIRED", "host_id is required");
        const filePath = url.searchParams.get("path") ?? "";
        if (method === "GET") {
          await admin("host:read");
          return send(res, 200, await listInstanceFiles(service, hostId, instanceId, filePath));
        }
        if (method === "DELETE") {
          const claims = await admin("host:admin");
          return send(
            res,
            200,
            await deleteInstanceFile(
              service,
              hostId,
              instanceId,
              filePath,
              String(claims.operator_id ?? claims.sub),
            ),
          );
        }
      }

      const fileDownload = /^\/api\/v1\/platform\/instances\/([^/]+)\/files\/download$/.exec(path);
      if (method === "POST" && fileDownload) {
        await admin("host:read");
        const body = await readJson(req);
        const ticketHost = String(body.host_id ?? "").trim();
        if (!ticketHost) throw new PcsError(400, "HOST_ID_REQUIRED", "host_id is required");
        return send(
          res,
          200,
          await issueFileDownloadTicket(service, {
            host_id: ticketHost,
            instance_id: decodeURIComponent(fileDownload[1]),
            path: body.path,
          }),
        );
      }

      if (method === "GET" && path === "/api/v1/platform/files/download") {
        streamFileDownload(res, url);
        return;
      }

      if (method === "POST" && path === "/api/v1/platform/deployments") {
        const claims = await admin("deployment:write");
        const body = await readJson(req);
        const out = await service.createDeployment({
          ...(body as unknown as CreateDeploymentInput),
          created_by: String(claims.operator_id ?? claims.sub),
        });
        return send(res, 201, out);
      }

      if (method === "GET" && path === "/api/v1/platform/deployments") {
        await admin("deployment:read");
        return send(res, 200, {
          deployments: await service.listDeployments(url.searchParams.get("host_id") ?? undefined),
        });
      }

      const depGet = /^\/api\/v1\/platform\/deployments\/([^/]+)$/.exec(path);
      if (method === "GET" && depGet) {
        await admin("deployment:read");
        const dep = await service.getDeployment(decodeURIComponent(depGet[1]));
        if (!dep) throw new PcsError(404, "DEPLOYMENT_NOT_FOUND", "deployment not found");
        return send(res, 200, { deployment: dep });
      }

      const depFeatures = /^\/api\/v1\/platform\/deployments\/([^/]+)\/features$/.exec(path);
      if (method === "PATCH" && depFeatures) {
        const claims = await admin("deployment:write");
        const body = await readJson(req);
        const out = await service.updateDeploymentFeatures(
          decodeURIComponent(depFeatures[1]),
          {
            ssh_enabled: typeof body.ssh_enabled === "boolean" ? body.ssh_enabled : undefined,
            chat_enabled: typeof body.chat_enabled === "boolean" ? body.chat_enabled : undefined,
          },
          String(claims.operator_id ?? claims.sub),
        );
        return send(res, 200, { deployment: out });
      }

      const depAction = /^\/api\/v1\/platform\/deployments\/([^/]+)\/(start|stop|restart|remove)$/.exec(
        path,
      );
      if (method === "POST" && depAction) {
        const claims = await admin("deployment:write");
        const out = await service.enqueueAction(
          decodeURIComponent(depAction[1]),
          depAction[2] as "start" | "stop" | "restart" | "remove",
          String(claims.operator_id ?? claims.sub),
        );
        return send(res, 202, out);
      }

      // ---- Deployment plans (§4.6): preview generates plan_digest; apply recomputes it
      if (method === "POST" && path === "/api/v1/platform/deployment-plans") {
        const claims = await admin("deployment:write");
        const body = await readJson(req);
        return send(
          res,
          201,
          await service.previewDeploymentPlan(
            body as unknown as CreateDeploymentPlanInput,
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      const planApply = /^\/api\/v1\/platform\/deployment-plans\/([^/]+)\/apply$/.exec(path);
      if (method === "POST" && planApply) {
        const claims = await admin("deployment:write");
        const body = await readJson(req);
        return send(
          res,
          200,
          await service.applyDeploymentPlan(
            decodeURIComponent(planApply[1]),
            { plan_digest: String(body.plan_digest ?? "") },
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      // ---- Approval tokens (§5): MFA assertion + admin scope; tokens are never echoed to the logs
      if (method === "POST" && path === "/api/v1/platform/approval-tokens") {
        const claims = await admin("approval:issue");
        const body = await readJson(req);
        return send(
          res,
          201,
          await service.issueApprovalToken(body as unknown as ApprovalTokenInput, claims),
        );
      }

      // ---- Agent / API Profile (P4); the tables hold only references, no secret values
      if (method === "POST" && path === "/api/v1/platform/agent-profiles") {
        const claims = await admin("profile:write");
        const body = await readJson(req);
        return send(
          res,
          201,
          await service.createAgentProfile(
            body as unknown as CreateAgentProfileInput,
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      if (method === "GET" && path === "/api/v1/platform/agent-profiles") {
        await admin("profile:read");
        return send(res, 200, { agent_profiles: await service.listAgentProfiles() });
      }

      const agentProfileEdit = /^\/api\/v1\/platform\/agent-profiles\/([^/]+)$/.exec(path);
      if (method === "PATCH" && agentProfileEdit) {
        const claims = await admin("profile:write");
        const body = await readJson(req);
        return send(
          res,
          200,
          await service.updateAgentProfile(
            decodeURIComponent(agentProfileEdit[1]),
            body as unknown as Partial<CreateAgentProfileInput>,
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      if (method === "DELETE" && agentProfileEdit) {
        const claims = await admin("profile:write");
        return send(
          res,
          200,
          await service.deleteAgentProfile(
            decodeURIComponent(agentProfileEdit[1]),
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      if (method === "POST" && path === "/api/v1/platform/api-profiles") {
        const claims = await admin("profile:write");
        const body = await readJson(req);
        return send(
          res,
          201,
          await service.createApiProfile(
            body as unknown as CreateApiProfileInput,
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      if (method === "GET" && path === "/api/v1/platform/api-profiles") {
        await admin("profile:read");
        return send(res, 200, { api_profiles: await service.listApiProfiles() });
      }

      const apiProfileEdit = /^\/api\/v1\/platform\/api-profiles\/([^/]+)$/.exec(path);
      if (method === "PATCH" && apiProfileEdit) {
        const claims = await admin("profile:write");
        const body = await readJson(req);
        return send(
          res,
          200,
          await service.updateApiProfile(
            decodeURIComponent(apiProfileEdit[1]),
            body as unknown as Partial<CreateApiProfileInput>,
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      const apiProfileSecret = /^\/api\/v1\/platform\/api-profiles\/([^/]+)\/secret$/.exec(path);
      if (method === "PUT" && apiProfileSecret) {
        const claims = await admin("profile:write");
        const body = await readJson(req);
        return send(
          res,
          200,
          await service.setApiProfileSecret(
            decodeURIComponent(apiProfileSecret[1]),
            String(body.value ?? ""),
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      if (method === "DELETE" && apiProfileEdit) {
        const claims = await admin("profile:write");
        return send(
          res,
          200,
          await service.deleteApiProfile(
            decodeURIComponent(apiProfileEdit[1]),
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      if (method === "GET" && path === "/api/v1/platform/bindings") {
        await admin("profile:read");
        return send(res, 200, { bindings: await service.listBindings() });
      }

      // Instance names are unique only within a host: the binding endpoints must carry host_id, otherwise same-named instances would share bindings.
      const requireHostId = (raw: unknown): string => {
        const hostId = String(raw ?? "").trim();
        if (!hostId) {
          throw new PcsError(
            400,
            "HOST_ID_REQUIRED",
            "host_id is required: instance names are unique only within a host, so binding must specify a host",
          );
        }
        return hostId;
      };

      const bindAgent = /^\/api\/v1\/platform\/instances\/([^/]+)\/bind-agent$/.exec(path);
      if (method === "POST" && bindAgent) {
        const claims = await admin("profile:write");
        const body = await readJson(req);
        return send(
          res,
          200,
          await service.bindAgent(
            requireHostId(body.host_id),
            decodeURIComponent(bindAgent[1]),
            String(body.agent_profile_id ?? ""),
            String(body.role_id ?? ""),
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }
      if (method === "DELETE" && bindAgent) {
        const claims = await admin("profile:write");
        return send(
          res,
          200,
          await service.unbindAgent(
            requireHostId(url.searchParams.get("host_id")),
            decodeURIComponent(bindAgent[1]),
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      const bindApi = /^\/api\/v1\/platform\/instances\/([^/]+)\/bind-api$/.exec(path);
      if (method === "POST" && bindApi) {
        const claims = await admin("profile:write");
        const body = await readJson(req);
        return send(
          res,
          200,
          await service.bindApi(
            requireHostId(body.host_id),
            decodeURIComponent(bindApi[1]),
            String(body.api_profile_id ?? ""),
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      const unbindApi = /^\/api\/v1\/platform\/instances\/([^/]+)\/bind-api\/([^/]+)$/.exec(path);
      if (method === "DELETE" && unbindApi) {
        const claims = await admin("profile:write");
        return send(
          res,
          200,
          await service.unbindApi(
            requireHostId(url.searchParams.get("host_id")),
            decodeURIComponent(unbindApi[1]),
            decodeURIComponent(unbindApi[2]),
            String(claims.operator_id ?? claims.sub),
          ),
        );
      }

      const resolve = /^\/api\/v1\/platform\/instances\/([^/]+)\/resolve$/.exec(path);
      if (method === "GET" && resolve) {
        await admin("profile:read");
        const out = await service.resolveInstance(
          requireHostId(url.searchParams.get("host_id")),
          decodeURIComponent(resolve[1]),
        );
        if (!out) throw new PcsError(404, "BINDING_NOT_FOUND", "instance has no Agent binding");
        return send(res, 200, out);
      }

      if (method === "GET" && path === "/api/v1/platform/audit-logs") {
        const claims = await admin("audit:read");
        // Only account managers see everyone's history; everyone else sees their own.
        const ownOnly = claims.account_id && !(claims.scopes ?? []).includes("account:read");
        const accountId = ownOnly
          ? claims.account_id
          : url.searchParams.get("account_id") ?? undefined;
        return send(res, 200, {
          audit_logs: await service.listAudit(intParam(url.searchParams.get("limit"), 100), accountId),
        });
      }

      if (method === "GET" && path === "/api/v1/platform/policy") {
        await admin("audit:read");
        return send(res, 200, await service.getPolicy());
      }

      if (method === "GET" && path === "/api/v1/platform/mandates") {
        await admin("audit:read");
        return send(res, 200, {
          mandates: await service.listMandates(
            intParam(url.searchParams.get("limit"), 100),
            url.searchParams.get("task_id") ?? undefined,
          ),
        });
      }

      const mandateRevoke = /^\/api\/v1\/platform\/mandates\/([^/]+)\/revoke$/.exec(path);
      if (method === "POST" && mandateRevoke) {
        const claims = await admin("account:write");
        return send(res, 200, {
          mandate: await service.revokeMandate(
            decodeURIComponent(mandateRevoke[1]),
            String(claims.operator_id ?? claims.sub),
          ),
        });
      }

      // ---- Host Runtime channel
      if (method === "POST" && path === "/api/v1/platform/runtime/heartbeat") {
        const h = await host();
        const body = await readJson(req);
        return send(res, 200, await service.heartbeat(h, body));
      }

      if (method === "GET" && path === "/api/v1/platform/runtime/commands") {
        const h = await host();
        const wait = Math.max(0, Math.min(intParam(url.searchParams.get("wait"), 30), 60));
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });
        const cmd = await service.nextCommand(h.host_id, wait, controller.signal);
        if (!cmd) {
          res.writeHead(204);
          return res.end();
        }
        return send(res, 200, { command: cmd.payload });
      }

      const ack = /^\/api\/v1\/platform\/runtime\/commands\/([^/]+)\/ack$/.exec(path);
      if (method === "POST" && ack) {
        const h = await host();
        const body = await readJson(req);
        const out = await service.ackCommand(
          h.host_id,
          decodeURIComponent(ack[1]),
          body.ok !== false,
          (body.result ?? {}) as Record<string, unknown>,
        );
        return send(res, 200, out);
      }

      if (method === "POST" && path === "/api/v1/platform/runtime/report") {
        const h = await host();
        const body = await readJson(req);
        return send(res, 200, await service.storeReport(h, body));
      }

      if (method === "POST" && path === "/api/v1/platform/runtime/token/renew") {
        const h = await host();
        return send(res, 200, await service.renewHostToken(h));
      }

      // The built admin app, when configured; API routes above win.
      if (cfg.webDir && (await serveStatic(req, res, cfg.webDir, path))) return;

      send(res, 404, { error: { code: "NOT_FOUND", message: `no such endpoint: ${method} ${path}` } });
    } catch (e) {
      if (e instanceof PcsError) {
        send(res, e.status, {
          error: { code: e.code, message: e.message, detail: e.detail },
        });
      } else {
        console.error("[pcs]", e);
        // Return a constant message: internal error text can leak stack frames and file paths.
        send(res, 500, {
          error: { code: "INTERNAL", message: "Internal error" },
        });
      }
    }
  };

  if (!cfg.tlsCertFile) return http.createServer(handler);

  const options: https.ServerOptions = {
    cert: fs.readFileSync(cfg.tlsCertFile),
    key: fs.readFileSync(cfg.tlsKeyFile!),
  };
  if (cfg.tlsCaFile) options.ca = fs.readFileSync(cfg.tlsCaFile);
  if (cfg.requireClientCert) {
    // Only accept client certificates issued by the internal CA that have not expired; Bearer tokens are still checked separately.
    options.requestCert = true;
    options.rejectUnauthorized = true;
  }
  return https.createServer(options, handler);
}

function publicUrl(req: http.IncomingMessage, cfg: PcsConfig): string {
  if (cfg.publicUrl) return cfg.publicUrl.replace(/\/$/, "");
  const host = req.headers.host ?? `${cfg.host}:${cfg.port}`;
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const proto = forwarded || ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  return `${proto}://${host}`;
}
