/**
 * Wire shapes returned by the scheduler and the control plane.
 *
 * These describe raw JSON, not the page model in ../types: every field is optional and stays `unknown` until the
 * mapping code validates it. Keeping the API boundary typed here means `sync.ts` and `actions.ts` never need `any`.
 */

export type JsonObject = Record<string, unknown>;

export type PortMappingRow = {
  container?: unknown;
  host?: unknown;
};

export type VolumeRow = {
  name?: unknown;
  mount?: unknown;
};

export type ObservationRow = {
  error?: unknown;
  [key: string]: unknown;
};

/** One control-plane deployment record. */
export type DeploymentRow = {
  deployment_id?: unknown;
  instance_id?: unknown;
  host_id?: unknown;
  role_id?: unknown;
  status?: unknown;
  actual_state?: unknown;
  execution?: unknown;
  display_name?: unknown;
  image?: unknown;
  scheduler_role?: unknown;
  scheduler_deployment_id?: unknown;
  parent_deployment_id?: unknown;
  capability_score?: unknown;
  capability_detail?: unknown;
  config_version?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  resource_profile?: JsonObject;
  ports?: unknown;
  volumes?: unknown;
  labels?: JsonObject;
  env?: JsonObject;
  observed?: ObservationRow | null;
};

export type DeploymentsResponse = {
  deployments?: DeploymentRow[];
};

export type HostRow = {
  host_id?: unknown;
  hostname?: unknown;
  status?: unknown;
  os?: unknown;
  arch?: unknown;
  runtime_version?: unknown;
  resources?: JsonObject;
  last_report?: { resources?: JsonObject } | null;
  labels?: JsonObject;
  tools?: unknown;
  enrolled_at?: unknown;
  created_at?: unknown;
  last_report_at?: unknown;
  last_seen_at?: unknown;
  transport?: unknown;
  address?: unknown;
  ssh_port?: unknown;
  ssh_user?: unknown;
  auth_type?: unknown;
  key_fingerprint?: unknown;
  last_probe?: unknown;
  last_probe_at?: unknown;
  parent_host_id?: unknown;
  role_mode?: unknown;
};

export type HostsResponse = {
  hosts?: HostRow[];
};

export type FleetHostRow = {
  host_id?: unknown;
  hostname?: unknown;
  status?: unknown;
  parent_host_id?: unknown;
  role_mode?: unknown;
  local_score?: unknown;
  subtree_score?: unknown;
  builder_count?: unknown;
  subtree_builder_count?: unknown;
  child_host_ids?: unknown;
  depth?: unknown;
  is_root?: unknown;
};

export type FleetResponse = {
  hosts?: FleetHostRow[];
  total_score?: unknown;
  generated_at?: unknown;
};

export type SideloadRow = {
  sideload_id?: unknown;
  host_id?: unknown;
  name?: unknown;
  token_hint?: unknown;
  scopes?: unknown;
  created_by?: unknown;
  created_at?: unknown;
  expires_at?: unknown;
  last_seen_at?: unknown;
  last_ip?: unknown;
  revoked_at?: unknown;
};

export type SideloadsResponse = {
  sideloads?: SideloadRow[];
};

export type AgentProfileRow = {
  agent_profile_id?: unknown;
  role_id?: unknown;
  name?: unknown;
  version?: unknown;
  adapter?: unknown;
  model_api_profile_id?: unknown;
  capabilities?: unknown;
  artifact_image?: unknown;
  entrypoint?: unknown;
  args?: unknown;
  task_types?: unknown;
  description?: unknown;
  system_prompt?: unknown;
  persona?: unknown;
  tone?: unknown;
  goals?: unknown;
  allowed_tools?: unknown;
  limits?: unknown;
  enabled?: unknown;
};

export type AgentProfilesResponse = {
  agent_profiles?: AgentProfileRow[];
};

export type ApiProfileRow = {
  api_profile_id?: unknown;
  name?: unknown;
  kind?: unknown;
  base_url?: unknown;
  auth_type?: unknown;
  secret_ref?: unknown;
  scopes?: unknown;
  quota?: unknown;
  egress?: unknown;
  timeout_seconds?: unknown;
  enabled?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
};

export type ApiProfilesResponse = {
  api_profiles?: ApiProfileRow[];
};

export type BindingRow = {
  host_id?: unknown;
  instance_id?: unknown;
  agent_profile_id?: unknown;
  api_profile_ids?: unknown;
};

export type BindingsResponse = {
  bindings?: BindingRow[];
};

export type AuditRow = {
  audit_id?: unknown;
  operator_id?: unknown;
  action?: unknown;
  subject?: unknown;
  detail?: unknown;
  created_at?: unknown;
};

export type AuditsResponse = {
  audit_logs?: AuditRow[];
};

/** One scheduler registration row from /v1/instances. */
export type InstanceRow = {
  instance_id?: unknown;
  host_id?: unknown;
  role_id?: unknown;
  state?: unknown;
  last_heartbeat_at?: unknown;
  config_version?: unknown;
  capability_score?: unknown;
  capability_detail?: unknown;
  scheduling_mode?: unknown;
  agent_profile_id?: unknown;
  api_profile_ids?: unknown;
  allowed_task_types?: unknown;
  capabilities?: { os?: unknown } | null;
};

export type InstancesResponse = {
  items?: InstanceRow[];
};

export type TaskRowData = {
  task_id?: unknown;
  task_type?: unknown;
  workflow_run_id?: unknown;
  status?: unknown;
  target_role?: unknown;
  priority_class?: unknown;
  difficulty?: unknown;
  current_instance_id?: unknown;
  attempt_count?: unknown;
  resource_block_reason?: unknown;
  enqueued_at?: unknown;
  relay?: unknown;
  requirements?: JsonObject;
  payload_ref?: unknown;
  resource_profile_id?: unknown;
  approval_mode?: unknown;
  outcome?: unknown;
  pending_question?: unknown;
  parent_task_id?: unknown;
  fanout_id?: unknown;
  fanout_depth?: unknown;
};

export type TasksResponse = {
  items?: TaskRowData[];
};

export type AttemptRow = {
  attempt_number?: unknown;
  status?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
  failure_class?: unknown;
  failure_signature?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  outputs?: unknown;
  result_summary?: unknown;
};

export type TaskChildRow = {
  task_id?: unknown;
  task_type?: unknown;
  status?: unknown;
  outcome?: unknown;
  title?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

export type TaskDetailResponse = {
  attempts?: AttemptRow[];
  children?: TaskChildRow[];
  status?: unknown;
  state?: unknown;
  relay?: { child_result?: { outputs?: unknown } } | null;
  result_summary?: unknown;
};

export type FailureSignatureRow = {
  signature?: unknown;
  kind?: unknown;
  code?: unknown;
  sample?: unknown;
  occurrences?: unknown;
  first_seen_at?: unknown;
  last_seen_at?: unknown;
};

export type FailureSignaturesResponse = {
  items?: FailureSignatureRow[];
};

export type TaskEventRow = {
  created_at?: unknown;
  event_type?: unknown;
  payload?: JsonObject | null;
  from_status?: unknown;
  to_status?: unknown;
};

export type TaskEventsResponse = {
  items?: TaskEventRow[];
};

/** Terminal control frames travel as JSON text on the WebSocket. */
export type TerminalControlFrame = {
  type?: unknown;
  code?: unknown;
  message?: unknown;
};
