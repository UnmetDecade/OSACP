#!/usr/bin/env node
/**
 * Local stand-in for the PCS: issues scheduler-side tokens (instance / approval) and management-plane admin tokens.
 *
 * Usage:
 *   npm run issue -- instance --id builder-a --role builder --host host-a \
 *        [--scopes instance:register,instance:claim,task:report,config:read,artifact:write,artifact:read] \
 *        [--hours 24] [--out /path/builder-a.jwt]
 *
 *   npm run issue -- approval --request aprq_xxx --operator alice \
 *        --digest sha256:... [--scope svn.commit] [--minutes 10] [--out /tmp/approval.jwt]
 *
 *   npm run issue -- admin --operator alice [--hours 8] [--out /tmp/admin.jwt]
 *
 * The token is written to --out or stdout. Private keys are never printed or logged.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ADMIN_SCOPES, ISSUER, SCHEDULER_AUDIENCE, signJwt } from "./jwt.js";
import { loadConfig, readKey } from "./config.js";

const DEFAULT_INSTANCE_SCOPES = [
  "instance:register",
  "instance:claim",
  "task:report",
  "config:read",
  "artifact:write",
  "artifact:read",
];

function parse(argv: string[]): { command: string; opts: Record<string, string> } {
  const [command, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k?.startsWith("--")) throw new Error(`unable to parse argument: ${k}`);
    opts[k.slice(2)] = rest[i + 1];
  }
  return { command, opts };
}

function need(opts: Record<string, string>, key: string): string {
  const v = opts[key];
  if (!v) throw new Error(`missing --${key}`);
  return v;
}

function emit(token: string, out?: string): void {
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, token + "\n", { mode: 0o600 });
    console.error(`Wrote ${out}`);
  } else {
    console.log(token);
  }
}

function main(): void {
  const { command, opts } = parse(process.argv.slice(2));
  const cfg = loadConfig();
  const privateKey = readKey(opts.key ?? cfg.jwtPrivateKeyFile);
  const now = Math.floor(Date.now() / 1000);

  if (command === "instance") {
    const scopes = (opts.scopes ?? DEFAULT_INSTANCE_SCOPES.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const exp = now + Number(opts.hours ?? 24) * 3600;
    const claims = {
      iss: ISSUER,
      aud: SCHEDULER_AUDIENCE,
      sub: need(opts, "id"),
      role: opts.role ?? null,
      host_id: opts.host ?? null,
      scopes,
      iat: now,
      exp,
      jti: `tok_${randomUUID()}`,
    };
    emit(signJwt(claims, privateKey), opts.out);
    console.error(`Instance token: sub=${claims.sub} valid until ${new Date(exp * 1000).toISOString()}`);
    return;
  }

  if (command === "approval") {
    const exp = now + Number(opts.minutes ?? 10) * 60;
    const claims = {
      iss: ISSUER,
      aud: SCHEDULER_AUDIENCE,
      sub: `operator:${need(opts, "operator")}`,
      typ: "approval",
      approval_request_id: need(opts, "request"),
      operator_id: need(opts, "operator"),
      subject_digest: opts.digest ?? null,
      action_scope: (opts.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      scopes: ["approval:decide"],
      iat: now,
      exp,
      jti: `tok_${randomUUID()}`,
    };
    emit(signJwt(claims, privateKey), opts.out);
    console.error(`Approval token: request=${claims.approval_request_id} valid until ${new Date(exp * 1000).toISOString()}`);
    return;
  }

  if (command === "admin") {
    const operator = need(opts, "operator");
    const hours = Number(opts.hours ?? 8);
    const scopes = (opts.scopes ?? ADMIN_SCOPES.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const exp = now + hours * 3600;
    const claims = {
      iss: ISSUER,
      aud: "platform-control",
      sub: `operator:${operator}`,
      typ: "admin",
      operator_id: operator,
      scopes,
      iat: now,
      exp,
      jti: `tok_${randomUUID()}`,
    };
    emit(signJwt(claims, privateKey), opts.out);
    console.error(`Admin token: operator=${operator} valid until ${new Date(exp * 1000).toISOString()}`);
    return;
  }

  console.error("Usage: issue.ts instance|approval|admin [--key value ...]");
  process.exit(1);
}

main();
