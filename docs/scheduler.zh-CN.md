# 调度机规范

> [English](scheduler.md) · 简体中文

> 版本：v4.3 · 2026-11-12
> 调度机是唯一的状态权威。它只做四件事：收任务、排队、派发、记账。
> 分配与调度数学（`W`、注水、并发、压力）见 [scheduling-algorithm.zh-CN.md](scheduling-algorithm.zh-CN.md)。
> Agent 驱动的暂停、任务拆分与主机侧护栏见 [agent-control.zh-CN.md](agent-control.zh-CN.md)。

---

## 1. 职责

做：

- 接收任务（管理应用 / CLI / 外部系统）。
- 维护任务状态与事件。
- 按确定性规则把任务派给构建机。
- 维护实例、租约、fencing token、资源预留。
- 提供管理 API：构建机创建/启停/查询、队列统计、事件流。
- 写审计日志。

不做：

- 不编译、不执行命令、不持有构建机 SSH 私钥。
- 调度核心不解析 Agent 实现细节；调度 Agent 由容器内的 host-runtime 独立执行。
- 不做审批、不做人工门禁。
- 不做多租户与角色权限。

---

## 2. 任务类型（v4）

| `task_type` | 目标角色 | 说明 |
|---|---|---|
| `task.build` | `builder` | 构建/编译/脚本/测试等任务；管理端只下发自然语言描述，由 Agent 执行 |
| `task.chat.builder` | `builder` | 与构建机器人对话 |
| `task.console.builder` | `builder` | 构建机容器 Shell（SSH 等价，完整权限） |
| `task.chat.scheduler` | `scheduler` | 与调度 Agent 对话：解释队列、租约与派发结果 |
| `task.console.scheduler` | `scheduler` | 调度机容器 Shell |

> 不再有 `task.review.*`、`task.commit`、`task.test.*`、`task.ticket.*`。

### 2.1 调度 Agent

调度机也可以绑定一个 `scheduler` 角色的 Agent Profile（例如 DeepSeek 调度助手）。
它的职责是**解释与问答**：为什么这条任务在等、下一轮会派给谁、哪台构建机最闲。

边界不变：

- 队列、优先级、租约、fencing 全部由确定性代码决定，Agent 不参与派发。
- Agent 不能改优先级、不能插队、不能绕过资源预留。
- 不存在 Agent 时退化为确定性回复，接口与任务类型保持不变。

---

## 3. 调度规则

### 3.1 资格过滤

任务可被某构建机领取，当且仅当：

- 任务 `state = QUEUED`，且 `target_role = builder`。
- 构建机 `state = ONLINE`。
- 任务 `task_type` 在构建机 `allowed_task_types` 内。
- 任务要求的 OS/能力是构建机能力的子集：`requirements.os` 为空或等于构建机 `BUILDER_OS`。
- `requirements.target_instance_id` 为空或等于该实例。
- 任务未到 `next_attempt_at` 时不参与。

### 3.2 排序（确定性）

```
effective_priority = priority_class - floor(wait_seconds / aging_after_seconds)
ORDER BY effective_priority ASC, enqueued_at ASC, task_id ASC
```

- `priority_class`：0 最高，3 最低；默认 2。
- 老化防止低优先级饥饿。
- 不涉及大模型、不随机。

### 3.3 并发上限

取以下最小值：

- 全局 `global_limit`（默认 8）。
- 单构建机 `instance_limit`（默认 2）。
- 单任务类型 `task_type_limit`（默认 4）。

### 3.4 领取事务

`claim` 在同一个事务里完成：实例行锁 → 主机资源行锁 → 资格过滤 → 准入 → 创建 attempt/lease/预留 → 任务置 `ASSIGNED`。任何一步失败都不返回任务。

---

## 4. 状态机

### 4.1 任务

```
QUEUED ──claim──▶ ASSIGNED ──start-ack──▶ RUNNING ──result──▶ SUCCEEDED
   │                  │                      │
   │                  │                      ├──▶ FAILED ──retry──▶ QUEUED
   │                  │                      ├──▶ NEEDS_INPUT ──回答──▶ QUEUED
   │                  │                      ├──▶ WAITING_CHILDREN ──子任务全部结束──▶ QUEUED
   │                  │                      └──▶ BLOCKED
   └──cancel────────────────────────────────▶ CANCELLED
```

`NEEDS_INPUT` 与 `WAITING_CHILDREN` 是暂停而不是失败：它们释放租约，并退回这次 attempt 的重试额度，
只消耗 `resume_rounds`；上限与语义见 [agent-control.zh-CN.md](agent-control.zh-CN.md)。

### 4.2 实例

```
STARTING → ONLINE ⇄ SUSPECT → OFFLINE
              └── DRAINING ──┘
```

### 4.3 租约

- 默认 300s，构建机每 60s 续租。
- 到期未续 → 回收 attempt，任务重新入队。
- 每次 attempt 生成递增的 `fencing_token`；结果上报必须带当前 token，旧 token 一律拒绝。

---

## 5. 重试与死信

| 配置 | 默认 | 说明 |
|---|---|---|
| `max_attempts` | 3 | 可重试失败的最大尝试次数 |
| `retry_backoff` | 指数退避 5m / 15m / 45m | 按尝试次数递增，即 `retry` 动作的退避表 |
| `failure_class` | 每次失败推导 | `permanent` / `outward` 直接死信，`transient` 重试，`rate_limit` 与 `busy` 等待且不消耗尝试次数（受 `retry_waivers` 限制，最多 6 次） |
| `deadline_at` | 无 | 超时任务置 FAILED |
| `BLOCKED` | 达到上限 | 等待人工重新提交或重置 |
| 外部操作 | — | attempt 已对工作区外产生副作用后，失败一律不重试，任务以 `outcome: interrupted_after_outward` 进死信 |

---

## 6. 工作流（精简）

v4 只保留一个内置工作流：

```
wft_build = [ EXECUTE(task.build) ]
```

- 一个任务 = 一次构建，不再有 REVIEW / APPROVE / COMMIT / VERIFY 阶段。
- 需要多步时，由 Agent 在一次任务里完成，或连续提交多个任务。
- `requirements.build.command` 仍是底层能力（脚本、冒烟测试）；管理端提交的是
  `requirements.build.instruction`，没有 Agent 的构建机会拒绝执行。
- 保留 `workflow_runs` 表是为了兼容 v3 数据与未来扩展；v4 不暴露工作流配置页面。

---

## 7. API（最小集）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/tasks` | 提交任务 |
| `GET` | `/v1/tasks` | 任务列表 |
| `GET` | `/v1/tasks/:id` | 任务详情（含 attempts/events） |
| `POST` | `/v1/tasks/:id/cancel` | 取消 |
| `GET` | `/v1/queue/stats` | 队列统计 |
| `POST` | `/v1/instances/register` | 构建机注册 |
| `POST` | `/v1/instances/:id/heartbeat` | 心跳 |
| `POST` | `/v1/claim` | 领取任务 |
| `POST` | `/v1/tasks/:id/start-ack` | 确认开始 |
| `POST` | `/v1/tasks/:id/progress` | 进度 |
| `POST` | `/v1/tasks/:id/result` | 结果（`SUCCEEDED` / `FAILED` / `CANCELLED` / `NEEDS_INPUT`） |
| `POST` | `/v1/tasks/:id/split` | 把 RUNNING 任务拆成子任务 |
| `POST` | `/v1/tasks/:id/answer` | 回答停住的问题并继续任务 |
| `GET` | `/v1/failure-signatures` | 最近的规范化失败签名 |
| `GET` | `/v1/instances` | 实例列表 |
| `GET` | `/v1/tasks/:id/artifacts` | 列出一个任务的文件（名称、媒体类型、大小、摘要、状态） |
| `GET` | `/v1/artifacts/:id/download` | 以原始字节下载一个已校验的文件 |
| `POST` | `/v1/builders` | 创建构建机（容器） |
| `POST` | `/v1/builders/:id/:action` | start/stop/restart/remove |
| `GET` | `/v1/events/stream` | SSE 事件流 |

文件通道：构建机通过 artifact 通道写出产物（`POST /v1/artifacts` 声明摘要，
`PUT /v1/artifacts/:id/content` 上传任意格式的原始字节，`POST /v1/artifacts/:id/complete` 由服务端重算
SHA-256）。上面两条运维路由负责列出和下载这些文件，不需要实例凭证——与其他运维路由处于同一信任边界，
由 PCS 负责认证调用方。

认证：实例用 Bearer token；管理应用用可选的管理令牌。v4 不再区分 viewer/operator/approver。

---

## 8. 数据表

| 表 | 用途 |
|---|---|
| `tasks` | 任务主表 |
| `task_attempts` | 每次领取 |
| `task_events` | 状态事件 |
| `failure_signatures` | 规范化失败聚类（`kind:sha256[...]`、出现次数、首末时间） |
| `role_instances` | 构建机/调度机实例 |
| `leases` | 租约与 fencing |
| `resource_reservations` | 资源预留 |
| `resource_profiles` | 资源画像 |
| `task_definitions` | 任务类型 → 目标角色 |
| `audit_logs` | 审计 |
| `approval_*` | **保留但不再写入**（v3 迁移兼容） |

---

## 9. 部署形态

单机 Compose 见 [deploy/compose.yaml](../deploy/compose.yaml)；控制面部署由 PCS 生成计划，
host-runtime 拉起官方 ubuntu 容器并写入 `/opt/platform/app/` 载荷。

```yaml
scheduler:
  image: ubuntu:24.04@sha256:<digest>
  ports: ["8443:8443"]
  environment:
    DATABASE_URL: postgres://platform:***@postgres:5432/scheduler
    PCS_PUBLIC_KEY_FILE: /opt/platform/keys/pcs-public.pem
    SCHEDULER_AUTH_TOKEN: ""          # 只在未配置 PCS 公钥时作为本地开发兜底
  depends_on: [postgres]
```

- 单实例即可；不做 HA。
- 重启后从 PostgreSQL 恢复。
- 迁移脚本：`npm run migrate`，种子：`npm run seed`。

---

## 10. 验收清单

- [ ] 只有 `scheduler` 与 `builder` 两个角色。
- [ ] 任务从 QUEUED 到 SUCCEEDED 全链路可追踪。
- [ ] 构建机崩溃后任务在租约到期后重新入队。
- [ ] 旧 fencing token 的结果被拒绝。
- [ ] 管理应用无需切换角色即可执行所有操作。
- [ ] 构建机 SSH 可直接连接，不经过调度机。
- [ ] 任务事件与审计可查询。
