/**
 * P6 transport-layer smoke test: use Host Runtime's PcsClient over HTTPS + mTLS.
 *
 * Usage:
 *   PCS_URL=https://127.0.0.1:7911 \
 *   PCS_CA_FILE=pki/ca.crt PCS_CLIENT_CERT_FILE=pki/client.crt PCS_CLIENT_KEY_FILE=pki/client.key \
 *   P6_ENROLLMENT_TOKEN=... tsx p6-tls-smoke.ts
 *
 * The token is read only from the environment; tokens and certificate contents are never printed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { PcsClient } from "../src/pcs-client.js";

const url = process.env.PCS_URL ?? "";
const token = process.env.P6_ENROLLMENT_TOKEN ?? "";
if (!url || !token) throw new Error("缺少 PCS_URL / P6_ENROLLMENT_TOKEN");

const client = new PcsClient(url, 10_000, undefined, {
  caFile: process.env.PCS_CA_FILE,
  certFile: process.env.PCS_CLIENT_CERT_FILE,
  keyFile: process.env.PCS_CLIENT_KEY_FILE,
});

const enrolled = await client.enroll({
  enrollment_token: token,
  hostname: "p6-tls-host",
  os: "linux",
  arch: "x64",
  fingerprint: "fp-p6-tls",
  container_runtime: "docker",
  runtime_version: "0.6.0-p6",
  resources: {
    cpu_count: 4,
    cpu_usage: 0.1,
    mem_total_bytes: 4 * 1024 ** 3,
    mem_available_bytes: 3 * 1024 ** 3,
    disk: [{ fs: "root", total_bytes: 100 * 1024 ** 3, free_bytes: 50 * 1024 ** 3 }],
  },
  devices: [],
  tools: ["docker", "node22"],
});
assert.match(enrolled.host_id, /^hst_/);
assert.ok(enrolled.host_token);
assert.ok(enrolled.command_public_key.includes("BEGIN PUBLIC KEY"));

client.setToken(enrolled.host_token);
await client.report({
  host_state: "NORMAL",
  runtime: {
    version: "0.6.0-p6",
    container_runtime: "docker",
    capabilities: { docker: true },
    healthy: true,
  },
  resources: {
    cpu_count: 4,
    cpu_usage: 0.1,
    mem_total_bytes: 4 * 1024 ** 3,
    mem_available_bytes: 3 * 1024 ** 3,
    disk: [{ fs: "root", total_bytes: 100 * 1024 ** 3, free_bytes: 50 * 1024 ** 3 }],
  },
  containers: [],
});
await client.heartbeat({ host_state: "NORMAL", runtime_healthy: true });

const renewed = await client.renewToken();
assert.ok(renewed.host_token);
assert.ok(Date.parse(renewed.expires_at) > Date.now());

const command = await client.nextCommand(1);
assert.equal(command, null);

// Write only a 0600 identity file for reuse by reconnect tests; never print the token.
const stateFile = process.env.P6_STATE_FILE;
if (stateFile) {
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ host_id: enrolled.host_id, host_token: renewed.host_token, expires_at: renewed.expires_at }),
    { mode: 0o600 },
  );
}

console.log(`ok - HTTPS+mTLS enroll/report/renew，host=${enrolled.host_id}`);
