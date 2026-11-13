import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AuditChain } from "../src/audit-chain.js";
import { OperationJournal } from "../src/journal.js";
import { HostPolicyGate } from "../src/policy.js";

/**
 * The three host-local tripwires: an audit log that can prove it was not edited, an operator veto
 * that outranks the control plane, and a journal that undoes interrupted mutations.
 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "host-controls-"));
}

// ---------------- audit chain

test("audit: records verify and the hash covers content and order", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "audit.jsonl");
    const chain = new AuditChain(file);
    chain.append("command.result", { command_id: "c1", ok: true });
    chain.append("command.result", { command_id: "c2", ok: false });

    const verified = new AuditChain(file).verify();
    assert.equal(verified.ok, true);
    assert.equal(verified.records, 2);

    // Editing a record breaks its hash.
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const first = JSON.parse(lines[0]);
    first.ok = false;
    lines[0] = JSON.stringify(first);
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const broken = new AuditChain(file).verify();
    assert.equal(broken.ok, false);
    assert.equal(broken.broken_at, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("audit: deleting a record is a sequence gap, not a shorter log", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "audit.jsonl");
    const chain = new AuditChain(file);
    for (let i = 0; i < 3; i++) chain.append("probe", { i });
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    fs.writeFileSync(file, `${lines[0]}\n${lines[2]}\n`);
    const broken = new AuditChain(file).verify();
    assert.equal(broken.ok, false);
    // The surviving third record no longer chains to the first, so the break is reported there.
    assert.equal(broken.broken_at, 3);
    assert.match(String(broken.reason), /hash does not match/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("audit: secrets are redacted before they reach the file", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "audit.jsonl");
    new AuditChain(file).append("command.received", {
      note: "token=sk-live-abcdef123456",
      nested: { authorization: "Bearer abc.def.ghi" },
    });
    const raw = fs.readFileSync(file, "utf8");
    assert.equal(raw.includes("sk-live-abcdef123456"), false);
    assert.equal(raw.includes("abc.def.ghi"), false);
    assert.equal(raw.includes("<redacted>"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- local policy

function writePolicy(dir: string, policy: unknown, mode = 0o600): string {
  const file = path.join(dir, "host-policy.json");
  fs.writeFileSync(file, JSON.stringify(policy));
  fs.chmodSync(file, mode);
  return file;
}

test("policy: no file means no local veto", () => {
  const gate = new HostPolicyGate(path.join(tmp(), "missing.json"));
  const decision = gate.check({ action: "DEPLOY", role_id: "builder", image: "x" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.source, "absent");
});

test("policy: the kill switch stops new work", () => {
  const dir = tmp();
  try {
    const gate = new HostPolicyGate(writePolicy(dir, { version: 1, kill_switch: true }));
    assert.equal(gate.check({ action: "DEPLOY", role_id: "builder", image: "x" }).allowed, false);
    assert.equal(gate.check({ action: "START", role_id: "builder", image: "x" }).reason, "HOST_KILL_SWITCH");
    // A veto must not be able to trap a running container on the host.
    assert.equal(gate.check({ action: "STOP" }).allowed, true);
    assert.equal(gate.check({ action: "REMOVE" }).allowed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("policy: an unreadable policy fails closed", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "host-policy.json");
    fs.writeFileSync(file, "{not json");
    const gate = new HostPolicyGate(file);
    const decision = gate.check({ action: "DEPLOY", role_id: "builder", image: "x" });
    assert.equal(decision.allowed, false);
    assert.match(String(decision.reason), /POLICY_UNREADABLE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("policy: a policy anyone can rewrite is not trusted", () => {
  const dir = tmp();
  try {
    const gate = new HostPolicyGate(writePolicy(dir, { version: 1, deploy: true }, 0o666));
    const decision = gate.check({ action: "DEPLOY", role_id: "builder", image: "x" });
    assert.equal(decision.allowed, false);
    assert.match(String(decision.reason), /POLICY_UNTRUSTED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("policy: role, image prefix and deployment count are enforced", () => {
  const dir = tmp();
  try {
    const gate = new HostPolicyGate(
      writePolicy(dir, {
        version: 1,
        allowed_roles: ["builder"],
        denied_image_prefixes: ["registry.bad/"],
        max_deployments: 2,
      }),
    );
    assert.equal(gate.check({ action: "DEPLOY", role_id: "builder", image: "ok/img@sha256:aa" }).allowed, true);
    assert.equal(
      gate.check({ action: "DEPLOY", role_id: "scheduler", image: "ok/img@sha256:aa" }).reason,
      "POLICY_ROLE_NOT_ALLOWED",
    );
    assert.equal(
      gate.check({ action: "DEPLOY", role_id: "builder", image: "registry.bad/img@sha256:aa" }).reason,
      "POLICY_IMAGE_DENIED",
    );
    assert.equal(
      gate.check({ action: "DEPLOY", role_id: "builder", image: "ok/img@sha256:aa", active_deployments: 2 }).reason,
      "POLICY_MAX_DEPLOYMENTS",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- operation journal

test("journal: open operations survive a restart and closed ones do not", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "journal.jsonl");
    const first = new OperationJournal(file);
    const applied = first.begin("txn_1", "CONTAINER_CREATE", "c-1", { deployment_id: "d1" });
    first.applied(applied);
    const committed = first.begin("txn_1", "CONTAINER_START", "c-1", {});
    first.applied(committed);
    first.commit(committed);

    const reopened = new OperationJournal(file);
    const pending = reopened.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, "CONTAINER_CREATE");
    assert.equal(pending[0].target, "c-1");
    assert.equal(pending[0].detail.deployment_id, "d1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: a torn final line does not lose the rest of the log", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "journal.jsonl");
    const journal = new OperationJournal(file);
    journal.begin("txn_1", "CONTAINER_CREATE", "c-1");
    fs.appendFileSync(file, '{"op_id":"torn","phase":"BEG');
    const reopened = new OperationJournal(file);
    assert.equal(reopened.pending().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

