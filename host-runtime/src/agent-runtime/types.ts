/**
 * Runtime view of Agent / API Profiles (docs/agent-api-spec.md §2, §4).
 *
 * Deliberately contains no secret fields: a Profile only has `secret_ref`, and the value can only be
 * exchanged by the Secret Store based on instance identity, and only ever enters the API Adapter's memory.
 */

export type AdapterKind = "stdio-jsonrpc" | "http-local";

export interface AgentProfile {
  agent_profile_id: string;
  role_id: string;
  name: string;
  version: string;
  adapter: AdapterKind;
  artifact_image?: string;
  entrypoint: string[];
  args: string[];
  /** Allowed tool_ids; an empty array means all permissions. */
  allowed_tools: string[];
  task_types: string[];
  model_api_profile_id?: string | null;
  tool_api_profile_ids?: string[];
  limits?: {
    max_turns?: number;
    max_wall_seconds?: number;
    max_output_tokens?: number;
  };
  capabilities?: string[];
  enabled?: boolean;
  /** Below are the Agent's persona and responsibilities, which the adapter assembles into the prompt. */
  description?: string;
  system_prompt?: string;
  persona?: string;
  tone?: string;
  goals?: string;
}

export interface ApiProfile {
  api_profile_id: string;
  name: string;
  kind: "llm" | "http" | "tool" | "storage";
  base_url: string;
  auth_type: "bearer" | "api_key" | "oauth2_client" | "mtls";
  secret_ref: string;
  scopes: string[];
  quota: { rpm?: number; daily_calls?: number };
  timeout_seconds: number;
  egress: string | null;
  fallback: string[];
  enabled?: boolean;
}

export interface ProfilesFile {
  agent_profiles?: AgentProfile[];
  api_profiles?: ApiProfile[];
  /** instance_id -> binding; when present, the instance may only use the Profiles listed here */
  bindings?: Record<string, { agent_profile_id: string; api_profile_ids?: string[] }>;
}

export interface ToolDescriptor {
  tool_id: string;
  /** Allowed workflow phases; an empty array means all phases */
  phases: string[];
  /** Required action_scopes; an empty array means no extra approval is needed */
  action_scopes: string[];
  /** true means the call egresses through the local API Adapter */
  egress: boolean;
}

export const TOOL_CATALOG: Record<string, ToolDescriptor> = {
  "demo.echo": { tool_id: "demo.echo", phases: [], action_scopes: [], egress: false },
  "workspace.write": { tool_id: "workspace.write", phases: [], action_scopes: [], egress: false },
  "workspace.read": { tool_id: "workspace.read", phases: [], action_scopes: [], egress: false },
  "api.call": { tool_id: "api.call", phases: [], action_scopes: [], egress: true },
};
