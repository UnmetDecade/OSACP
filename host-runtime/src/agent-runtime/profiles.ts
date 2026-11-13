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
    throw new Error(`Profile file not found: ${abs}`);
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
  if (!agentId) throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", "Instance has no Agent Profile bound");

  const agent = (file.agent_profiles ?? []).find((p) => p.agent_profile_id === agentId);
  if (!agent) {
    throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", `Profile file does not contain ${agentId}`);
  }
  if (agent.enabled === false) {
    throw new ProfileRejected("AGENT_PROFILE_NOT_ALLOWED", `Agent Profile is disabled: ${agentId}`);
  }
  if (agent.role_id !== instance.role_id) {
    throw new ProfileRejected(
      "AGENT_PROFILE_NOT_ALLOWED",
      `Agent Profile belongs to ${agent.role_id}, but the instance role is ${instance.role_id}`,
    );
  }
  const allowed = ADAPTERS[instance.role_id];
  if (!allowed || !allowed.includes(agent.adapter)) {
    throw new ProfileRejected(
      "ADAPTER_NOT_ALLOWED",
      `Role ${instance.role_id} does not allow ${agent.adapter}`,
    );
  }

  const binding = file.bindings?.[instance.instance_id];
  if (binding) {
    if (binding.agent_profile_id !== agentId) {
      throw new ProfileRejected(
        "AGENT_PROFILE_NOT_ALLOWED",
        `Instance-configured Agent ${agentId} does not match the PCS binding ${binding.agent_profile_id}`,
      );
    }
    const configured = new Set(instance.api_profile_ids ?? []);
    for (const id of binding.api_profile_ids ?? []) {
      if (!configured.has(id)) {
        throw new ProfileRejected(
          "API_PROFILE_NOT_ALLOWED",
          `PCS bound ${id}, but the instance startup config did not load it`,
        );
      }
    }
    if (configured.size !== new Set(binding.api_profile_ids ?? []).size) {
      throw new ProfileRejected(
        "API_PROFILE_NOT_ALLOWED",
        "Instance loaded an API Profile that PCS has not bound",
      );
    }
  }

  const api = new Map<string, ApiProfile>();
  for (const id of instance.api_profile_ids ?? []) {
    const p = (file.api_profiles ?? []).find((x) => x.api_profile_id === id);
    if (!p) throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `Profile file does not contain API ${id}`);
    if (p.enabled === false) {
      throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `API Profile is disabled: ${id}`);
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
        `Agent Profile references an unbound API: ${id}`,
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
      `Task specifies Agent ${envelope.agent?.profile_id ?? "(empty)"}, but the instance is bound to ${profiles.agent.agent_profile_id}`,
    );
  }
  if (
    envelope.agent.version !== null &&
    envelope.agent.version !== undefined &&
    envelope.agent.version !== profiles.agent.version
  ) {
    throw new ProfileRejected(
      "AGENT_PROFILE_NOT_ALLOWED",
      `Task specifies version ${envelope.agent.version}, but the instance loaded ${profiles.agent.version}`,
    );
  }
  for (const id of envelope.api_profiles ?? []) {
    if (!profiles.boundApiIds.has(id)) {
      throw new ProfileRejected("API_PROFILE_NOT_ALLOWED", `Task references an unbound API ${id}`);
    }
  }
}

export function supportsTask(agent: AgentProfile, taskType: string): boolean {
  return agent.task_types.includes(taskType);
}
