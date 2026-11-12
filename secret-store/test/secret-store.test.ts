import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { SecretStore } from "../src/store.js";
import { verifyInstanceToken } from "../src/verify.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "secret-test-"));
const secretsFile = path.join(tmp, "secrets.json");
const policyFile = path.join(tmp, "policy.json");
let store: SecretStore;

before(() => {
  fs.writeFileSync(secretsFile, JSON.stringify({ "secret://apis/mock": "s3cr3t-value" }), { mode: 0o600 });
  fs.writeFileSync(
    policyFile,
    JSON.stringify({ "worker-a": ["secret://apis/mock"], "worker-b": ["secret://apis/other"] }),
    { mode: 0o600 },
  );
  store = new SecretStore({ secretsFile, policyFile, ttlSeconds: 300 });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("同一实例只能解析绑定给自己的 secret_ref", () => {
  const out = store.resolve("worker-a", "secret://apis/mock");
  assert.equal(out.credential, "s3cr3t-value");
  assert.ok(Date.parse(out.expires_at) > Date.now());

  assert.throws(
    () => store.resolve("worker-b", "secret://apis/mock"),
    (e: any) => e.code === "SECRET_NOT_ALLOWED",
  );
  assert.throws(
    () => store.resolve("worker-a", "secret://apis/other"),
    (e: any) => e.code === "SECRET_NOT_ALLOWED",
  );
});

test("吊销后立即拒绝解析", () => {
  store.revoke("worker-b");
  assert.throws(
    () => store.resolve("worker-b", "secret://apis/other"),
    (e: any) => e.code === "INSTANCE_REVOKED",
  );
});

test("轮换 secrets 文件后下一次解析立即生效", () => {
  fs.writeFileSync(secretsFile, JSON.stringify({ "secret://apis/mock": "rotated-value" }), { mode: 0o600 });
  assert.equal(store.resolve("worker-a", "secret://apis/mock").credential, "rotated-value");
});

test("管理面写入的平台级密钥对所有实例可解析，值只落文件", () => {
  store.put("secret://apis/console-key", "sk-console-123");
  assert.equal(store.resolve("worker-a", "secret://apis/console-key").credential, "sk-console-123");
  assert.equal(store.resolve("worker-c", "secret://apis/console-key").credential, "sk-console-123");
  const saved = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
  assert.equal(saved["secret://apis/console-key"], "sk-console-123");
  assert.equal(fs.statSync(secretsFile).mode & 0o077, 0);
  assert.throws(() => store.put("sk-plaintext", "x"), (e: any) => e.code === "SECRET_REF_INVALID");
  assert.throws(() => store.put("secret://apis/x", "a\nb"), (e: any) => e.code === "SECRET_VALUE_INVALID");
});

test("权限过宽的文件拒绝加载", () => {
  const loose = path.join(tmp, "loose.json");
  fs.writeFileSync(loose, "{}", { mode: 0o644 });
  fs.chmodSync(loose, 0o644);
  assert.throws(() => new SecretStore({ secretsFile: loose, policyFile }), /权限过宽/);
});

test("实例 JWT：验签、受众、sub", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "worker-a", aud: "scheduler", exp: now + 60 }),
  ).toString("base64url");
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const token = `${header}.${payload}.${sig}`;
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifyInstanceToken(token, pem, "scheduler").sub, "worker-a");
  assert.throws(() => verifyInstanceToken(token, pem, "host-runtime"), /受众/);
  assert.throws(() => verifyInstanceToken(`${token}x`, pem, "scheduler"), /签名/);
});
