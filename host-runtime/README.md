# 主机运行时（host-runtime）

对应 [../docs/architecture.md](../docs/architecture.md) 与 [../docs/federation.md](../docs/federation.md)。这个目录里有**两个进程**和**一个角色实例骨架**：

| 进程 | 入口 | 职责 |
|---|---|---|
| Host Runtime 守护进程 | `src/runtime.ts` | 向 PCS 注册、心跳、长轮询命令、验签、驱动 Docker 容器生命周期、上报实际态 |
| 看门狗 | `src/watchdog.ts` | 独立采样 CPU/内存/磁盘与 PCS 联系时间，输出 `host-state.json`；不持有任何凭据 |
| 角色实例（role-agent） | `src/main.ts` | 向调度机领取任务并执行，执行前先问本机准入；不参与容器管理 |

守护进程**只出站**：不监听管理端口，所有调用都发往 PCS；本机只开一个 0600 的 unix socket 供角色实例做准入。
PCS 持期望态，Runtime 持实际态，Docker 是唯一事实来源。

## 一、Host Runtime 守护进程

```
启动 → 读身份（run/identity/host.json）
  ├─ 无身份 → 用一次性 PCS_ENROLLMENT_TOKEN 注册 → 存 host JWT + host_id
  ├─ 有身份 → 令牌快到期时续签
  │
  ├→ 心跳/上报（15s）
  ├→ 长轮询命令（30s）→ 验签/校验 → generation 判定 → 执行 → ack
  └→ 对账（15s）：容器退出则拉起；缺失则按期望态重建
        └─ PCS 失联 / 看门狗保护 / 准入不足 → 不创建新容器
```

- **命令验签**：Ed25519 + 规范化 JSON；签名、`host_id`、过期时间、镜像 digest/仓库白名单、
  网络策略、env 凭据键、卷挂载、端口映射、`rgr_` grant 任一项不合格都拒绝并记失败。
- **幂等**：`command_id` 已处理过就直接重放结果；同一实例 `generation` 只增不减，
  旧命令返回 `{ignored:true,reason:"STALE_GENERATION"}`。
- **失败不重试**：Docker 操作失败记为 FAILED 并 ack；需要 PCS 重新下发，不会无限重投。
- **重启恢复**：`runtime-state.json`（0600，原子写）保存期望态；重启后容器继续跑，
  缺失的才重建。状态文件损坏会备份并以空状态启动。
- **吊销**：PCS 返回 `HOST_REVOKED` 后停止领取命令与创建新容器，**不杀已运行容器**。
- **PCS 失联**：超过 `max(45s, 3×heartbeat)` 视为不可达，暂停新建；已运行容器不动。
- **只走固定端点**：Docker Engine API 通过 unix socket 裸 HTTP 调用
  create/start/stop/restart/remove/inspect/list/pull，**没有 exec、没有任意 shell、没有任意宿主路径**。

### 容器基线（v4 研发容器）

容器内是 **root + 可写根 + `CapAdd:["ALL"]`**：SSH 进来就是完全权限，可以 `apt install`、
改系统配置、起任意进程。隔离边界不是容器内的权限收缩，而是容器边界本身：

- CPU / Memory / MemorySwap / PidsLimit / BlkioWeight 资源限额；
- 没有 Docker Socket，也没有宿主机路径（命名卷 `Mounts`，无 `Binds`）；
- 网络策略仍拒绝 `host` 与 `container:` 模式；
- 非 privileged、`Init:true`、`unless-stopped`、json-file 日志轮转（50m × 5）。

构建机镜像按 Ubuntu 20.04 / 22.04 / 24.04 / 26.04 四档发布，镜像内含 `openssh-server`；
SSH 端口随部署意图进入签名命令（`instance.ports`），Host Runtime 写入
`HostConfig.PortBindings`，直接 `ssh root@<host> -p <port>`。参考镜像与 Compose 在
仓库根目录的 `deploy/`。

### 独立看门狗

看门狗是单独进程，只读 `/proc`、`statfs` 和 supervisor 写的 `pcs-last-seen.json`；
不读 Docker Socket，也没有调度机令牌或平台凭据。

```
NORMAL → WARNING → THROTTLED → PROTECTING → RECOVERING → NORMAL
```

- 升一级必须持续 `sustain_seconds`；恢复先稳定 `recover_seconds`，再观察 `recovering_seconds`。
- PCS 失联超过 `pcs_lost_seconds` **直接 PROTECTING**，不看本机指标。
- `PROTECTING` 拒绝一切新容器；`THROTTLED` 只拒绝新建部署，START/RESTART 仍允许。
- 状态文件缺失或过期（`> max(15s, 3×sample)`）一律视为 `WATCHDOG_UNAVAILABLE`，失败关闭。

### 本机准入（防超卖）

角色实例在 `start-ack` 前通过 unix socket 问 Runtime：

```
POST /admission/check   { grant_id, kind:"TASK", instance_id, task_id, attempt_id, resources }
POST /admission/release { grant_id }
GET  /grants            → 聚合值 + items[{grant_id, instance_id, attempt_id, expires_at}]
```

- `allocatable = total - host_reserve - system_reserve - safety_margin`
- `available = min(allocatable - deployment_grants - task_grants, 实时 MemAvailable - safety_margin)`
- 校验与占用在同一条 promise 链里串行，两个任务不可能同时看到同一份余量。
- `grant_id` 幂等；同一 grant 用于不同 attempt 返回 `GRANT_CONFLICT`；TTL 到期自动回收。
- **崩溃对账**：角色实例启动时拉取 `items`，释放自己名下残留的 grant（上次被 kill 时来不及 release），
  避免余量被虚假占用直到 TTL。
- 容器占用由 reconciler 根据**实际运行中的容器标签**重建，不重复记账。
- 角色实例拿不到准入（拒绝或 socket 不可用）就 `accepted:false`，调度机放回队列且**不消耗重试**。

### 运行

```bash
npm install
cp runtime.host.example.json runtime.host.json   # 改 pcs_url / 密钥路径 / 白名单

# 注册令牌由 PCS 的 host-add 生成，只经环境变量传入
export PCS_ENROLLMENT_TOKEN=enr_xxx
./scripts/runtime.sh start     # 起 watchdog + runtime（开发用；生产用两个 systemd unit）
./scripts/runtime.sh status
./scripts/runtime.sh logs
./scripts/runtime.sh stop
```

首次注册成功后身份写入 `identity_dir/host.json`（0600），注册令牌随即作废，可以删掉。
`PCS_COMMAND_PUBLIC_KEY_FILE` 必须存在，否则进程直接退出（不带公钥不启动）。

### 配置（runtime.host.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `pcs_url` | `http://127.0.0.1:7901` | PCS 地址（环境变量 `PCS_URL` 优先） |
| `pcs_ca_file` | 未设置 | 校验 PCS 服务端证书的内部 CA（`PCS_CA_FILE` 优先） |
| `pcs_client_cert_file` | 未设置 | mTLS 客户端证书（`PCS_CLIENT_CERT_FILE` 优先）；与 KEY 同时配置 |
| `pcs_client_key_file` | 未设置 | mTLS 客户端私钥（`PCS_CLIENT_KEY_FILE` 优先） |
| `identity_dir` | `run/identity` | host 身份与 JWT，目录 0700、文件 0600 |
| `state_dir` | `run/state` | `runtime-state.json`、`host-state.json`、`pcs-last-seen.json` |
| `command_public_key_file` | — | PCS 命令公钥；缺失则拒绝启动 |
| `image_allowlist` | `[]` | 允许的仓库前缀；空数组 = 全部拒绝 |
| `network_policies` | `{"default":"bridge"}` | 策略名 → Docker 网络；`host`/`container:` 被拒绝 |
| `docker_socket` | `/var/run/docker.sock` | Docker Engine socket |
| `admission_socket` | `run/runtime.sock` | 本机准入 unix socket（0600） |
| `admission.*` | 见示例 | 预留量、单任务上限、grant TTL |
| `heartbeat_seconds` / `report_seconds` | 15 | 心跳与上报周期 |
| `command_wait_seconds` | 30 | 长轮询等待 |
| `container_stop_timeout_seconds` | 30 | 停止容器超时 |
| `remove_volumes_on_remove` | false | REMOVE 时是否删命名卷（默认保留） |
| `watchdog.*` | 见示例 | 阈值、持续/恢复窗口、PCS 失联阈值 |

### 测试

```bash
npm test        # 65 个用例
npm run typecheck
```

覆盖：看门狗状态机与失败关闭、命令验签/镜像/网络/凭据/generation、
准入并发防超卖与 socket 权限、reconciler 的 DEPLOY/START/STOP/RESTART/REMOVE 与对账；
以及 P4 的 Profile 校验、Tool Policy Guard 七步、出站默认拒绝、API Adapter
（认证注入/配额/fallback/Secret 拒绝）、stdio Agent 执行与换 Agent/崩溃。

测试 Agent 默认取仓库内的 `../agents/demo-agent.mjs`；远程测试机把 `agents/` 同步到别处时，
用 `AGENT_FILE=/path/to/demo-agent.mjs` 覆盖。CLI 包装器另有独立协议测试：
`node agents/test-cli-agent.mjs`（stub CLI，不需要真实模型）。

## 二、角色实例（role-agent）

对应 [../docs/federation.md](../docs/federation.md)：一个角色实例的完整生命周期。
它**不做调度判断**——领什么任务由调度机决定，它只负责「问 → 本地再判一次 → 执行 → 报结果」，
并且每一次写入都带 `lease_token` + `fencing_token`。

```
注册 → 心跳(10s) ──────────────────────────────┐
  │                                            │
  ├→ 配置同步(30s) ← /v1/instances/:id/config   │
  │     版本未变 → 304                          │
  │                                            │
  └→ claim 循环(可配) ← 调度机 /v1/claim         │
        │  拿到 assignment                       │
        ▼                                       │
  Host Runtime 准入（unix socket，实时余量）      │
        │ 拒绝/不可用 → start-ack{accepted:false} │
        ▼                                       │
  start-ack → 续租定时器 → 进度上报 → 执行        │
        │                                       │
        ├─ 取消探测（任务被 CANCELLED）→ abort    │
        ├─ 续租失败 FENCING_STALE → 放弃、不写结果 │
        └─ 结果 → submit-result（幂等）           │
```

- **注册失败不退出**：调度机没起来时按退避一直重试，进程常驻。
- **准入失败关闭**：配置了 `host_admission_socket` 但 socket 不可用时拒绝 assignment，不绕过实时余量检查。
- **准入拒绝后退避**：按 `claim_interval_seconds` 等待再领，不会对同一任务原地刷 attempt。
- **启动对账**：释放本实例上次崩溃遗留的 task grant，再开始领取。
- **心跳与租约分开**：心跳只代表「实例活着」，租约代表「这个 attempt 归我」。
- **租约丢失 = 立即停手**：不提交结果，交给调度机回收 + 新实例重跑。
- **退出会注销**：SIGTERM 后在途任务跑完 → `deregister`；超时带 `force:true`。
- **制品由执行器主动上传**：登记 → `PUT content` → `complete`；调度机重算 SHA-256 后才作为审批凭据。
- **上游制品显式交接**：下游角色只下载 `requirements.upstream_artifacts` 里列出的制品，
  下载后再按交接单的 `sha256` 自行复核；调度机只给这份交接单授权的实例放行。
- **每个 attempt 一个工作目录**：`<workspace_dir>/<attempt_id>/`，结束即删（`keep_workspace` 可保留）。

### 角色执行器（`src/roles/`）

v4 只有两个角色，执行器也就只剩这几类任务：

| 角色 | 任务类型 | 做什么 |
|---|---|---|
| builder | `task.build` | 在 workspace 内执行 `requirements.build.command`，完整日志作为制品上传；没有 command 时退回确定性构建清单 |
| builder | `task.chat.builder` | 夯台（构建机器人）对话；绑定 Agent 时可交给 Agent |
| builder | `task.console.builder` | 容器内完整 shell（与 SSH 等价），无命令白名单 |
| scheduler | `task.chat.scheduler` | 派令（调度机器人）对话 |
| scheduler | `task.console.scheduler` | 调度机容器内完整 shell |

`task.console.*` 永远走确定性执行器，不会路由给外部 Agent；`task.chat.*` 才会按
`agent.task_types` 决定是否交给 Agent。构建命令超时（默认 15 分钟）或非零退出码都会
保留日志制品后失败，错误码分别是 `BUILD_TIMEOUT` / `BUILD_FAILED`。

### 运行

```bash
# 前提：调度机在 127.0.0.1:7801，库里有 docker-host-01 / dev-box 与对应角色实例
cp runtime.config.example.json runtime.config.json
./scripts/start.sh scheduler builder-ubuntu20-a builder-ubuntu22-a builder-ubuntu24-a
./scripts/stop.sh scheduler builder-ubuntu20-a builder-ubuntu22-a builder-ubuntu24-a
```

调度机启用实例 JWT 后，每个实例从挂载目录读自己的令牌（`<dir>/<instance_id>.jwt`，每次请求重读）：

```bash
INSTANCE_TOKEN_DIR=run/tokens ./scripts/start.sh builder-ubuntu22-a builder-ubuntu24-a
```

过渡期共享令牌仍可用 `SCHEDULER_TOKEN=xxx`；两者都没配而调度机要求鉴权时，注册会 401。

| 字段 | 默认 | 说明 |
|---|---|---|
| `scheduler_url` | `http://127.0.0.1:7801` | 调度机地址 |
| `scheduler_ca_file` | 未设置 | 校验调度机证书的内部 CA（`SCHEDULER_CA_FILE` 优先） |
| `scheduler_client_cert_file` | 未设置 | mTLS 客户端证书（`SCHEDULER_CLIENT_CERT_FILE` 优先）；与 KEY 同时配置 |
| `scheduler_client_key_file` | 未设置 | mTLS 客户端私钥（`SCHEDULER_CLIENT_KEY_FILE` 优先） |
| `host_admission_socket` | 未设置 | Host Runtime 准入 socket；未设置时退回进程内 `LocalAdmission` |
| `heartbeat_seconds` | 10 | 心跳周期 |
| `claim_interval_seconds` | 2 | 空闲时多久问一次 |
| `lease_renew_seconds` | 60 | 续租周期 |
| `progress_seconds` | 3 | 进度上报（同时探测取消） |
| `config_sync_seconds` | 30 | 配置同步周期 |
| `workspace_dir` | `data/workspace` | 角色执行器工作目录根；每个 attempt 一个子目录 |
| `keep_workspace` | false | 调试用：任务结束后保留工作目录 |
| `instances[].slots` | 1 | 同时跑几个任务 |
| `instances[].slot_memory_bytes` | 1 GiB | 每个 slot 的内存预算 |

PCS 与调度机启用内部 CA / mTLS 时，Host Runtime 显式读取 CA 与客户端证书，不依赖系统信任链：

```bash
export PCS_CA_FILE=/secure/pki/ca.crt
export PCS_CLIENT_CERT_FILE=/secure/pki/client.crt
export PCS_CLIENT_KEY_FILE=/secure/pki/client.key
export SCHEDULER_CA_FILE=/secure/pki/ca.crt
export SCHEDULER_CLIENT_CERT_FILE=/secure/pki/client.crt
export SCHEDULER_CLIENT_KEY_FILE=/secure/pki/client.key
```

证书文件缺失或只配了 CERT 没配 KEY 时进程直接退出。制品上传/下载与普通 JSON 请求
走同一条 HTTP(S) 通道，因此也自动带客户端证书。Secret Store 客户端仍是 `fetch`，
内部 CA 场景需另设 `NODE_EXTRA_CA_CERTS`（见 [../secret-store/README.md](../secret-store/README.md)）。

## 三、Agent / API 接入（P4）

对应 [../docs/admin-app.md](../docs/admin-app.md) 的 Agent/API 档案。角色实例在确定性执行器之外，可以按 PCS 的绑定加载
Agent Profile，由 Adapter 执行任务；外部 API 一律经本机 API Adapter 出站。

### 3.1 Profile 加载与信封校验

- `runtime.config.json` 的 `profiles_file` 指向 PCS `resolve` 导出的运行时视图
  （`agent_profiles[]` / `api_profiles[]` / `bindings`）；**文件里只有 `secret_ref` 引用，没有密钥值**。
- 只有 PCS 绑定过的实例才进入 Agent 模式；没有绑定/没有 Profile 的实例继续用确定性执行器
  （P2/P3 兼容）。绑定了但校验失败 → **实例启动失败**，不悄悄降级。
- 启动校验：角色与 Adapter 矩阵（只有 builder / scheduler，均允许 `stdio-jsonrpc` / `http-local`）、绑定一致、
  实例加载的 API 集合 = PCS 绑定集合、Agent 声明的 `tool_api_profile_ids` 必须已绑定。
- 每个 assignment 再校验一次信封：`agent.profile_id` / `agent.version` / `api_profiles[]`
  必须与本地加载的一致。不匹配 → `start-ack {accepted:false}` 回队，**不消耗重试**，
  写 `profile-audit.jsonl`；不调用 Agent。
- 任务类型由 `agent.task_types` 决定是否交给 Agent；不在列表内则回落到确定性执行器。

### 3.2 Adapter

| Adapter | 通信 | 适用 |
|---|---|---|
| `stdio-jsonrpc` | 每行一个 JSON 的 JSON-RPC 2.0 子进程 | 所有允许 Agent 的角色 |
| `http-local` | localhost 一次性 HTTP JSON-RPC | builder / scheduler（不支持反向工具回调） |

`agent.prepare` / `agent.execute` / `agent.cancel` / `agent.health` 与
`agent.event`（progress/log/artifact）、`agent.result`、`tool.call` 的契约见规范 §3。
Adapter 子进程拿到的环境只有 `PLATFORM_*`（workspace、task、tool_token、本地 API 代理地址），
**没有调度机令牌、没有实例 JWT、没有 Secret Store 地址**。

#### 3.2.1 CLI Agent Adapter（Claude Code / Codex）

`agents/cli-agent.mjs` 是 `stdio-jsonrpc` 的通用包装器，Profile 只需指向它：

```json
{
  "adapter": "stdio-jsonrpc",
  "entrypoint": ["node", "/opt/platform/agents/cli-agent.mjs"],
  "args": ["--provider", "claude"],
  "task_types": ["task.build", "task.chat.builder"]
}
```

- `--provider claude` 调 `claude -p <prompt> --output-format json`；`--provider codex` 调
  `codex exec <prompt>`；`--provider custom --command <bin>` 接任意 CLI。
- 外部 CLI 默认只拿到最小环境（`PATH`、`LANG`、`HOME=workspace`、任务标识），
  不继承宿主凭据；模型 key 需用 `--pass-env <NAME>` 显式放行。`PLATFORM_TOOL_TOKEN` /
  `PLATFORM_API_PROXY` / `PLATFORM_API_PROFILES` 永不传入；外部 CLI 的 stdout/stderr
  不会混入协议通道。
- 非对话任务要求 CLI 写 `<workspace>/result.json`（`summary` + `outputs[]`），适配器只接受
  工作区内的相对路径；对话任务把 stdout 映射为 `reply`，执行器写 `mode=agent`。
- CLI 未安装时 `prepare` 返回 `ready:false`，任务以 `AGENT_NOT_READY` 失败，不降级。
- 受控终端 `task.console.*` **永远走确定性执行器**，即使实例绑定了 Agent；对话
  `task.chat.*` 才会按 `task_types` 交给 Agent。
- 用 `scripts/seed-cli-agents.mjs` 把 Claude/Codex Profile 注册到 PCS：
  `ADMIN_TOKEN=... AGENT_IMAGE=<digest 固定镜像> node scripts/seed-cli-agents.mjs --bind builder-ubuntu22-a:claude`。
- 适配器自身有协议级测试：`node agents/test-cli-agent.mjs`（使用 `agents/fixtures/stub-cli.mjs`，
  不需要真实模型或 CLI 凭据）。

### 3.3 Tool Policy Guard

模型产生的 `tool.call` 只是请求。`src/agent-runtime/tool-policy.ts` 按固定七步拒绝：

1. attempt 身份：`tool_token` 必须是本次 attempt 随机生成的（不跨任务复用）；
2. Profile 白名单 `allowed_tools`；未列入 → `TOOL_NOT_ALLOWED`，目录外 → `TOOL_UNKNOWN`；
3. 工作流阶段；
4. 参数 Schema 与工作区路径（`WORKSPACE_PATH_DENIED`）；
5. 资源/网络/`action_scope`，`api.call` 的 Profile 必须在绑定内；
6. 幂等键：同键不同参数拒绝（`TOOL_IDEMPOTENCY_CONFLICT`），同键同参数返回首次结果；
7. 审计：只写工具、参数摘要、结果摘要、耗时与判定，**不写参数正文和密钥**。

另有 `max_turns` 限制（`TOOL_TURN_LIMIT`）。工具返回值标记为不可信输入，
不参与后续授权判断。平台目录目前只有 `demo.echo`、`workspace.read/write`、`api.call`，
没有任意 shell / 任意宿主路径。

### 3.4 API Adapter 与 Secret

- 每个绑定 API 的实例在 `127.0.0.1:<随机端口>` 起本地代理，Agent 只拿到
  `PLATFORM_API_PROXY` 和 `/<api_profile>/<path>` 句柄。
- Adapter 丢弃 Agent 自带的 `authorization` / `cookie` / `host` / `x-api-key`，
  再从 Secret Store 取凭据注入。凭据只在 Adapter 内存里，**不进 env、日志、制品或审计**。
- Secret Store 用实例 JWT（`sub` = instance_id）鉴权；读取不到/被吊销 → 任务失败关闭。
  `cacheMs` 默认 0，吊销和轮换下一次调用立即生效。
- 配额：`rpm` / `daily_calls` 按 Profile 计数，超限返回 429。
- 重试：只重试 GET/HEAD 或带幂等键的请求，最多一次；非幂等请求不盲目重放。
- 重定向：`redirect: manual`，Location 目标重新过出站策略，不静默跟随。
- fallback：主 Profile 失败且错误可重试时按顺序切换，审计记 `fallback_from`。
- 出站：默认拒绝；Profile 必须声明 `egress` 策略名，Host Runtime 的 `egress_policies`
  给出 host 白名单，仅 `https`（本地开发 `allow_loopback_egress` 才允许回环 http）。
  云元数据地址（`169.254.169.254`、`fd00:ec2::254`、`100.100.100.200` 等）、回环/私网/
  链路本地地址无论白名单怎么写都拒绝；DNS 解析出的每个地址都要校验。

审计落盘在 `audit_dir`（默认 `data/audit`，0700 目录 / 0600 文件）：
`tool-audit.jsonl`、`api-audit.jsonl`、`profile-audit.jsonl`。

### 3.5 配置字段（runtime.config.json，P4 新增）

| 字段 | 默认 | 说明 |
|---|---|---|
| `profiles_file` | 未设置 | PCS `resolve` 导出的 Profile 文件；未设置则不进入 Agent 模式 |
| `secret_store_url` | 未设置 | Secret Store 地址；实例绑定 API 但没有它 → 启动失败（失败关闭） |
| `egress_policies` | `{}` | 策略名 → 允许的 host；空 = 全部拒绝 |
| `allow_loopback_egress` | false | **仅本地开发**：允许 api profile 访问回环 http |
| `audit_dir` | `data/audit` | 工具/API/Profile 审计目录 |
| `instances[].agent_profile_version` | 未设置 | 无 Profile 文件时随注册上报的版本引用 |
| `instances[].api_profile_ids` | `[]` | 无 Profile 文件时随注册上报的 API 引用 |
| `instances[].api_adapter_port` | 0（随机） | 本地 API 代理端口；容器内通常固定 8090 |

`SECRET_STORE_URL` 环境变量优先于 `secret_store_url`；实例令牌仍由
`INSTANCE_TOKEN_DIR/<instance_id>.jwt` 每次请求重读。

### 3.6 失败语义

| 情况 | 结果 |
|---|---|
| 信封 Profile/版本/API 不匹配 | `start-ack accepted:false`，回队，不消耗重试 |
| Agent 越权工具 / 参数非法 | `FAILED`，错误码 `TOOL_*`，不可重试 |
| API 出站被策略拒绝 | `FAILED`，`EGRESS_*`，不可重试 |
| Secret 无权/已吊销 | `FAILED`，`SECRET_*`，不可重试 |
| API 配额 429 / 5xx / 网络抖动 | 任务失败，按 Profile 语义可重试 |
| Adapter 崩溃 | `FAILED AGENT_CRASHED`，**role-agent 保持 ONLINE**，任务可重试 |
| prepare 未就绪 | `FAILED AGENT_NOT_READY` |

## 目录

```
src/
  runtime.ts              Host Runtime 守护进程入口
  runtime-config.ts       守护进程配置（runtime.host.json）
  identity.ts             身份持久化（0600）与令牌可用性判断
  pcs-client.ts           PCS HTTP 客户端（注册/心跳/命令/ack/上报/续签）
  command-verify.ts       命令规范化 JSON、Ed25519 验签与全部策略校验
  docker-engine.ts        固定端点的 Docker Engine API（unix socket）
  container-spec.ts       §7 容器安全配置
  runtime-state.ts        期望态持久化（原子写、损坏备份）
  reconciler.ts           期望态 ↔ 实际态对账
  watchdog.ts             独立看门狗进程
  watchdog-state.ts       状态机与容器准入判定
  admission-broker.ts     本机准入 broker + unix socket 服务
  host-admission-client.ts 角色实例侧的准入客户端
  host-report.ts          §6.4 主机上报
  agent.ts / client.ts    角色实例生命周期与调度机客户端
  exec-types.ts           执行器上下文与失败语义
  executor.ts             任务类型 → 执行器注册表
  roles/                  v4 执行器：builder（task.build）、chat-console
                          （task.chat.* / task.console.*）、shell 工具
  agent-runtime/
    types.ts              Agent/API Profile 运行时视图与工具目录
    profiles.ts           Profile 文件加载、角色/adapter 矩阵、信封校验
    stdio-adapter.ts      stdio JSON-RPC Adapter
    http-local-adapter.ts localhost HTTP Adapter
    tool-policy.ts        Tool Policy Guard（固定七步）
    egress.ts             默认拒绝出站、DNS/元数据/私网校验
    secret-client.ts      按实例身份向 Secret Store 换取短期凭据
    api-adapter.ts        本机 API 代理：认证注入、配额、重试、fallback、审计
    agent-executor.ts     组装 Guard/Adapter，上传制品并映射失败
scripts/
  runtime.sh              watchdog + runtime 的起停/状态/日志
  start.sh / stop.sh      角色实例的起停
test/                     看门狗、命令、准入、reconciler 与角色实例测试
```

## 边界

- **执行器是研发参考实现**：`task.build` 直接在 workspace 内跑配置的命令，`task.console.*`
  是容器内的完整 shell；两者都不假装完成外部系统操作。
- **不持有平台写凭据**：Agent 子进程与终端环境里没有调度机令牌、实例 JWT 或 Secret Store 地址；
  凭据只在 API Adapter 内存里。
- **容器内没有 Docker Socket**：角色容器通过本机 socket 做准入，不直接操作 Docker。
- **Agent 拿不到实例身份**：Adapter 环境里没有实例 JWT、Secret Store 地址或调度机令牌；
  凭据只存在于 API Adapter 内存。本地 API 代理没有额外鉴权，依赖容器内只监听回环；
  生产若同容器还有不可信进程，需要加容器内网络隔离或 unix socket 权限。
- **Secret Store 是参考实现**：文件后端（0600）+ 实例策略 + 短期 TTL，不是 Vault/KMS；
  生产替换时保持「按实例身份解析、只存引用、可吊销、审计不含值」的契约即可。
- **没有任务级优先级**：那是调度机的事。
- **单控制面、非 HA**：PCS 或 Runtime 重启期间按上述失败关闭规则暂停新建，不猜测状态。
- **镜像必须提前可拉取**：只接受 digest 固定的镜像；仓库不可达时部署失败，不会退回 tag。
