import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";
import {
  CommandRejected,
  canonicalJson,
  generationDecision,
  validateCommand,
  type CommandPayload,
  type InstanceSpec,
} from "../src/command-verify.js";
import { buildContainerConfig } from "../src/container-spec.js";
import type { RuntimeHostConfig } from "../src/runtime-config.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const hostId = "hst_test";
const DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE = `registry.test/platform/worker@${DIGEST}`;
const now = Date.now();

function spec(overrides: Partial<InstanceSpec> = {}): InstanceSpec {
  return {
    instance_id: "ins_test",
    role_id: "builder",
    display_name: "builder",
    image: IMAGE,
    resource_profile: {
      cpu_limit: 0.5,
      memory_limit_bytes: 256 * 1024 ** 2,
      pids_limit: 128,
      io_weight: 500,
    },
    env: { ROLE_ID: "builder" },
    volumes: [{ name: "workspace", mount: "/opt/platform/workspace" }],
    network_policy: "default",
    config_version: 1,
    command: ["sleep", "3600"],
    ...overrides,
  };
}

function signPayload(unsigned: Omit<CommandPayload, "signature">): CommandPayload {
  const sig = sign(null, Buffer.from(canonicalJson(unsigned)), privateKey as KeyObject);
  return { ...unsigned, signature: `ed25519:${sig.toString("base64url")}` };
}

function command(overrides: Partial<Omit<CommandPayload, "signature">> = {}): CommandPayload {
  return signPayload({
    command_id: "cmd_test",
    command_type: "DEPLOY",
    host_id: hostId,
    deployment_id: "dep_test",
    instance_id: "ins_test",
    generation: 1,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    resource_grant: {
      grant_id: "rgr_test",
      kind: "DEPLOYMENT",
      cpu_limit: 0.5,
      memory_limit_bytes: 256 * 1024 ** 2,
    },
    instance: spec(),
    ...overrides,
  });
}

const opts = {
  publicKeyPem,
  hostId,
  allowlist: ["registry.test/"],
  networkPolicies: { default: "bridge" },
  nowMs: now,
};

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof CommandRejected && e.code === code);
}

test("合法签名命令通过", () => {
  const ok = validateCommand(command(), opts);
  assert.equal(ok.command_id, "cmd_test");
  assert.equal(ok.instance?.image, IMAGE);
});

test("签名后篡改任何字段都失效", () => {
  const signed = command();
  const tampered = { ...signed, generation: 2 };
  expectCode(() => validateCommand(tampered, opts), "COMMAND_SIGNATURE_INVALID");

  const badSig = { ...signed, signature: "ed25519:AQID" };
  expectCode(() => validateCommand(badSig, opts), "COMMAND_SIGNATURE_INVALID");
});

test("命令必须发给本主机且未过期", () => {
  expectCode(() => validateCommand(command({ host_id: "hst_other" }), opts), "COMMAND_WRONG_HOST");
  expectCode(
    () =>
      validateCommand(
        command({ expires_at: new Date(now - 10_000).toISOString() }),
        opts,
      ),
    "COMMAND_EXPIRED",
  );
  expectCode(
    () => validateCommand(command({ issued_at: new Date(now + 120_000).toISOString() }), opts),
    "COMMAND_CLOCK_SKEW",
  );
});

test("镜像必须固定 digest 且在白名单内", () => {
  expectCode(
    () => validateCommand(command({ instance: spec({ image: "registry.test/platform/worker:latest" }) }), opts),
    "IMAGE_NOT_PINNED",
  );
  expectCode(
    () => validateCommand(command({ instance: spec({ image: `evil.test/worker@${DIGEST}` }) }), opts),
    "IMAGE_NOT_ALLOWED",
  );
  expectCode(
    () => validateCommand(command(), { ...opts, allowlist: [] }),
    "IMAGE_NOT_ALLOWED",
  );
});

test("网络策略、env 凭据、卷挂载和 command 参数逐项校验", () => {
  expectCode(
    () => validateCommand(command({ instance: spec({ network_policy: "host" }) }), opts),
    "NETWORK_POLICY_NOT_ALLOWED",
  );
  expectCode(
    () => validateCommand(command({ instance: spec({ env: { GIT_TOKEN: "x" } }) }), opts),
    "SECRET_IN_ENVELOPE",
  );
  expectCode(
    () =>
      validateCommand(
        command({ instance: spec({ volumes: [{ name: "workspace", mount: "/etc" }] }) }),
        opts,
      ),
    "INVALID_VOLUME",
  );
  expectCode(
    () =>
      validateCommand(
        command({ instance: spec({ volumes: [{ name: "workspace", mount: "/opt/platform/../etc" }] }) }),
        opts,
      ),
    "INVALID_VOLUME",
  );
  expectCode(
    () => validateCommand(command({ instance: spec({ command: [] }) }), opts),
    "INVALID_COMMAND",
  );
  expectCode(
    () => validateCommand(command({ instance: spec({ command: ["sh", 5 as unknown as string] }) }), opts),
    "INVALID_COMMAND",
  );
});

test("DEPLOY 必须有 rgr_ grant，generation 必须为正", () => {
  expectCode(
    () =>
      validateCommand(
        command({ resource_grant: { grant_id: "gr_x", kind: "DEPLOYMENT", cpu_limit: 0.5, memory_limit_bytes: 1 } }),
        opts,
      ),
    "INVALID_GRANT",
  );
  expectCode(() => validateCommand(command({ generation: 0 }), opts), "INVALID_GENERATION");
});

test("非 DEPLOY 命令不要求实例规格", () => {
  const stop = command({
    command_type: "STOP",
    instance: null,
    resource_grant: null,
  });
  assert.equal(validateCommand(stop, opts).command_type, "STOP");
});

test("generation 单调：小于等于已应用值即 STALE", () => {
  assert.equal(generationDecision(command({ generation: 3 }), undefined), "APPLY");
  assert.equal(generationDecision(command({ generation: 3 }), 3), "STALE");
  assert.equal(generationDecision(command({ generation: 2 }), 3), "STALE");
  assert.equal(generationDecision(command({ generation: 4 }), 3), "APPLY");
});

test("容器配置：root + 可写根 + 完整权限，但仍不使用 host 网络 / Binds", () => {
  const cfg = {
    network_policies: { default: "bridge" },
  } as unknown as RuntimeHostConfig;
  const config = buildContainerConfig(
    {
      deployment_id: "dep_test",
      grant_id: "rgr_test",
      host_id: hostId,
      instance: spec(),
    },
    cfg,
  );
  const hc = config.HostConfig as Record<string, any>;
  assert.equal(config.User, "0:0");
  assert.equal(hc.ReadonlyRootfs, false);
  assert.equal(hc.Privileged, false);
  assert.deepEqual(hc.CapDrop, []);
  assert.deepEqual(hc.CapAdd, ["ALL"]);
  assert.equal(hc.SecurityOpt, undefined);
  assert.equal(hc.NetworkMode, "bridge");
  assert.equal(hc.Init, true);
  assert.equal(hc.OomKillDisable, false);
  assert.ok(hc.NanoCpus > 0);
  assert.equal(hc.Memory, 256 * 1024 ** 2);
  assert.equal(hc.MemorySwap, hc.Memory);
  assert.equal(hc.Binds, undefined);
  assert.equal(hc.Mounts.length, 1);
  assert.equal(hc.Mounts[0].Type, "volume");
  assert.equal(hc.Mounts[0].Target, "/opt/platform/workspace");
  assert.equal(hc.LogConfig.Config["max-size"], "50m");
  assert.equal((config.Labels as Record<string, string>)["platform.managed"], "true");
  assert.equal(JSON.stringify(config).includes("docker.sock"), false);

  assert.throws(
    () =>
      buildContainerConfig(
        { deployment_id: "dep", grant_id: "rgr", host_id: hostId, instance: spec() },
        { network_policies: { default: "host" } } as unknown as RuntimeHostConfig,
      ),
    /不安全的网络模式/,
  );
});

test("SSH 端口映射进入容器配置，非法端口在验签阶段拒绝", () => {
  const cfg = { network_policies: { default: "bridge" } } as unknown as RuntimeHostConfig;
  const withPorts = command({
    instance: {
      ...spec(),
      ports: [
        { container: 2222, host: 2222 },
        { container: 8080, host: 18080 },
      ],
    },
  });
  assert.deepEqual(validateCommand(withPorts, opts).instance?.ports, [
    { container: 2222, host: 2222 },
    { container: 8080, host: 18080 },
  ]);
  const config = buildContainerConfig(
    { deployment_id: "dep", grant_id: "rgr", host_id: hostId, instance: withPorts.instance! },
    cfg,
  );
  assert.deepEqual(config.ExposedPorts, { "2222/tcp": {}, "8080/tcp": {} });
  assert.deepEqual((config.HostConfig as any).PortBindings, {
    "2222/tcp": [{ HostPort: "2222" }],
    "8080/tcp": [{ HostPort: "18080" }],
  });

  for (const ports of [
    [{ container: 2222, host: 0 }],
    [{ container: 2222, host: 70000 }],
    [
      { container: 2222, host: 2222 },
      { container: 2222, host: 2223 },
    ],
    [
      { container: 2222, host: 2222 },
      { container: 2223, host: 2222 },
    ],
  ]) {
    assert.throws(
      () =>
        validateCommand(
          command({ instance: { ...spec(), ports: ports as any } }),
          opts,
        ),
      /端口映射/,
    );
  }
});
