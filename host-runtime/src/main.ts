import fs from "node:fs";
import path from "node:path";
import { Agent } from "./agent.js";
import { SchedulerClient } from "./client.js";
import { loadConfig, selectInstances, type InstanceConfig } from "./config.js";
import {
  loadProfilesFile,
  resolveInstanceProfiles,
  type RuntimeProfiles,
} from "./agent-runtime/profiles.js";
import type { ProfilesFile } from "./agent-runtime/types.js";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cfg = loadConfig(argValue("--config"));
const instances = selectInstances(cfg, process.argv);

if (instances.length === 0) {
  console.error("没有可启动的实例，检查 runtime.config.json");
  process.exit(1);
}

// Instance JWT is read from the mount directory (<dir>/<instance_id>.jwt); the legacy shared token is used as a fallback.
const tokenDir = process.env.INSTANCE_TOKEN_DIR ?? cfg.token_dir;

function tokenFor(instanceId: string): string | (() => string | undefined) | undefined {
  if (tokenDir) {
    const file = path.join(path.resolve(tokenDir), `${instanceId}.jwt`);
    return () => {
      try {
        const jwt = fs.readFileSync(file, "utf8").trim();
        if (jwt) return jwt;
      } catch {
        // Fall back to the shared token when there is no JWT file (local development / Compose default)
      }
      return process.env.SCHEDULER_TOKEN || undefined;
    };
  }
  return process.env.SCHEDULER_TOKEN || undefined;
}

let profilesFile: ProfilesFile | null = null;
if (cfg.profiles_file) {
  profilesFile = loadProfilesFile(cfg.profiles_file);
  console.log(`Profile 文件：${path.resolve(cfg.profiles_file)}`);
}

/**
 * Only instances bound by PCS enter Agent mode; instances without a Profile keep using the deterministic executor.
 * Bound but failed to load → startup failure (fail closed); silent degradation is not allowed.
 */
function profilesFor(i: InstanceConfig): RuntimeProfiles | undefined {
  if (!profilesFile) return undefined;
  const bound = profilesFile.bindings?.[i.instance_id];
  const known = (profilesFile.agent_profiles ?? []).some(
    (p) => p.agent_profile_id === i.agent_profile_id,
  );
  if (!bound && !known) return undefined;
  return resolveInstanceProfiles(profilesFile, i);
}

const agents = instances.map((i) => {
  const client = new SchedulerClient(
    cfg.scheduler_url,
    cfg.request_timeout_ms,
    tokenFor(i.instance_id),
    {
      caFile: cfg.scheduler_ca_file,
      certFile: cfg.scheduler_client_cert_file,
      keyFile: cfg.scheduler_client_key_file,
    },
  );
  const profiles = profilesFor(i);
  if (profiles) {
    console.log(
      `  ${i.instance_id}: ${profiles.agent.agent_profile_id}@${profiles.agent.version} ` +
        `(${profiles.agent.adapter})，API ${[...profiles.boundApiIds].join(",") || "-"}`,
    );
  }
  return new Agent(i, client, {
    heartbeatSeconds: cfg.heartbeat_seconds,
    claimIntervalSeconds: cfg.claim_interval_seconds,
    leaseRenewSeconds: cfg.lease_renew_seconds,
    progressSeconds: cfg.progress_seconds,
    configSyncSeconds: cfg.config_sync_seconds,
    hostAdmissionSocket: cfg.host_admission_socket,
    workspaceDir: path.resolve(cfg.workspace_dir ?? "data/workspace"),
    keepWorkspace: cfg.keep_workspace ?? false,
    profiles,
    secretStoreUrl: process.env.SECRET_STORE_URL ?? cfg.secret_store_url,
    instanceToken: tokenFor(i.instance_id),
    egressPolicies: cfg.egress_policies ?? {},
    allowLoopbackEgress: cfg.allow_loopback_egress ?? false,
    auditDir: path.resolve(cfg.audit_dir ?? "data/audit"),
  });
});

console.log(`调度机 ${cfg.scheduler_url}，启动 ${agents.length} 个实例：${instances.map((i) => i.instance_id).join(", ")}`);
if (!tokenDir && !process.env.SCHEDULER_TOKEN) {
  console.warn("未配置实例令牌（INSTANCE_TOKEN_DIR / SCHEDULER_TOKEN）：调度机若启用鉴权，注册会被拒绝");
}
await Promise.all(agents.map((a) => a.start()));

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`\n收到 ${signal}，停止领取并 drain…`);
  await Promise.all(agents.map((a) => a.stop()));
  console.log("已退出");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
