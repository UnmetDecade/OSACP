/**
 * Agent / API Profile 的运行时视图（docs/agent-api-spec.md §2、§4）。
 *
 * 这里刻意不包含任何密钥字段：Profile 只有 `secret_ref`，值只能由
 * Secret Store 按实例身份换取，且只进入 API Adapter 的内存。
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
  /** 允许的 tool_id；空数组表示全部权限。 */
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
  /** 下面是 Agent 的人格与职责说明，由适配器拼进提示词。 */
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
  /** instance_id -> 绑定；存在时实例只能使用这里列出的 Profile */
  bindings?: Record<string, { agent_profile_id: string; api_profile_ids?: string[] }>;
}

export interface ToolDescriptor {
  tool_id: string;
  /** 允许的工作流阶段；空数组表示所有阶段 */
  phases: string[];
  /** 需要的 action_scope；空数组表示不需要额外审批 */
  action_scopes: string[];
  /** true 表示调用会经本机 API Adapter 出站 */
  egress: boolean;
}

export const TOOL_CATALOG: Record<string, ToolDescriptor> = {
  "demo.echo": { tool_id: "demo.echo", phases: [], action_scopes: [], egress: false },
  "workspace.write": { tool_id: "workspace.write", phases: [], action_scopes: [], egress: false },
  "workspace.read": { tool_id: "workspace.read", phases: [], action_scopes: [], egress: false },
  "api.call": { tool_id: "api.call", phases: [], action_scopes: [], egress: true },
};
