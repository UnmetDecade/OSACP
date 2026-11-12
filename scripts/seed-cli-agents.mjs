#!/usr/bin/env node
/**
 * Register the Claude Code / Codex CLI Agent Profiles with PCS.
 *
 * Prerequisites:
 *   - PCS is running, and PCS_IMAGE_ALLOWLIST permits the AGENT_IMAGE repository;
 *   - The corresponding CLI (claude / codex) is installed on the Agent execution host; otherwise tasks fail with
 *     AGENT_NOT_READY / CLI_NOT_INSTALLED, rather than silently switching to another executor;
 *   - The runtime view returned by PCS contains only secret_ref, not key values.
 *
 * Usage:
 *   ADMIN_TOKEN=... AGENT_IMAGE=registry.example/agents/claude@sha256:<64hex> \
 *     node scripts/seed-cli-agents.mjs
 *
 * Optional:
 *   PCS_URL             defaults to http://127.0.0.1:7901
 *   PLATFORM_DIR        Directory containing the Agents code (defaults to the current working directory)
 *   AGENT_NODE          Agent process executable (defaults to node)
 *   AGENT_PROVIDERS     claude,codex (both by default)
 *   AGENT_PASS_ENV      Comma-separated environment variable names, explicitly passed to the external CLI. When unset, defaults are chosen per
 *                       provider (claude: ANTHROPIC_API_KEY,
 *                       ANTHROPIC_BASE_URL; codex: DEEPSEEK_API_KEY, CODEX_HOME).
 *   AGENT_CLAUDE_VERSION / AGENT_CODEX_VERSION
 *                       Profile version; by default takes the version from the local `<cli> --version`,
 *                       and errors if it cannot be obtained (you can specify it explicitly here, e.g. 2.1.322).
 *   --dry-run           Only print the Profiles that would be created, without sending requests
 *   --bind <instance:provider>  After creation, bind the instance to the corresponding Profile (repeatable)
 *   --bind <host/instance:provider>
 *                       When a same-name instance appears on multiple hosts, the host must be given (host_id or hostname)
 *
 * Example:
 *   node scripts/seed-cli-agents.mjs --bind builder-ubuntu22-a:claude --bind builder-ubuntu24-a:codex
 *   node scripts/seed-cli-agents.mjs --bind host-a/builder-a:claude
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const PCS_URL = (process.env.PCS_URL ?? "http://127.0.0.1:7901").replace(/\/$/, "");
const TOKEN = process.env.ADMIN_TOKEN ?? "";
const IMAGE = process.env.AGENT_IMAGE ?? "";
const PLATFORM_DIR = path.resolve(process.env.PLATFORM_DIR ?? process.cwd());
const AGENT_NODE = process.env.AGENT_NODE ?? "node";
const PASS_ENV = (process.env.AGENT_PASS_ENV ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
const PROVIDERS = (process.env.AGENT_PROVIDERS ?? "claude,codex").split(",").map((s) => s.trim()).filter(Boolean);
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const binds = args.flatMap((a, i) => (a === "--bind" && args[i + 1] ? [args[i + 1]] : []));

const ROLE_TASKS = {
  builder: ["task.build", "task.chat.builder"],
  scheduler: ["task.chat.scheduler"],
};
const ROLE_CAPS = {
  builder: ["code.build", "shell", "chat"],
  scheduler: ["queue", "lease", "shell", "chat"],
};
const PROVIDER_NAME = { claude: "Claude Code", codex: "Codex" };
// Inside the container is a one-off build environment; the CLI must be able to read/write the workspace and run commands unattended.
// extra-arg is appended after the provider's default arguments and does not override -p / exec.
const CLI_FLAGS = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"],
};
// When AGENT_PASS_ENV is not explicitly set, allow model-credential-related variables per provider.
const DEFAULT_PASS_ENV = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  codex: ["DEEPSEEK_API_KEY", "CODEX_HOME"],
};
function passEnvFor(provider) {
  return PASS_ENV.length ? PASS_ENV : (DEFAULT_PASS_ENV[provider] ?? []);
}

/**
 * The Profile version is the CLI's real version: in the UI, "Claude Code · builder · v2.1.322"
 * should match `claude --version` inside the image, not an unrelated 1.0.0.
 * Prefer the environment variable (used when the seeding upstream machine has no CLI installed); otherwise probe locally; if neither is available,
 * error out—silently writing a fake version would cause mismatches during troubleshooting.
 */
const VERSION_CACHE = new Map();
function cliVersion(provider) {
  if (VERSION_CACHE.has(provider)) return VERSION_CACHE.get(provider);
  const version = detectCliVersion(provider);
  VERSION_CACHE.set(provider, version);
  return version;
}
function detectCliVersion(provider) {
  const override = (process.env[`AGENT_${provider.toUpperCase()}_VERSION`] ?? "").trim();
  if (override) return override;
  const probe = spawnSync(provider, ["--version"], { encoding: "utf8", timeout: 8000 });
  const text = `${probe.stdout ?? ""} ${probe.stderr ?? ""}`;
  const m = text.match(/\b(\d+\.\d+\.\d+)\b/);
  if (probe.status === 0 && m) return m[1];
  die(
    `无法确定 ${provider} 的版本：本机没有可用的 ${provider} --version。` +
      `请安装 CLI，或显式设置 AGENT_${provider.toUpperCase()}_VERSION（例如 2.1.322）。`,
  );
}

function die(msg) {
  console.error(`seed-cli-agents: ${msg}`);
  process.exit(1);
}

if (!/^.+@sha256:[0-9a-f]{64}$/.test(IMAGE)) {
  die("AGENT_IMAGE 必须是摘要固定的镜像，例如 registry.example/agents/claude@sha256:<64 hex>");
}
if (!dryRun && !TOKEN) die("缺少 ADMIN_TOKEN（只通过环境变量传入，不要写进命令行历史）");
if (!PROVIDERS.length) die("AGENT_PROVIDERS 为空");
for (const p of PROVIDERS) if (!PROVIDER_NAME[p]) die(`未知 provider：${p}`);

async function api(method, url, body) {
  const res = await fetch(`${PCS_URL}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function profileFor(role, provider) {
  const id = `agp_${provider}_${role}`;
  return {
    agent_profile_id: id,
    role_id: role,
    // The name contains only the CLI product name: the role is conveyed by the page/binding context, and the UI composes
    // "Claude Code · v2.1.322", not "Claude Code · builder · v2.1.322".
    name: PROVIDER_NAME[provider],
    version: cliVersion(provider),
    adapter: "stdio-jsonrpc",
    artifact_image: IMAGE,
    entrypoint: [AGENT_NODE, path.join(PLATFORM_DIR, "agents", "cli-agent.mjs")],
    args: [
      "--provider",
      provider,
      ...(CLI_FLAGS[provider] ?? []).flatMap((a) => ["--extra-arg", a]),
      ...passEnvFor(provider).flatMap((name) => ["--pass-env", name]),
      // The scheduler must be able to command builders: attach the builders tool (list/exec/ask/status).
      ...(role === "scheduler" ? ["--mcp-config", "/opt/platform/app/mcp.json"] : []),
    ],
    limits: { max_wall_seconds: 600, max_turns: 40 },
    capabilities: ROLE_CAPS[role],
    allowed_tools: [],
    task_types: ROLE_TASKS[role],
    enabled: true,
  };
}

const existing = dryRun ? [] : ((await api("GET", "/api/v1/platform/agent-profiles"))?.agent_profiles ?? []);
const existingIds = new Set(existing.map((p) => p.agent_profile_id));

// Roles are read from the PCS deployment records; instance mappings are not hardcoded in this script.
// Instance names are unique only within a host, so record by host_id + instance_id; a same-name instance needs the host to disambiguate.
const instancesByName = new Map();
const hostNames = new Map();
if (!dryRun && binds.length) {
  const [deployments, hosts] = await Promise.all([
    api("GET", "/api/v1/platform/deployments"),
    api("GET", "/api/v1/platform/hosts"),
  ]);
  for (const h of hosts?.hosts ?? []) hostNames.set(String(h.host_id), String(h.hostname ?? ""));
  for (const d of deployments?.deployments ?? []) {
    if (d.status !== "REMOVED" && d.instance_id && d.role_id) {
      const name = String(d.instance_id);
      const list = instancesByName.get(name) ?? [];
      list.push({ hostId: String(d.host_id), role: String(d.role_id) });
      instancesByName.set(name, list);
    }
  }
}

/** Parse `<instance>` or `<host>/<instance>`; a same-name instance must specify the host. */
function findInstance(target) {
  const slash = target.indexOf("/");
  const wantedHost = slash >= 0 ? target.slice(0, slash) : "";
  const instanceId = slash >= 0 ? target.slice(slash + 1) : target;
  const all = instancesByName.get(instanceId) ?? [];
  if (!all.length) return null;
  if (wantedHost) {
    const hit = all.find(
      (x) => x.hostId === wantedHost || hostNames.get(x.hostId) === wantedHost,
    );
    return hit ? { ...hit, instanceId } : null;
  }
  return all.length === 1 ? { ...all[0], instanceId } : null;
}
const created = [];
const skipped = [];

for (const provider of PROVIDERS) {
  for (const role of Object.keys(ROLE_TASKS)) {
    const body = profileFor(role, provider);
    if (existingIds.has(body.agent_profile_id)) {
      skipped.push(body.agent_profile_id);
      continue;
    }
    if (dryRun) {
      console.log(JSON.stringify(body, null, 2));
      created.push(body.agent_profile_id);
      continue;
    }
    await api("POST", "/api/v1/platform/agent-profiles", body);
    created.push(body.agent_profile_id);
  }
}

for (const spec of binds) {
  const sep = spec.lastIndexOf(":");
  const target = sep > 0 ? spec.slice(0, sep) : "";
  const provider = sep > 0 ? spec.slice(sep + 1) : "";
  if (!target || !PROVIDER_NAME[provider]) die(`--bind 格式应为 <instance>:claude|codex，收到 ${spec}`);
  const hit = findInstance(target);
  if (!hit) {
    const others = instancesByName.get(target.includes("/") ? target.slice(target.indexOf("/") + 1) : target) ?? [];
    die(
      others.length > 1
        ? `--bind ${target} 在 ${others.length} 台主机上同名，请写成 <host>/${target}`
        : `--bind 找不到实例角色；请先在 PCS 注册部署（未知实例 ${target}）`,
    );
  }
  const profileId = `agp_${provider}_${hit.role}`;
  if (!dryRun) {
    await api("POST", `/api/v1/platform/instances/${encodeURIComponent(hit.instanceId)}/bind-agent`, {
      host_id: hit.hostId,
      agent_profile_id: profileId,
      role_id: hit.role,
    });
  }
  // host_id starts with hst_ and is long; using the hostname in logs is easier to recognize.
  console.log(`bind ${hostNames.get(hit.hostId) || hit.hostId}/${hit.instanceId} -> ${profileId}`);
}

console.log(
  `profiles: created=${created.length} skipped=${skipped.length}` +
    (created.length ? ` [${created.join(", ")}]` : ""),
);
console.log("提示：Profile 注册只改控制面；Host Runtime 需滚动重启实例才会加载新 Agent。");

