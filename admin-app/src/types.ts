/** v4：平台只有调度机与构建机两个角色，默认全部权限。 */
export type Role = "scheduler" | "builder";

/** 构建机可选的基础系统。 */
export type BuilderOs = "ubuntu20.04" | "ubuntu22.04" | "ubuntu24.04" | "ubuntu26.04";

export const BUILDER_OS: {
  id: BuilderOs;
  label: string;
  short: string;
  /** 界面显示的镜像名 */
  tag: string;
  /** 部署用的 digest 固定镜像 */
  image: string;
  note: string;
  preview?: boolean;
}[] = [
  {
    id: "ubuntu20.04",
    label: "Ubuntu 20.04 LTS",
    short: "20.04",
    tag: "ubuntu:20.04",
    // 官方镜像 + 主机缓存里的运行时，不构建平台专属镜像。
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

/** 工作能力值 W 的六项明细，0–1000 分由它们加权归一化得出。 */
export type CapabilityDetail = {
  cores?: number;
  freq_ghz?: number;
  mem_gb?: number;
  disk_gb?: number;
  model?: number;
  api?: number;
};

/** 主机角色：跑容器，或裸机直接充当构建机 / 调度机（二选一）。 */
export type HostRoleMode = "containers" | "builder" | "scheduler";

/** 联邦树里的一台主机；subtree_score 是它和全部下级主机的 ΣW。 */
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

export type TaskState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "CANCELLED";

/** 主机接入方式：本地主机（运行管理页面的机器）或 SSH 远程主机。 */
export type HostTransport = "local" | "ssh";

/** PCS 探测结果；私钥原文不在这里，界面只显示可达性与 Docker 状态。 */
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
  /** 最近一次上报的可用内存；0 表示还没上报。 */
  mem_available_mb: number;
  labels: Record<string, string>;
  capabilities: string[];
  registered_at: string;
  maintaining: boolean;
  transport?: HostTransport;
  address?: string;
  ssh_port?: number;
  ssh_user?: string;
  /** key = 私钥，password = 密码；凭据本身永远不会回到浏览器。 */
  auth_type?: "key" | "password" | null;
  /** 只用于辨认是哪把私钥；私钥本身永远不会回到浏览器。 */
  key_fingerprint?: string;
  last_probe?: HostProbe;
  last_probe_at?: string;
  /** 并入的上级主机；为空表示联邦树的根。 */
  parent_host_id?: string | null;
  /** containers = 容器宿主；builder / scheduler = 裸机直接充当该角色。 */
  role_mode?: HostRoleMode;
  /** 本机在册构建机的 ΣW；联邦树里有 subtree_score。 */
  local_score?: number;
  subtree_score?: number;
};

export type Instance = {
  /** 实例名是主机本地的：不同主机可以重名，界面/列表统一用 key 区分。 */
  key: string;
  id: string;
  /** 控制面部署 id（dep_…）；传给 PCS 的调度机/父调度机引用都用它。 */
  deployment_id?: string;
  name: string;
  role: Role;
  /** container = 容器实例；native = 直接跑在主机上的裸机角色。 */
  execution?: "container" | "native";
  /** 构建机的基础系统；调度机没有。 */
  os?: BuilderOs;
  host_id: string;
  agent_profile_id: string;
  desired_agent_profile_id?: string;
  agent_pending_restart?: boolean;
  api_profile_ids: string[];
  task_types: string[];
  resource_profile: string;
  /** 资源画像的直接字段，界面用它画进度条。 */
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
  /** 构建机工作能力值 W（0–1000）；调度机为 0。 */
  capability_score?: number;
  capability_detail?: CapabilityDetail;
  /** 调度机身份：每台主机最多一个根调度机，结点调度机挂在父调度机下。 */
  scheduler_role?: "root" | "node";
  /** 结点调度机的父调度机（deployment_id）。 */
  parent_scheduler_id?: string | null;
  /**
   * 父调度机的实例名（由 parent_scheduler_id 解析）。
   * 调度机重启会换新的 deployment_id，实例名才是不变的那一层。
   */
  parent_scheduler_instance_id?: string | null;
  /** 调度机 API 的宿主端口。 */
  port?: number;
  /** 构建机注册到哪台调度机（deployment_id）；旧数据为空时按主机根调度机处理。 */
  scheduler_id?: string | null;
  /** 构建机所属调度机的实例名（由 scheduler_id 解析）。 */
  scheduler_instance_id?: string | null;
  /**
   * 所属调度机的当前部署 id（调度机自己就是它的部署）。
   * 管理页把这个实例的任务请求经控制面代理到对应调度机；空时用默认调度机。
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
  /** 绑定的大模型 API Profile（DeepSeek / Claude / 本地 LLM）。 */
  model_api_profile_id?: string;
  capabilities: string[];
  /** Agent 自带镜像（digest 固定）；为空表示跑在实例镜像里。 */
  artifact_image?: string;
  /** stdio 为启动命令；http-local 为 http://127.0.0.1:<port>。 */
  entrypoint?: string[];
  /** 入口参数，例如 --provider claude。 */
  args?: string[];
  task_types?: string[];
  /** 面板识别用的一句话说明。 */
  description?: string;
  /** 人格配置，运行时拼进提示词。 */
  system_prompt?: string;
  persona?: string;
  tone?: string;
  goals?: string;
  /** 允许的 tool_id；空数组表示全部权限。 */
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
  /** 任务难度 D；0 = 不限制，只有 W ≥ D 的构建机可领取。 */
  difficulty?: number;
  state: TaskState;
  instance_id?: string;
  attempts: number;
  block_reason?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  /** 任务所在调度机的部署 id；空表示默认调度机。 */
  scheduler_deployment_id?: string | null;
  /** 所在调度机实例名，列表里用来区分同名任务。 */
  scheduler_instance_id?: string | null;
  /** 任务被下推到结点调度机时的执行位置。 */
  relay?: {
    child_node_id: string;
    child_task_id: string;
    state: string;
    child_state?: string | null;
  } | null;
  payload: Record<string, unknown>;
  events: TaskEvent[];
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

/** 部署计划：由控制面预览与下发。 */
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

/** 新建构建机时提交的配置。 */
export interface BuilderInput {
  /** 目标主机；不填时选第一台在线主机。 */
  host_id?: string;
  /** 实例名，只在主机内唯一；留空由控制面自动命名（builder-a、builder-b…）。 */
  name?: string;
  os: BuilderOs;
  count: number;
  /** 资源档位：预设 ID 或 custom；仅用于展示与审计。 */
  tier?: string;
  cpus: number;
  mem_mb: number;
  disk_gb: number;
  agent_profile_id: string;
  api_profile_ids: string[];
  /** 注册到哪台调度机（deployment_id）；不填时用目标主机的根调度机。 */
  scheduler_id?: string;
  /** 工作能力明细；不填时只按资源档位折算核心/内存/磁盘三项。 */
  capability_detail?: CapabilityDetail;
}

/** 主机接入：本地主机或 SSH 主机。凭据只在提交时经过浏览器内存，加密落库后不再回显。 */
export type HostDraft =
  | { transport: "local"; name?: string }
  | {
      transport: "ssh";
      name?: string;
      address: string;
      port?: number;
      user?: string;
      /** 私钥认证；与 password 二选一。 */
      private_key?: string;
      /** 密码认证；与 private_key 二选一。 */
      password?: string;
    };

/** 提交构建任务。 */
export interface SubmitTaskInput {
  /** 自然语言任务描述；由根调度机派发给合适的构建机 Agent 执行。 */
  description: string;
  /** 可选：指定构建机；不填由根调度机按调度算法自动选择。 */
  target_instance_id?: string;
  priority?: number;
  /** 任务难度 0–1000；0 或留空表示不限制（管理端不再展示）。 */
  difficulty?: number;
  deadline_minutes?: number;
  /** 目标调度机的部署 id；空时使用默认调度机。 */
  scheduler_deployment_id?: string | null;
  /** 随任务下发的附件（图片、md、txt 等），由构建机写入工作区。 */
  attachments?: TaskAttachment[];
}

/** 任务附件：管理端先上传，任务里只带一次性下载地址。 */
export interface TaskAttachment {
  name: string;
  media_type: string;
  size: number;
  /** 不含 data: 前缀的 base64；只在本地上传前使用。 */
  data_base64: string;
}

/** 已上传到控制面的附件引用；构建机按 url 取内容。 */
export interface TaskAttachmentRef {
  attachment_id: string;
  name: string;
  media_type: string;
  size: number;
  url: string;
}
