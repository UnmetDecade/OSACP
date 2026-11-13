/** v4: the platform has only the scheduler and builder roles, with all permissions by default. */
export type Role = "scheduler" | "builder";

/** Base OS options for builders. */
export type BuilderOs = "ubuntu20.04" | "ubuntu22.04" | "ubuntu24.04" | "ubuntu26.04";

export const BUILDER_OS: {
  id: BuilderOs;
  label: string;
  short: string;
  /** Image name shown in the UI */
  tag: string;
  /** Digest-pinned image used for deployment */
  image: string;
  note: string;
  preview?: boolean;
}[] = [
  {
    id: "ubuntu20.04",
    label: "Ubuntu 20.04 LTS",
    short: "20.04",
    tag: "ubuntu:20.04",
    // The official image plus the runtime cached on the host; no platform-specific image is built.
    image:
      "docker.m.daocloud.io/library/ubuntu@sha256:8feb4d8ca5354def3d8fce243717141ce31e2c428701f6682bd2fafe15388214",
    note: "旧 glibc / 旧内核头文件，兼容老项目",
  },
  {
    id: "ubuntu22.04",
    label: "Ubuntu 22.04 LTS",
    short: "22.04",
    tag: "ubuntu:22.04",
    image:
      "docker.m.daocloud.io/library/ubuntu@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11",
    note: "推荐默认，工具链稳定",
  },
  {
    id: "ubuntu24.04",
    label: "Ubuntu 24.04 LTS",
    short: "24.04",
    tag: "ubuntu:24.04",
    image:
      "docker.m.daocloud.io/library/ubuntu@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852",
    note: "新工具链，Python 3.12 / GCC 13",
  },
  {
    id: "ubuntu26.04",
    label: "Ubuntu 26.04 LTS",
    short: "26.04",
    tag: "ubuntu:26.04",
    image:
      "docker.m.daocloud.io/library/ubuntu@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c",
    note: "前瞻验证，新工具链",
    preview: true,
  },
];

export type HostState = "PENDING" | "ONLINE" | "OFFLINE" | "WARNING" | "THROTTLED" | "PROTECTING" | "DEGRADED" | "REVOKED";

/** The six details of work capability W; the 0–1000 score is derived from their weighted normalization. */
export type CapabilityDetail = {
  cores?: number;
  freq_ghz?: number;
  mem_gb?: number;
  disk_gb?: number;
  model?: number;
  api?: number;
};

/** Host role: run containers, or a bare-metal host acting directly as builder / scheduler (pick one). */
export type HostRoleMode = "containers" | "builder" | "scheduler";

/** A host in the federation tree; subtree_score is the ΣW of it and all descendant hosts. */
export type FleetHost = {
  host_id: string;
  hostname: string;
  status: string;
  parent_host_id: string | null;
  role_mode: HostRoleMode;
  local_score: number;
  subtree_score: number;
  builder_count: number;
  subtree_builder_count: number;
  child_host_ids: string[];
  depth: number;
  is_root: boolean;
};

export type Fleet = {
  hosts: FleetHost[];
  total_score: number;
  generated_at: string;
};

export type InstanceState =
  | "PROVISIONING"
  | "SYNCING"
  | "STARTING"
  | "ONLINE"
  | "SUSPECT"
  | "DRAINING"
  | "OFFLINE"
  | "FAILED";

export type TaskState =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  /** Parked on a question for a human; answering it requeues the task. */
  | "NEEDS_INPUT"
  /** Parked while its child tasks run in parallel; resumes when all of them finish. */
  | "WAITING_CHILDREN";

/** How much the agent may do without asking: ask | edits | auto | full. */
export type ApprovalMode = "ask" | "edits" | "auto" | "full";

/** Host onboarding mode: local host (the machine running the admin app) or remote SSH host. */
export type HostTransport = "local" | "ssh";

/** PCS probe result; the raw private key is not here, and the UI shows only reachability and Docker status. */
export type HostProbe = {
  ok: boolean;
  checked_at: string;
  error?: string;
  hostname?: string;
  os?: string;
  arch?: string;
  docker?: boolean;
  docker_version?: string;
  docker_ok?: boolean;
};

export type Host = {
  id: string;
  name: string;
  os: "Linux" | "macOS" | "Windows";
  arch: string;
  runtime_version: string;
  state: HostState;
  cpu: number;
  mem: number;
  disk: number;
  cpu_total: number;
  mem_total_mb: number;
  /** Last reported available memory; 0 means nothing reported yet. */
  mem_available_mb: number;
  labels: Record<string, string>;
  capabilities: string[];
  registered_at: string;
  /** Last report from the host runtime; empty when the host has never checked in. */
  last_report_at?: string;
  maintaining: boolean;
  transport?: HostTransport;
  address?: string;
  ssh_port?: number;
  ssh_user?: string;
  /** key = private key, password = password; the credential itself never returns to the browser. */
  auth_type?: "key" | "password" | null;
  /** Used only to identify which private key; the key itself never returns to the browser. */
  key_fingerprint?: string;
  last_probe?: HostProbe;
  last_probe_at?: string;
  /** Parent host it is folded into; empty means it is a root of the federation tree. */
  parent_host_id?: string | null;
  /** containers = container host; builder / scheduler = bare metal acting directly as that role. */
  role_mode?: HostRoleMode;
  /** ΣW of builders registered on this host; use subtree_score in the federation tree. */
  local_score?: number;
  subtree_score?: number;
};

export type Instance = {
  /** Instance names are host-local: different hosts may reuse a name, so the UI/list distinguishes them by key. */
  key: string;
  id: string;
  /** Control plane deployment id (dep_...); scheduler/parent scheduler references passed to PCS all use it. */
  deployment_id?: string;
  name: string;
  role: Role;
  /** container = container instance; native = bare-metal role running directly on the host. */
  execution?: "container" | "native";
  /** Base OS of the builder; schedulers have none. */
  os?: BuilderOs;
  host_id: string;
  agent_profile_id: string;
  desired_agent_profile_id?: string;
  agent_pending_restart?: boolean;
  api_profile_ids: string[];
  task_types: string[];
  resource_profile: string;
  /** Direct resource-profile fields; the UI uses them to draw progress bars. */
  cpu_limit: number;
  mem_limit_mb: number;
  disk_gb: number;
  state: InstanceState;
  config_version: number;
  last_heartbeat: string;
  image: string;
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  workspace?: string;
  /** Builder work capability W (0–1000); 0 for schedulers. */
  capability_score?: number;
  capability_detail?: CapabilityDetail;
  /** Scheduling mode: static freezes the deploy-time budget; dynamic uses the host resource pool and live grants. */
  scheduling_mode?: "static" | "dynamic";
  /** Scheduler identity: each host has at most one root scheduler; node schedulers hang under a parent scheduler. */
  scheduler_role?: "root" | "node";
  /** Parent scheduler of a node scheduler (deployment_id). */
  parent_scheduler_id?: string | null;
  /**
   * Instance name of the parent scheduler (resolved from parent_scheduler_id).
   * A scheduler restart changes the deployment_id; the instance name is the layer that stays stable.
   */
  parent_scheduler_instance_id?: string | null;
  /** Host port of the scheduler API. */
  port?: number;
  /** Scheduler the builder registers with (deployment_id); legacy empty data falls back to the host root scheduler. */
  scheduler_id?: string | null;
  /** Instance name of the scheduler the builder belongs to (resolved from scheduler_id). */
  scheduler_instance_id?: string | null;
  /**
   * Current deployment id of the owning scheduler (a scheduler is its own deployment).
   * The admin app proxies this instance's task requests to that scheduler through the control plane; empty uses the default scheduler.
   */
  scheduler_deployment_id?: string | null;
  created_at: string;
};

export type AgentProfile = {
  id: string;
  name: string;
  role: Role;
  version: string;
  adapter: string;
  /** Bound LLM API Profile (DeepSeek / Claude / local LLM). */
  model_api_profile_id?: string;
  capabilities: string[];
  /** Agent-provided image (digest-pinned); empty means run in the instance image. */
  artifact_image?: string;
  /** stdio means a launch command; http-local means http://127.0.0.1:<port>. */
  entrypoint?: string[];
  /** Entry arguments, e.g. --provider claude. */
  args?: string[];
  task_types?: string[];
  /** One-line description for panel identification. */
  description?: string;
  /** Persona config, spliced into the prompt at runtime. */
  system_prompt?: string;
  persona?: string;
  tone?: string;
  goals?: string;
  /** Allowed tool_ids; an empty array means all permissions. */
  allowed_tools?: string[];
  limits?: {
    max_turns?: number;
    max_wall_seconds?: number;
    max_output_tokens?: number;
  };
  enabled: boolean;
};

export type ApiProfile = {
  id: string;
  name: string;
  kind: "llm" | "http" | "tool" | "storage";
  base_url: string;
  auth_type: string;
  secret_ref: string;
  scopes: string[];
  quota: string;
  timeout_seconds?: number;
  egress: string;
  enabled: boolean;
  rotated_at: string;
};

export type TaskEvent = {
  at: string;
  type: string;
  message: string;
};

export type Task = {
  id: string;
  title: string;
  type: string;
  workflow: string;
  stage: string;
  target_role: Role;
  priority: number;
  /** Task difficulty D; 0 = unlimited, and only builders with W ≥ D can claim it. */
  difficulty?: number;
  state: TaskState;
  instance_id?: string;
  attempts: number;
  block_reason?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  /** Deployment id of the scheduler the task is on; empty means the default scheduler. */
  scheduler_deployment_id?: string | null;
  /** Instance name of that scheduler, used in lists to distinguish same-named tasks. */
  scheduler_instance_id?: string | null;
  /** Execution location when the task is pushed down to a node scheduler. */
  relay?: {
    child_node_id: string;
    child_task_id: string;
    state: string;
    child_state?: string | null;
  } | null;
  payload: Record<string, unknown>;
  events: TaskEvent[];
  /** Autonomy requested for this task; the scheduler stores the effective default. */
  approval_mode?: ApprovalMode;
  /** Terminal classification: completed | error | cancelled | input_expired | children_exhausted | interrupted_after_outward. */
  outcome?: string | null;
  /** Set while the task is NEEDS_INPUT. */
  pending_question?: { question: string; attempt_id?: string; asked_at?: string } | null;
  /** Fan-out linkage: set on children, and on the parent for the split it started. */
  parent_task_id?: string | null;
  fanout_id?: string | null;
  fanout_depth?: number;
  /** Children of this task, filled by the detail endpoint. */
  children?: TaskChild[];
};

/** A fan-out child in the parent's tree view. */
export type TaskChild = {
  task_id: string;
  task_type: string;
  status: TaskState;
  outcome?: string | null;
  title?: string | null;
  created_at?: string;
  updated_at?: string;
};

/**
 * One execution attempt of a task.
 *
 * The agent reports a structured error (code + message) when it fails; the task list projection does not carry it,
 * so the detail page fetches the attempt history to show the operator why a task failed.
 */
export type TaskAttempt = {
  attempt_number: number;
  status: string;
  error?: { code?: string; message?: string } | null;
  /** Why the scheduler classified the failure: permanent | outward | rate_limit | busy | transient. */
  failure_class?: string | null;
  /** Normalized grouping key shared by the same failure across builders. */
  failure_signature?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
};

export type FailureSignature = {
  signature: string;
  kind: string;
  code: string;
  sample?: string | null;
  occurrences: number;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
};

export type LogEntry = {
  id: string;
  actor: string;
  action: string;
  object: string;
  result: "OK" | "FAILED";
  at: string;
  detail: string;
};

/** Deployment plan: previewed and issued by the control plane. */
export type DeployPlan = {
  plan_id: string;
  host_id: string;
  host_name: string;
  role: Role;
  names: string[];
  count?: number;
  os?: BuilderOs;
  agent_profile_id: string | null;
  api_profile_ids: string[];
  resource_profile: string | Record<string, unknown>;
  image: string;
  limits: { cpus: number; mem_mb: number; pids: number };
  network_policy: string;
  config_version: number;
  generation: number;
  budget_remaining_mb: number | null;
  interrupts_running: boolean;
  plan_digest: string;
  created_at: string;
  expires_at?: string;
};

/** Config submitted when creating a builder. */
export interface BuilderInput {
  /** Target host; if omitted, the first online host is chosen. */
  host_id?: string;
  /** Instance name, unique only within the host; if empty, the control plane names it automatically (builder-a, builder-b, ...). */
  name?: string;
  os: BuilderOs;
  count: number;
  /** Resource tier: preset ID or custom; used only for display and audit. */
  tier?: string;
  cpus: number;
  mem_mb: number;
  disk_gb: number;
  agent_profile_id: string;
  api_profile_ids: string[];
  /** Which scheduler to register with (deployment_id); if omitted, the target host's root scheduler is used. */
  scheduler_id?: string;
  /** Capability details; if omitted, only the cores/memory/disk items are derived from the resource tier. */
  capability_detail?: CapabilityDetail;
}

/** Host onboarding: local host or SSH host. Credentials pass through browser memory only at submit time and are never echoed after encrypted storage. */
export type HostDraft =
  | { transport: "local"; name?: string }
  | {
      transport: "ssh";
      name?: string;
      address: string;
      port?: number;
      user?: string;
      /** Private key auth; mutually exclusive with password. */
      private_key?: string;
      /** Password auth; mutually exclusive with private_key. */
      password?: string;
    };

/** Submit a build task. */
export interface SubmitTaskInput {
  /** Short title shown in task lists; falls back to the first line of the description when omitted. */
  title?: string;
  /** Natural-language task description; the root scheduler dispatches it to a suitable builder Agent. */
  description: string;
  /** Optional: specify a builder; if omitted, the root scheduler chooses by the scheduling algorithm. */
  target_instance_id?: string;
  priority?: number;
  /** Autonomy level handed to the builder Agent; omitted means the scheduler's configured default. */
  approval_mode?: ApprovalMode;
  /** Task difficulty 0–1000; 0 or empty means unlimited (no longer shown in the admin UI). */
  difficulty?: number;
  deadline_minutes?: number;
  /** Deployment id of the target scheduler; empty uses the default scheduler. */
  scheduler_deployment_id?: string | null;
  /** Attachments sent with the task (images, md, txt, etc.), written to the workspace by the builder. */
  attachments?: TaskAttachment[];
}

/** Task attachment: uploaded by the admin UI first; the task carries only a one-time download URL. */
export interface TaskAttachment {
  name: string;
  media_type: string;
  size: number;
  /** base64 without the data: prefix; used only locally before upload. */
  data_base64: string;
}

/** Reference to an attachment uploaded to the control plane; the builder fetches content by url. */
export interface TaskAttachmentRef {
  attachment_id: string;
  name: string;
  media_type: string;
  size: number;
  url: string;
}

/** Closed sideload permission vocabulary; the control plane rejects anything else. */
export type SideloadScope =
  | "tasks:read"
  | "tasks:write"
  | "builders:read"
  | "queue:read"
  | "console:run";

/**
 * A device on the LAN holding a curl token for one host.
 * The token itself is never in this type: the control plane returns it once, at creation.
 */
export interface Sideload {
  sideload_id: string;
  host_id: string;
  name: string;
  /** Last four characters, so two tokens can be told apart without revealing either. */
  token_hint: string;
  scopes: SideloadScope[];
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  last_seen_at: string | null;
  last_ip: string | null;
  revoked_at: string | null;
}
