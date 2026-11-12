import fs from "node:fs";
import path from "node:path";
import type { InstanceConfig } from "../config.js";
import type { AgentProfile, ApiProfile, ProfilesFile } from "./types.js";

const ADAPTERS: Record<string, string[]> = {
  builder: ["stdio-jsonrpc", "http-local"],
  scheduler: ["stdio-jsonrpc", "http-local"],
};

export class ProfileRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProfileRejected";
  }
}

export interface RuntimeProfiles {
  agent: AgentProfile;
  api: Map<string, ApiProfile>;
  boundApiIds: Set<string>;
}

export function loadProfilesFile(file: string): ProfilesFile {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new Error(`找不到 Profile 文件：${abs}`);
  }
  const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as ProfilesFile;
  return raw;
}

/**
 * Load this instance's Profiles.
 *
 * Validation is fail-closed: if any of the role/Adapter matrix, bindings, or API subset is not satisfied,
 * the instance refuses to start the executor outright instead of "getting it running first".
 */
export function resolveInstanceProfiles(
  file: ProfilesFile,
  instance: InstanceConfig,
): RuntimeProfiles {
  const agentId = instance.agent_profile_id;
  if (!agentId) throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", "实例未绑定 Agent Profile");

  const agent = (file.agent_profiles ?? []).find((p) => p.agent_profile_id === agentId);
  if (!agent) {
    throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", `Profile 文件里没有 ${agentId}`);
  }
  if (agent.enabled === false) {
    throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", `Agent Profile 已停用：${agentId}`);
  }
  if (agent.role_id !== instance.role_id) {
    throw new ProfileRejected(
      "AGENT_PROFILE_NOT_ALLOWED",
      `Agent Profile 属于 ${agent.role_id}，实例角色是 ${instance.role_id}`,
    );
  }
  const allowed = ADAPTERS[instance.role_id];
  if (!allowed || !allowed.includes(agent.adapter)) {
    throw new ProfileRejected(
      "ADAPTER_NOT_ALLOWED",
      `角色 ${instance.role_id} 不允许 ${agent.adapter}`,
    );
  }

  const binding = file.bindings?.[instance.instance_id];
  if (binding) {
    if (binding.agent_profile_id !== agentId) {
      throw new ProfileRejected(
        "AGENT_PROFILE_NOT_ALLOWED",
        `实例配置的 Agent ${agentId} 与 PCS 绑定 ${binding.agent_profile_id} 不一致`,
      );
    }
    const configured = new Set(instance.api_profile_ids ?? []);
    for (const id of binding.api_profile_ids ?? []) {
      if (!configured.has(id)) {
        throw new ProfileRejected(
          "API_PROFILE_NOT_ALLOWED",
          `PCS 绑定了 ${id}，但实例启动配置没有加载它`,
        );
      }
    }
    if (configured.size !== new Set(binding.api_profile_ids ?? []).size) {
      throw new ProfileRejected(
        "API_PROFILE_NOT_ALLOWED",
        "实例加载了 PCS 未绑定的 API Profile",
      );
    }
  }

  const api = new Map<string, ApiProfile>();
  for (const id of instance.api_profile_ids ?? []) {
    const p = (file.api_profiles ?? []).find((x) => x.api_profile_id === id);
    if (!p) throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `Profile 文件里没有 API ${id}`);
    if (p.enabled === false) {
      throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `API Profile 已停用：${id}`);
    }
    api.set(id, p);
  }

  // The model/tool APIs declared by the Agent must be a subset of the instance's bound APIs
  const declared = [
    ...(agent.model_api_profile_id ? [agent.model_api_profile_id] : []),
    ...(agent.tool_api_profile_ids ?? []),
  ];
  for (const id of declared) {
    if (!api.has(id)) {
      throw new ProfileRejected(
        "API_PROFILE_NOT_ALLOWED",
        `Agent Profile 引用了未绑定的 API：${id}`,
      );
    }
  }

  return { agent, api, boundApiIds: new Set(api.keys()) };
}

/**
 * Task envelope validation (§5.2): references only, no implementation parsing.
 * Version mismatch, unbound Agent, or a superset of APIs is rejected; the task returns to the queue without consuming a retry.
 */
export function assertEnvelopeAllowed(
  profiles: RuntimeProfiles,
  envelope: { agent?: { profile_id?: string | null; version?: string | null }; api_profiles?: string[] },
): void {
  if (!envelope.agent || envelope.agent.profile_id !== profiles.agent.agent_profile_id) {
    throw new ProfileRejected(
      "AGENT_PROFILE_NOT_ALLOWED",
      `任务指定 Agent ${envelope.agent?.profile_id ?? "(空)"}，实例绑定 ${profiles.agent.agent_profile_id}`,
    );
  }
  if (
    envelope.agent.version !== null &&
    envelope.agent.version !== undefined &&
    envelope.agent.version !== profiles.agent.version
  ) {
    throw new ProfileRejected(
      "AGENT_PROFILE_NOT_ALLOWED",
      `任务指定版本 ${envelope.agent.version}，实例加载 ${profiles.agent.version}`,
    );
  }
  for (const id of envelope.api_profiles ?? []) {
    if (!profiles.boundApiIds.has(id)) {
      throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `任务引用了未绑定的 API ${id}`);
    }
  }
}

export function supportsTask(agent: AgentProfile, taskType: string): boolean {
  return agent.task_types.includes(taskType);
}
