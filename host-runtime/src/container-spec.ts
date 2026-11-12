import fs from "node:fs";
import path from "node:path";
import type { InstanceSpec } from "./command-verify.js";
import type { RuntimeHostConfig } from "./runtime-config.js";

/** 主机缓存在容器内的固定挂载点。 */
export const CACHE_MOUNT = "/opt/platform/cache";

export interface ContainerSpecInput {
  deployment_id: string;
  grant_id: string;
  host_id: string;
  instance: InstanceSpec;
}

export function containerName(instanceId: string): string {
  return `platform-${instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48)}`;
}

export function volumeName(instanceId: string, name: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "-");
  // shared- 前缀表示同一主机上所有实例共用（例如 apt 的 deb 缓存）：
  // 卷名不带实例前缀，构建机之间复用已下载的包，但不共享各自的环境。
  if (name.startsWith("shared-")) return `platform-${safe(name)}`;
  return `platform-${safe(instanceId)}-${safe(name)}`;
}

/**
 * v4 容器规范：研发容器默认 root + 可写根 + 完整 Capability，SSH 进来就是完全权限。
 * 隔离边界不再是容器内的权限收缩，而是：
 *   * 容器边界（不是宿主机进程）；
 *   * CPU / 内存 / PID / IO 资源限额；
 *   * 无 Docker Socket、无宿主机路径（只用命名卷 Mounts）；
 *   * 网络策略（host / container 网络仍拒绝）。
 * 这样构建机能 apt install、跑任意工具链，SSH 也能直接改系统配置。
 */
export function buildContainerConfig(
  input: ContainerSpecInput,
  cfg: RuntimeHostConfig,
  /** 主机本地凭据文件里解析出来的值；同名变量以这里为准。 */
  agentEnv: Record<string, string> = {},
): Record<string, unknown> {
  const spec = input.instance;
  const profile = spec.resource_profile;
  const networkMode = cfg.network_policies[spec.network_policy] ?? "bridge";
  if (networkMode === "host" || networkMode.startsWith("container:")) {
    throw new Error(`网络策略 ${spec.network_policy} 映射到了不安全的网络模式 ${networkMode}`);
  }

  const mounts: Array<Record<string, unknown>> = (spec.volumes ?? []).map((v) => ({
    Type: "volume",
    Source: volumeName(spec.instance_id, v.name),
    Target: v.mount,
    ReadOnly: false,
  }));
  // 运行环境（Node / Agent CLI / deb 包）放在主机缓存里，只读挂进容器：
  // 镜像保持为纯 OS，升级运行时不用重建镜像，也不用每台主机重新下载。
  if (cfg.cache_dir) {
    mounts.unshift({
      Type: "bind",
      Source: cfg.cache_dir,
      Target: CACHE_MOUNT,
      ReadOnly: true,
      BindOptions: { Propagation: "rprivate" },
    });
  }

  const mergedEnv: Record<string, string> = { ...(spec.env ?? {}), ...agentEnv };
  // 容器 sshd 只允许密钥登录；默认把主机上已有的登录公钥注入进去，
  // 能登录这台主机的人就能直接 root 进容器。部署方显式给了公钥则不覆盖。
  if (!mergedEnv.SSH_AUTHORIZED_KEY) {
    const keys = hostAuthorizedKeys(cfg);
    if (keys) mergedEnv.SSH_AUTHORIZED_KEY = keys;
  }
  const env = Object.keys(mergedEnv)
    .sort()
    .map((k) => `${k}=${mergedEnv[k]}`);

  const hostConfig: Record<string, unknown> = {
    NanoCpus: Math.round(profile.cpu_limit * 1e9),
    Memory: Math.round(profile.memory_limit_bytes),
    // 禁止无界 swap：MemorySwap = Memory 即关闭 swap
    MemorySwap: Math.round(profile.memory_limit_bytes),
    PidsLimit: Number(profile.pids_limit ?? 512),
    BlkioWeight: Number(profile.io_weight ?? 500),
    ReadonlyRootfs: false,
    Tmpfs: {
      "/tmp": "rw,size=256m",
      "/run": "rw,size=64m",
    },
    CapDrop: [],
    CapAdd: ["ALL"],
    Privileged: false,
    NetworkMode: networkMode,
    RestartPolicy: { Name: "unless-stopped" },
    LogConfig: { Type: "json-file", Config: { "max-size": "50m", "max-file": "5" } },
    Mounts: mounts,
    OomKillDisable: false,
    Init: true,
  };
  if (profile.memory_reservation_bytes) {
    hostConfig.MemoryReservation = Math.round(profile.memory_reservation_bytes);
  }

  const ports = spec.ports ?? [];
  const config: Record<string, unknown> = {
    Image: spec.image,
    User: "0:0",
    Env: env,
    Labels: {
      "platform.managed": "true",
      "platform.host_id": input.host_id,
      "platform.deployment_id": input.deployment_id,
      "platform.grant_id": input.grant_id,
      "platform.instance_id": spec.instance_id,
      "platform.role_id": spec.role_id,
    },
    HostConfig: hostConfig,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
  };
  if (ports.length) {
    const bindings: Record<string, Array<{ HostPort: string }>> = {};
    for (const p of ports) bindings[`${p.container}/tcp`] = [{ HostPort: String(p.host) }];
    config.ExposedPorts = Object.fromEntries(ports.map((p) => [`${p.container}/tcp`, {}]));
    hostConfig.PortBindings = bindings;
  }
  if (spec.command?.length) config.Cmd = spec.command;
  return config;
}

/**
 * 收集主机上的登录公钥（authorized_keys + ~/.platform/keys/*.pub）。
 * 只接受合法公钥行：容器里 root 权限完全开放，不能把任意文本写进
 * authorized_keys。返回空串表示主机还没有可用公钥，容器只能用 PCS 终端进入。
 */
function hostAuthorizedKeys(cfg: RuntimeHostConfig): string {
  const lines: string[] = [];
  const collect = (text: string) => {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-(ssh-ed25519|ecdsa-sha2-nistp256)) /.test(line)) {
        continue;
      }
      lines.push(line);
    }
  };
  const readFile = (file: string) => {
    try {
      collect(fs.readFileSync(file, "utf8"));
    } catch {
      /* 文件不存在或不可读：跳过 */
    }
  };
  if (cfg.ssh_authorized_keys_file) readFile(cfg.ssh_authorized_keys_file);
  // host-runtime 常以 root 运行，而被管理的用户可能不是 root：把本机所有
  // 能登录的账号的公钥都算进来，效果就是“能 SSH 进这台主机就能进容器”。
  if (process.getuid?.() === 0) {
    readFile("/root/.ssh/authorized_keys");
    for (const home of safeList("/home")) {
      readFile(path.join("/home", home, ".ssh", "authorized_keys"));
    }
    // 兼容 compose 时代的公钥目录。
    for (const dir of ["/opt/platform/keys"]) {
      for (const name of safeList(dir)) {
        if (name.endsWith(".pub")) readFile(path.join(dir, name));
      }
    }
  }
  if (cfg.ssh_pubkey_dir) {
    for (const name of safeList(cfg.ssh_pubkey_dir)) {
      if (name.endsWith(".pub")) readFile(path.join(cfg.ssh_pubkey_dir, name));
    }
  }
  return [...new Set(lines)].join("\n").slice(0, 64 * 1024);
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}
