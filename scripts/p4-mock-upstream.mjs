#!/usr/bin/env node
/**
 * P4 验收用的外部 API 替身。
 *
 * - 只接受 API Adapter 注入的 Bearer 凭据；Agent 直连会得到 401。
 * - 日志只写“认证是否通过”，不写凭据原文。
 */
import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.MOCK_API_PORT ?? 18090);
const expected = process.env.MOCK_API_EXPECTED_TOKEN ?? "";
const logFile = process.env.MOCK_API_LOG ?? "/tmp/p4-mock-api.log";

function log(record) {
  fs.appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, {
    mode: 0o600,
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const auth = req.headers.authorization ?? "";
    const ok = Boolean(expected) && auth === `Bearer ${expected}`;
    log({ path: url.pathname, method: req.method, auth_ok: ok, has_authorization: Boolean(auth) });
    if (!ok) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (url.pathname === "/whoami") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: "p4-mock-upstream", auth_ok: true, instance_hint: "via-api-adapter" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: url.pathname }));
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`[p4-mock-upstream] 127.0.0.1:${port}（只记录 auth_ok）`);
  });
