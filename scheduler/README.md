# 调度机

对应 [../docs/scheduler.md](../docs/scheduler.md)。调度机是唯一的状态权威：
「状态机 → 领取 → 租约 → 回收 → 重试」这条链路全部落在 PostgreSQL 事务里。
v4 只有两个角色（scheduler / builder），工作流只保留一步构建，没有审批与审核阶段。

技术栈：Node 22 + TypeScript + PostgreSQL 16（`pg` 直连，无 ORM）。没有 Redis、没有消息队列。

## 已实现

| 规范 | 内容 | 说明 |
|---|---|---|
| §4 状态机 | 表驱动迁移 + `409 STATE_CONFLICT` | 非法迁移在 `statemachine.ts` 一处拒绝 |
| §4.4 版本与并发 | `version` 乐观锁、事件只追加（数据库触发器拦截 UPDATE/DELETE） | |
| §3.2 资格过滤 | 角色 / 任务类型 / 能力子集 / `payload_schema` / ONLINE / 主机状态 / `requirements.target_instance_id` | 能力级健康预留了 `unhealthy` 字段；定向任务只由指定实例领取 |
| §3.3 排序 | 有效优先级 + 入队时间 + `task_id` 的确定性排序 | 见下文「与规范的差异」 |
| §3.4 领取 | 单事务内 `FOR UPDATE SKIP LOCKED` + 准入 + 建租约 | 准入不通过则保持 `QUEUED` 并写 `resource_block_reason` |
| §3.5 并发 | `min(global, role_pool, instance, task_type)` + 宿主机预算 | 老化每 600s 提一级、封顶 P1，写 `TASK_AGED` |
| §5 租约 | `lease_token` / `fencing_token` / 启动窗口 30s / 续租 / 回收 | 旧 attempt 写入 `409 FENCING_STALE` |
| §6 准入 | 预留 `HELD → ACTIVE / RELEASED / RECLAIMED` | 预算判定是简化版，见「未实现」 |
| §8 重试 | 退避 5m/15m/45m、不可重试错误码、死信标记 | 退避表来自 `scheduler_config.retry_backoff_seconds`，可调；`PAYLOAD_INVALID` / `AUTH` 等不重试 |
| §10 接口 | 任务 API、Worker 协议接口、`healthz` / `readyz` / `queue/stats` | |
| §6.1 传输安全 | 原生 `https` 服务端；可选 mTLS 客户端证书 | 证书由内部 CA 签发；传输层身份与 Bearer/JWT 身份分开校验 |
| §7.3 / §7.10–7.12 | 能力收窄、`drain` / `resume`、配置同步、注销 | 能力有上限，只能收窄 |
| §8.1 Outbox | 状态迁移与 `outbox_events` 同事务写入；`GET /v1/events` 游标回放、`GET /v1/events/stream` SSE | SSE 只是通知，事实以 outbox 为准 |
| §7 工作流 | v4 模板 `wft_build` 只有一步 `EXECUTE(task.build)` | 阶段推进与结果上报同一事务；没有 REVIEW / APPROVE / VERIFY |
| §7.3 审批 | 代码仍保留审批表与验签逻辑，但 v4 默认不使用 | 种子工作流 `approval_policy_ref = NULL`，管理应用也没有审批入口 |
| §3.2 实例身份 | ES256 JWT：`sub` = instance_id，scope 决定权限，`assertSelf` 禁止跨实例 | 未配置 PCS 公钥时退回 `AUTH_TOKEN` 共享令牌（仅本地开发） |
| §7.8 制品 | `POST /v1/artifacts` → `PUT .../content` → `POST .../complete`；`GET .../content` 读取 | complete 时**服务端重算 SHA-256**，审批摘要取这个值；下载只授权属主或调度机在 `requirements.upstream_artifacts` 里交接过的实例 |
| P4 Agent/API | 注册与 config-sync 只带 `agent.profile_id` / `agent.version` / `api_profiles[]` 引用；claim 信封同样只带引用 | 调度机不加载 Profile 实现、不接触 `secret_ref` 的值；换 Agent 只改 PCS 绑定与实例配置 |
| 对话 / 容器终端 | `sql/004_chat_console.sql` 注册 `task.chat.<role>` / `task.console.<role>`，并补进实例允许任务类型 | 都是普通任务，沿用审计、租约、fencing；终端就是容器内完整 shell，与 SSH 等价 |

## 未实现（下一步）

- 审批请求的过期扫描、对象变更后的批量 `INVALIDATED`。
- 实例令牌的自动续期（PCS 签发 24h，到期前需重新挂载）。
- OIDC / 用户登录：调度机只验令牌，管理面的用户认证在 PCS / 管理应用侧。
- 客户端证书与实例身份的映射：mTLS 只作为传输层门槛，实例身份仍以 JWT `sub` 为准。
- 两阶段准入的另一半：`HELD` 由 Host Runtime 复检后 `ACTIVE` 的**跨进程**握手（当前在 start-ack 时转 ACTIVE）。
- Redis Streams / 外部消息总线：目前 SSE 直接轮询 outbox，单控制面够用，跨进程广播要等消息层。
- 事件保留策略（规范要求 30 天）与归档清理任务。
- 指标 `/metrics`。
- 对象存储与预签名 URL：当前制品落本地目录，接口语义不变。

## 对话与受控终端（P5 增补）

- `task.chat.<role>`：请求体在 `requirements.chat`（`session_id` / `message` / `history`）；
  Host Runtime 的确定性执行器或绑定的 Agent 返回 `outputs.reply` 与 `outputs.mode`。
- `task.console.<role>`：请求体在 `requirements.console`；Host Runtime 在容器内跑完整
  shell（没有命令白名单，与 SSH 等价），调度机只负责派发和记账。
- 两类任务都可以用 `requirements.target_instance_id` 定向到具体构建机；claim 的候选 SQL
  会过滤不匹配的实例。
- 任务定义 `max_attempts=1`，避免对话/终端命令被重复执行；失败作为终态记录。

## 目录

```
src/
├── statemachine.ts      # 迁移表（唯一一处判断“什么能变成什么”）
├── db.ts                # 连接池、事务、数据库时间
├── auth.ts              # 实例鉴权：JWT 验签、scope、assertSelf；共享令牌兜底
├── jwt.ts               # ES256 JWT 验签（不引第三方库）
├── core/claim.ts        # 领取：资格 + 准入 + 租约，一个事务
├── core/attempts.ts     # start-ack / renew / progress / result（终结时推进工作流）
├── core/workflow.ts     # 工作流阶段推进 + 审批决策
├── core/artifacts.ts    # 制品登记、落盘、服务端摘要校验
├── loops/reaper.ts      # 启动窗口超时、租约过期 → 回收 / 回队 / 死信
├── repo/instances.ts    # 注册、心跳、SUSPECT/OFFLINE、drain/resume、注销、config-sync
├── repo/outbox.ts       # 事件游标读取（SSE / 轮询 API）
├── repo/task-insert.ts  # 最小任务写入单元（工作流与任务仓储共用，避免循环依赖）
├── repo/tasks.ts        # 任务 CRUD、取消、事件查询
├── http/server.ts       # 裸 node:http 路由
└── main.ts              # 进程入口 + 两个后台扫描
sql/001_init.sql         # schema（§9 + [增补] 字段）
sql/002_seed.sql         # 演示数据（scheduler + 3 台 Ubuntu 构建机 + wft_build 模板）
sql/003_profiles.sql     # [增补] role_instances.agent_profile_version / api_profile_ids
sql/004_chat_console.sql # [增补] task.chat.* / task.console.* 任务定义与实例白名单
test/                    # 51 个用例，含故障注入
scripts/demo.sh          # 端到端 HTTP 演示
scripts/reset.sh         # 清库重灌演示数据
scripts/dev-server.sh    # 起停
```

## 快速开始

前置：PostgreSQL 16 已启动，`pg` 能连上。

```bash
npm install
npm run migrate            # 建库 + 建表
npm run seed               # 演示数据（可选）
npm test                   # 需要 scheduler_test 库：DATABASE_URL=... npm run migrate

npm start                  # 监听 127.0.0.1:7801
./scripts/demo.sh          # 另开终端，跑端到端演示

# 事件：SSE 实时流 / 游标回放
curl -N "http://127.0.0.1:7801/v1/events/stream?after=0"
curl "http://127.0.0.1:7801/v1/events?after=0&limit=50"

# 工作流：起构建流程 → 看结果（v4 只有一步构建）
curl -X POST http://127.0.0.1:7801/v1/workflows -H 'content-type: application/json' \
  -d '{"workflow_template_id":"wft_build","payload_ref":"git://repo/demo"}'
curl http://127.0.0.1:7801/v1/workflows/<run_id>

# 或者直接提交一个构建任务
curl -X POST http://127.0.0.1:7801/v1/tasks -H 'content-type: application/json' \
  -d '{"task_type":"task.build","priority":2,
       "requirements":{"build":{"command":"npm test","workdir":"."}}}'
```

鉴权怎么开：`pcs-issuer` 里 `npm run keygen` 生成密钥，调度机设
`PCS_PUBLIC_KEY_FILE=../pcs-issuer/keys/public.pem`；实例令牌用
`npm --prefix ../pcs-issuer run issue -- instance --id builder-ubuntu22-a ...` 签发后放进 Host Runtime 的 `token_dir`。

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:sched_dev_pw@127.0.0.1:5432/scheduler` | |
| `PORT` | `7801` | |
| `HOST` | `127.0.0.1` | 监听地址；生产放内网并启用 TLS/mTLS |
| `TICK_MS` | `1000` | 后台扫描周期 |
| `DISABLE_LOOPS` | 未设置 | 设 `1` 只跑 HTTP，不跑扫描（单元测试用） |
| `PCS_PUBLIC_KEY_FILE` | 未设置 | PCS 公钥 PEM 路径；设置后实例接口只接受 ES256 JWT（legacy 审批验签也用它） |
| `PCS_PUBLIC_KEY` | 未设置 | 同上，直接给 PEM 内容（换行可写 `\n`），优先于文件 |
| `ARTIFACT_DIR` | `./data/artifacts` | 制品落盘目录；生产换成对象存储后此接口语义不变 |
| `AUTH_TOKEN` | 未设置 | **过渡兜底**：没配 PCS 公钥时的共享 Bearer 令牌；配了公钥则忽略 |
| `SCHEDULER_TLS_CERT_FILE` | 未设置 | 服务端证书 PEM；与 `SCHEDULER_TLS_KEY_FILE` 必须同时配置 |
| `SCHEDULER_TLS_KEY_FILE` | 未设置 | 服务端私钥 PEM |
| `SCHEDULER_TLS_CA_FILE` | 未设置 | 客户端证书校验 CA；启用 mTLS 时必填 |
| `SCHEDULER_MTLS` | 未设置 | 设 `1` 要求客户端证书；需要 CERT/KEY/CA 全部就绪 |

> v4 默认工作流不使用审批；审批接口保留但未配置 PCS 公钥时会 `503 APPROVAL_NOT_CONFIGURED`。

启用 TLS / mTLS：

```bash
../scripts/pki.sh /secure/pki       # 生成内部 CA、scheduler 服务端证书、共享 client 证书
SCHEDULER_TLS_CERT_FILE=/secure/pki/scheduler.crt \
SCHEDULER_TLS_KEY_FILE=/secure/pki/scheduler.key \
SCHEDULER_TLS_CA_FILE=/secure/pki/ca.crt \
SCHEDULER_MTLS=1 \
npm start
```

服务端证书 SAN 必须包含客户端实际使用的地址（默认 `localhost` / `127.0.0.1`，
其他地址由 `pki.sh` 的额外参数加入）。客户端证书只作为传输层门槛，
实例身份仍取自 JWT；没有证书或证书不受信时 TLS 握手直接失败。
P6 验收脚本见 `../scripts/e2e-p6.sh`。

## 三个关键设计决定

**1. 时间只来自数据库。**
租约到期、SUSPECT 判定、退避窗口全部用 `app_now()`，不用 `Date.now()`。
`app_now()` 读一张 `_clock` 表，生产环境 offset 恒为 0 等价于 `now()`；
测试把它当时间机器，验证「45 秒没心跳」「301 秒租约过期」不需要真的 sleep。

**2. 领取是一条 SQL，不是一个流程。**
`SELECT ... FOR UPDATE SKIP LOCKED` + 同事务写 attempt/lease/reservation。
应用层没有「先查后改」，所以两个实例并发领取只可能有一个成功（`leases_one_active_per_task` 唯一索引兜底）。

**3. fencing 是重复执行的最后一道闸。**
调度机只能保证「至少一次投递」，做不到 exactly-once。
旧 attempt 的任何写入（start-ack / progress / result）都会因为 `fencing_token < max(fencing_token)` 被拒，
所以业务任务的幂等键仍必须由任务本身提供。

## 工作流与审批（§7）

模板（`workflow_templates`）由 PCS 维护，调度机只读。阶段序列固定为
`EXECUTE → REVIEW → APPROVE → COMMIT → VERIFY`，每个阶段一个任务，`parent_task_id` 指向上一阶段。

- **推进和结果同一事务**：`submitResult` 里「任务 SUCCEEDED + 建下一阶段任务」一起提交，
  不会出现任务成功但下一阶段没入队的缺口；迟到的旧阶段任务（`run.current_task_id` 不匹配）不推进。
- **APPROVE 不创建任务**：工作流停在 `WAITING_APPROVAL`，插入一条 `PENDING` 的 `approval_requests`，
  同时固化上一阶段**制品**的 `subject_digest`（模板可要求 `artifact_required`，没有制品直接拒绝）。
- **审批只认签名令牌**：`POST /v1/tasks/{id}/approve` 的 `approval_token` 必须是 PCS 签发的 ES256 JWT，
  且 `approval_request_id`、`operator_id`、`subject_digest`、`action_scope` 与待决请求逐项一致；
  `jti` 落库唯一，不能重放。聊天里的“批准了”不作为输入。
- **失败即结束**：不可重试失败 → 工作流 `FAILED`；取消 → `CANCELLED`；拒绝审批 → `FAILED`。
  任何情况下都不自动跳阶段，也不由 Agent 猜测冲突怎么解。
- **未配置就不放行**：没有 PCS 公钥时审批接口 `503 APPROVAL_NOT_CONFIGURED`，不降级成共享令牌。

## 与规范的差异

- **§3.3 的排序方向**：`ORDER BY effective_priority ASC`。老化公式
  `max(1, priority_class - floor(wait/600))` 是**减小**数值、封顶到 1（= P1），
  只有升序才与「P0 > P1 > P2 > P3」自洽。规范原文写的是 `DESC`，已按此修正（§3.3、§3.4 伪代码、§9 索引）。
- **`app_now()` 替代 `now()`**：语义等同，只为可测试。
- **[增补] 字段**：`tasks.next_attempt_at`（退避窗口）、`tasks.dead_letter`、
  `task_definitions.retryable_errors`、`scheduler_config` 表，
  `role_instances.agent_profile_version` / `api_profile_ids`（P4 只用引用），
  规范 §9 未列，实现需要。
- **实例状态**：`SUSPECT` 不参与新领取，在途租约继续（§5 的做法），不与租约回收混在一起。
- **鉴权**：已实现 PCS 签发 ES256 实例 JWT（`sub`/`role`/`host_id`/`scopes`），
  令牌主体与请求里的 `instance_id` 强绑定，scope 按接口校验。传输层支持原生 TLS
  与可选 mTLS（客户端证书），但不把证书 CN 映射为实例身份；令牌自动续期尚未做。
  `AUTH_TOKEN` 只作为未配置公钥时的本地开发兜底。
- **审批令牌**：v4 默认不使用审批链路；代码保留验签逻辑只为兼容旧数据，私钥不进调度机。
- **制品存储**：本地目录 + 同步写，生产换对象存储 + 预签名 URL；`complete` 的
  服务端摘要校验逻辑不变。
- **路径与参数位置**：实现用 `/v1/...`，`register` / `heartbeat` / `claim` 仍从 body 取
  `instance_id`；规范是 `/api/v1/instances/{instance_id}/...`。协议语义一致，路径风格待统一。
- **config-sync 只同步引用**：返回 `config_version`、`allowed_task_types`、能力与调度策略，
  以及 `agent {profile_id, version, args}` / `api_profiles[]` 引用；`resource_profile` 仍留空。
  Profile 的实现、`base_url` 与密钥值不在调度机。
- **能力上限来自注册声明**：没有独立 PCS 配置表，所以 `capability_ceiling` 取首次注册的声明并固化；
  要扩大只能改配置后重新注册。
- **drain 超时的回收节奏**：drain 超时先把实例置 `OFFLINE`，在途租约按正常过期时间回收，
  不在 drain 时抢跑释放（避免实例还在写、调度机已经重派）。
- **SSE 直接轮询 outbox**：没有 Redis / 消息队列；每个连接 500ms 查一次 `event_id > cursor`。
  并发事务提交顺序可能和 `event_id` 顺序不一致，规范对此的处置是：通知允许丢，
  消费者按 `event_id` 去重、按 `aggregate_version` 判序，发现缺口回查 `GET /v1/events`。

## 验收对照

`npm test` 的 51 个用例对应规范 §13。

- 状态机非法迁移被拒、事件不可改
- 并发领取不重不漏（3 实例 / 30 任务 / 并发抢）
- 租约过期回收、启动窗口超时、预留 `RECLAIMED`
- 旧 attempt 迟到结果被 `FENCING_STALE` 挡住
- 重试退避、重试耗尽死信、不可重试错误立即失败
- 45s → SUSPECT 停止领取、90s → OFFLINE、在途租约不被心跳扫描回收
- 老化排序、P0 不老化、主机 PROTECTING 停派、内存不足保持 QUEUED
- 能力只能收窄；drain 停派且心跳不能撤销；drain 超时 OFFLINE；在途任务阻止注销；config-sync 304；令牌校验
- outbox 与任务同事务写入、游标续传、只允许追加
- 工作流全阶段推进（含 APPROVE 停等）；审批令牌验签、请求绑定、摘要不匹配、jti 重放；实例 JWT 签名/受众/scope/跨实例伪装；制品摘要被篡改时 complete 失败
- 不可重试失败 / 取消终结工作流；未知模板 404；无 PCS 公钥时审批 fail closed
- 制品下载授权：属主可读；未交接的实例 `403`；交接随 attempt 结束收回；未 complete 的制品 `409`
- 工作流推进时把上游已校验制品累积进下游任务的 `requirements.upstream_artifacts`（去重、上限 50），审批阶段写入 `approval_id` / `approval_subject_digest` / `approved_action_scope`；创建方自带的这些字段一律剥除，交接只能由调度机生成
- P4：claim 信封只含 Agent/API Profile 引用，不含实现、地址或密钥；config-sync 返回 `agent` 引用与 `api_profiles[]`；换 Agent 只改实例注册的引用，任务定义与调度代码不动

## P2 三进程验收

单元测试之外，[../scripts/e2e-p2.sh](../scripts/e2e-p2.sh) 在真实机器上跑
「调度机 + Host Runtime 准入 + 两个角色实例」的完整链路，覆盖：

- 两个实例并发领取，每个任务恰好一次执行（准入拒绝不算重复执行）
- 准入拒绝：任务回队、`attempt_count` 不变、按 claim 间隔退避而不是原地刷 attempt
- `kill -9` 角色实例 → 租约过期回收 → 另一实例重领（fencing+1）→ 旧结果 `409 FENCING_STALE`
- 调度机执行中重启：任务照常完成，只有一个 attempt、一次派发
- 无孤儿预留；崩溃实例重启后释放残留的 Host Runtime task grant

脚本用 `_clock` 时间旅行验证租约过期（每次 +602s），**只用于测试库**；
需要干净环境时先停掉角色实例，再跑 `scheduler/scripts/reset.sh`。

## v4 构建闭环

v4 只有一个工作流 `wft_build`：调度机派发 `task.build` → 构建机在容器内执行
`requirements.build.command` → 上传日志制品 → 工作流 `COMPLETED`。

```bash
# 构建
curl -X POST http://127.0.0.1:7801/v1/tasks -H 'content-type: application/json' \
  -d '{"task_type":"task.build","priority":2,
       "requirements":{"build":{"command":"make test","workdir":"."}}}'
# 终端（容器内完整 shell）
curl -X POST http://127.0.0.1:7801/v1/tasks -H 'content-type: application/json' \
  -d '{"task_type":"task.console.builder","requirements":{"console":{"command":"uname -a"}}}'
```

`task.build` 失败会保留日志制品并上报 `BUILD_FAILED` / `BUILD_TIMEOUT`；`task.console.*`
`max_attempts=1`，不会盲目重试。

## P4 Agent/API 验收

[../scripts/e2e-p4.sh](../scripts/e2e-p4.sh) 在真实机器上验证 P4 的验收门槛：

- **同角色换 Agent 不改代码**：PCS 把 `builder-ubuntu22-a` 从 `agp_builder_alpha` 改绑到 `agp_builder_beta`，
  只更新实例配置并滚动重启；两次产物 marker 分别为 `alpha` / `beta`，调度机只更新 Profile 引用
- **信封只有引用**：任务记录与 attempt 结果里没有 `entrypoint`、`base_url` 或密钥明文
- **越权 tool call 被拒**：`demo.forbidden` 不在 Profile 白名单 → `TOOL_NOT_ALLOWED`，审计记 DENY
- **默认拒绝出站**：指向 `169.254.169.254` 的 API Profile 被 `EGRESS_IP_BLOCKED` 挡住，
  即使 egress 白名单里写了这个地址
- **API 必须经本地代理**：upstream 只接受 Adapter 注入的 Bearer，Agent 直连得到 401
- **配额**：Profile `rpm=2`，第三次本地代理调用返回 429
- **Secret 实例隔离**：构建机 A 的 JWT 解析不了构建机 B 的 `secret_ref`（`SECRET_NOT_ALLOWED`）；
  吊销实例后立即 `INSTANCE_REVOKED`
- **Agent 崩溃**：Adapter 退出后 role-agent 仍 `ONLINE`，任务以 `AGENT_CRASHED` 失败上报（可重试）

脚本会重置演示库并把 PCS/Secret Store/mock upstream 一并拉起；跑完后 `builder-ubuntu22-a`
保留 beta 绑定，需要回到纯确定性构建时先解绑 Profile 或清掉 `runtime.config.json` 的
`profiles_file`。

