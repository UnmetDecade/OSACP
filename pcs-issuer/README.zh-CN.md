# pcs-issuer · 平台控制面（PCS）

> [English](README.md) · 简体中文

PCS 是平台控制面：主机名册、部署计划、签名命令、Agent/API 档案、Secret Store 接入与审计。
它不直接操作 Docker，所有容器动作都以签名命令下发给主机上的 host-runtime。

对应 [../docs/federation.zh-CN.md](../docs/federation.zh-CN.md) 与 [../docs/architecture.zh-CN.md](../docs/architecture.zh-CN.md)。

## 边界

- 私钥只在这里（`keys/private.pem`、`keys/command-private.pem`，0600），
  **不进调度机、不进 Host Runtime、不进角色容器、不进日志**。
- Host Runtime 只拿 `command-public.pem` 验部署意图；调度机只拿 `public.pem` 验 JWT。
- 没有用户登录、没有 OIDC、没有审批中心 UI；管理应用用 `PCS_ADMIN_TOKEN` 访问管理面。
- 没有 JWKS 端点与密钥轮换；公钥以文件形式分发。
- 单控制面、非 HA；PostgreSQL 只监听本机，不暴露到 WAN。
- 已支持原生 TLS 与可选 mTLS（客户端证书）；Bearer `host_token` / admin JWT 仍逐请求校验，
  传输层身份不替代令牌身份。
- 主机证书自动签发与 90 天轮换尚未实现：当前客户端证书由 `scripts/pki.sh` 预置，
  注册流程只发 `host_token`，不签发证书；生产需补证书生命周期管理或由企业 CA 承担。

## 准备

```bash
npm install
npm run keygen     # 生成 ES256 JWT 密钥 + Ed25519 命令签名密钥（已存在则保留，--force 才覆盖）
npm run migrate    # 建库（若不存在）并应用 sql/001_init.sql + sql/002_profiles.sql
```

数据库默认 `postgres://postgres:sched_dev_pw@127.0.0.1:5432/platform_control`，
用 `PCS_DATABASE_URL` 覆盖。管理面与调度机测试库分开，互不影响。

## 签发（调度机侧令牌）

```bash
# 实例令牌（24h）
npm run issue -- instance --id builder-a --role builder --host host-a \
  --out ../host-runtime/run/tokens/builder-a.jwt

# 审批令牌（10 分钟，绑定请求 + 对象摘要 + 动作范围）
npm run issue -- approval --request aprq_xxx --operator alice \
  --digest sha256:... --scope svn.commit --out /tmp/approval.jwt

# 管理员令牌（8h，仅用于下面的管理面 CLI）
npm run issue -- admin --operator alice --out /tmp/admin.jwt
```

实例的 scope 决定它能调哪些接口：`instance:register`、`instance:claim`、`task:report`、
`config:read`、`artifact:write`、`artifact:read`。审批令牌固定带 `approval:decide`。
审批令牌的声明与调度机的绑定检查一一对应：`approval_request_id`、`operator_id`、
`subject_digest`、`action_scope`；`jti` 落库唯一，不能重放。

调度机侧：

```bash
PCS_PUBLIC_KEY_FILE=$PWD/../pcs-issuer/keys/public.pem npm start
```

## 管理面（Host Runtime）

启动：

```bash
PCS_IMAGE_ALLOWLIST=docker.m.daocloud.io/library/ \
PCS_NETWORK_POLICIES=default \
npm start
```

默认监听 `127.0.0.1:7901`，只应有 Host Runtime 能访问。

TLS / mTLS：

```bash
../scripts/pki.sh /secure/pki
PCS_TLS_CERT_FILE=/secure/pki/pcs.crt \
PCS_TLS_KEY_FILE=/secure/pki/pcs.key \
PCS_TLS_CA_FILE=/secure/pki/ca.crt \
PCS_MTLS=1 \
PCS_PUBLIC_URL=https://pcs.internal:7901 \
npm start
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PCS_TLS_CERT_FILE` | 未设置 | 服务端证书；与 `PCS_TLS_KEY_FILE` 必须同时配置 |
| `PCS_TLS_KEY_FILE` | 未设置 | 服务端私钥 |
| `PCS_TLS_CA_FILE` | 未设置 | 客户端证书校验 CA；启用 mTLS 时必填 |
| `PCS_MTLS` | 未设置 | 设 `1` 要求客户端证书 |
| `PCS_PUBLIC_URL` | 由请求推断 | 对外基址，用于 enroll 响应里的管理面 URL；经过代理时必须显式设置 |

证书 SAN 要包含 Host Runtime 实际访问的地址。客户端证书是共享的传输层凭据，
主机身份仍以 enroll 得到的 `host_token` 为准；吊销主机不会吊销证书。

### 多主机接入

本地主机与 SSH 主机走同一套部署通道，只差「引导」这一步怎么把 host-runtime 送上去：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PCS_CREDENTIAL_KEY_FILE` | 未设置 | 32 字节密钥文件（0600），AES-256-GCM 加密 SSH 私钥；未配置时只能接本地主机 |
| `PCS_RUNTIME_SOURCE_DIR` | `../../host-runtime` | 引导时用 esbuild 打包 host-runtime 的源码目录 |
| `PCS_RUNTIME_URL` | 未设置 | 远程主机访问 PCS 的地址，如 `http://pcs.example:7901`；本地主机固定用 `127.0.0.1` |
| `PCS_RUNTIME_NODE` | `node` | 远程主机上的 Node 22+ 可执行文件路径 |
| `PCS_HOST` | `127.0.0.1` | 远程主机要入网时设为 `0.0.0.0`（或放在反向代理后面） |
| `PCS_NETWORK_POLICY_MAP` | 未设置 | 策略名到 Docker 网络名的 JSON 映射，如 `{"default":"platform-net"}`；引导 host-runtime 时写入，未列出时 `default` 落 `bridge` |
| `PCS_SCHEDULER_IMAGE` | 未设置 | 调度机容器镜像（digest 固定）；未设置时用所选 Agent Profile 的 `artifact_image` |
| `PCS_SCHEDULER_DATABASE_URL` | 未设置 | 调度机容器的数据库地址，由 PCS 注入部署计划，不出现在管理界面 |
| `PCS_SCHEDULER_URL` | 未设置 | 构建机容器访问调度机 API 的地址，如 `http://platform-scheduler:8443`；由 PCS 注入 `SCHEDULER_URL`，缺失时构建机部署计划校验失败 |
| `PCS_SCHEDULER_SYNC_URL` | 同 `PCS_SCHEDULER_URL` | PCS 自己访问调度机的地址（主机视角，如 `http://127.0.0.1:8443`）；主机上报时把状态与资源推送到调度机的 `/v1/hosts`，调度机据此做派发准入 |

```bash
umask 077 && openssl rand -out ~/.config/platform/pcs-credential.key 32

PCS_HOST=0.0.0.0 \
PCS_RUNTIME_URL=http://pcs.example:7901 \
PCS_CREDENTIAL_KEY_FILE=$HOME/.config/platform/pcs-credential.key \
PCS_IMAGE_ALLOWLIST=docker.m.daocloud.io/library/ \
npm start
```

- `POST /hosts/local` 幂等登记 PCS 所在机器；引导直接在本机执行，用 PCS 自己的 node。
- `POST /hosts/ssh` 接收 PEM / OpenSSH 私钥，加密入库后立即探测；接口只返回
  `key_fingerprint`，没有读回私钥的接口。
- 探测与引导使用系统 `ssh` 客户端：私钥临时写入 0600，`BatchMode=yes`、
  `IdentitiesOnly=yes`、独立临时 `known_hosts`，20 秒超时。
- `POST /hosts/:id/bootstrap` 先补齐远程环境，再写入 `$HOME/.platform/host-runtime/<host_id>/`
  并启动，等待入网最多 20 秒：已在线返回 200，未在线返回 202 并带引导日志。重复调用只重启该目录。
- 环境补齐：缺 Node 22 时从 npmmirror 装到 `$HOME/opt`（不需要 sudo）；缺 Docker 时用
  `apt-get install docker.io` 安装并 `usermod -aG docker`。密码接入的主机把同一个密码经
  stdin 交给 `sudo -S`（不进命令行）；只有私钥且 sudo 不免密时返回
  `BOOTSTRAP_ENV_FAILED`，说明缺的是 Node 还是 Docker、以及为什么装不了。
- 远程主机仍需能访问 `PCS_RUNTIME_URL`；镜像照样必须 digest 固定并落在
  `PCS_IMAGE_ALLOWLIST` 前缀内。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/v1/platform/hosts` | admin `host:admin` | 建主机，返回一次性注册令牌（10 分钟、单次使用） |
| POST | `/api/v1/platform/hosts/local` | admin `host:admin` | 登记 PCS 所在的本地主机并探测（幂等） |
| POST | `/api/v1/platform/hosts/ssh` | admin `host:admin` | 用 SSH 私钥建远程主机；私钥加密入库，只返回指纹 |
| POST | `/api/v1/platform/hosts/:id/probe` | admin `host:admin` | 探测系统 / Docker / 连通性，只读 |
| POST | `/api/v1/platform/hosts/:id/bootstrap` | admin `host:admin` | 安装并启动 host-runtime；已入网返回 200，否则 202 |
| GET | `/api/v1/platform/hosts/:id` | admin `host:read` | 主机详情：接入方式、指纹、最近探测、部署 |
| POST | `/api/v1/platform/hosts/enroll` | 注册令牌 | 换取 `host_id` + host JWT（24h）+ 命令公钥 |
| GET | `/api/v1/platform/hosts` | admin `host:read` | 主机列表与最近上报 |
| POST | `/api/v1/platform/hosts/:id/revoke` | admin `host:admin` | 吊销：拒绝鉴权、部署与后续命令 |
| POST | `/api/v1/platform/deployments` | admin `deployment:write` | 创建部署意图（签名的 DEPLOY 命令） |
| GET | `/api/v1/platform/deployments` | admin `deployment:read` | 部署与期望态/实际态 |
| POST | `/api/v1/platform/deployments/:id/{start,stop,restart,remove}` | admin `deployment:write` | 下发动作命令 |
| POST | `/api/v1/platform/runtime/heartbeat` | host JWT | 心跳与主机状态 |
| GET | `/api/v1/platform/runtime/commands?wait=30` | host JWT | 长轮询取命令（无命令返回 204） |
| POST | `/api/v1/platform/runtime/commands/:id/ack` | host JWT | 幂等确认执行结果 |
| POST | `/api/v1/platform/runtime/report` | host JWT | 上报运行时/资源/容器实际态 |
| POST | `/api/v1/platform/runtime/token/renew` | host JWT | 续签 host JWT |

命令安全属性：

- **Ed25519 签名**覆盖规范化 JSON（键排序、无空白），Host Runtime 验签失败即拒绝。
- **固定 digest**：镜像必须形如 `repo@sha256:<64 hex>`，且在 `PCS_IMAGE_ALLOWLIST` 前缀内。
- **generation 单调**：同一实例每次变更 +1；旧命令被 Host Runtime 以 `STALE_GENERATION` 丢弃。
- **command_id 幂等**：超时重投由 Host Runtime 去重，不重复执行。
- **失败不盲目重试**：超过 `PCS_COMMAND_MAX_ATTEMPTS` 记为 FAILED，需要新的部署意图。
- **凭据不进命令**：env 中出现 `secret/token/password/credential/private_key` 类键直接拒绝；
  卷只允许命名卷，挂载点必须在 `/opt/platform/` 下。
- **吊销立即生效**：REVOKED 主机无法鉴权、无法创建部署、无法接收动作；已在运行的容器不由 PCS 杀。

### 管理 CLI

```bash
export PCS_ADMIN_TOKEN=$(npm run --silent issue -- admin --operator alice)
export PCS_URL=http://127.0.0.1:7901

npm run pcs -- host-add --name ubuntu22
npm run pcs -- host-list
npm run pcs -- deploy --host hst_xxx --role builder \
  --image registry.example/builder@sha256:... \
  --cpu 0.5 --memory-mib 512 --command sleep,3600 \
  --env ROLE_ID=builder --volume workspace:/opt/platform/workspace
npm run pcs -- deployments --host hst_xxx
npm run pcs -- action --deployment dep_xxx --action stop
npm run pcs -- host-revoke --host hst_xxx
```

注册令牌只打印一次，应直接交给 Host Runtime 的 `PCS_ENROLLMENT_TOKEN`，不要写进配置文件或日志。

## Agent / API Profile（P4）

PCS 保存 Agent 与 API 的**配置与引用**：表里只有 `secret_ref`，**没有任何密钥值**。
Host Runtime 通过 `resolve` 拿到运行时视图（adapter、entrypoint、base_url、secret_ref），
密钥值只能由实例凭自己的 JWT 去 Secret Store 换取。

### 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/v1/platform/agent-profiles` | admin `profile:write` | 建 Agent Profile（角色/adapter 矩阵、镜像 digest、工具与任务类型白名单） |
| GET | `/api/v1/platform/agent-profiles` | admin `profile:read` | 列表 |
| PATCH | `/api/v1/platform/agent-profiles/:id` | admin `profile:write` | 修改或启停用；角色不可改 |
| DELETE | `/api/v1/platform/agent-profiles/:id` | admin `profile:write` | 删除；仍被实例绑定时 `409 PROFILE_IN_USE` |
| POST | `/api/v1/platform/api-profiles` | admin `profile:write` | 建 API Profile（https-only、`secret://` 引用、配额、egress、fallback） |
| GET | `/api/v1/platform/api-profiles` | admin `profile:read` | 列表 |
| PATCH | `/api/v1/platform/api-profiles/:id` | admin `profile:write` | 修改或启停用；类型不可改 |
| DELETE | `/api/v1/platform/api-profiles/:id` | admin `profile:write` | 删除；被实例、Agent 或 fallback 引用时 `409 PROFILE_IN_USE` |
| PUT | `/api/v1/platform/api-profiles/:id/secret` | admin `profile:write` | 写入该 Profile 的 API Key：转发给 Secret Store，PCS 不落库、不回显；未配置 Secret Store 时 `503` |
| GET | `/api/v1/platform/bindings` | admin `profile:read` | 全部实例的 Agent / API 绑定 |
| POST | `/api/v1/platform/instances/:id/bind-agent` | admin `profile:write` | 绑定 Agent；body `{agent_profile_id, role_id}`，跨角色拒绝 |
| POST | `/api/v1/platform/instances/:id/bind-api` | admin `profile:write` | 绑定 API |
| DELETE | `/api/v1/platform/instances/:id/bind-api/:api` | admin `profile:write` | 解绑 API |
| GET | `/api/v1/platform/instances/:id/resolve` | admin `profile:read` | 运行时视图；无绑定回 `404 BINDING_NOT_FOUND`，**不含密钥值** |
| GET | `/api/v1/platform/audit-logs?limit=` | admin `profile:read` | Profile 创建、绑定、解绑审计 |

管理员 scope 新增 `profile:read` / `profile:write`。

### CLI

```bash
export PCS_ADMIN_TOKEN=$(npm run --silent pcs -- admin-token --operator alice)

npm run pcs -- agent-profile-add --role builder --name demo-alpha --version 1.0.0 \
  --image registry.example/agents/demo@sha256:... \
  --allowed-tools demo.echo,api.call --task-types task.agent.probe \
  --entrypoint /usr/bin/node,/opt/agents/demo.mjs,--marker=alpha
npm run pcs -- agent-profiles

npm run pcs -- api-profile-add --name mock --kind tool \
  --base-url http://127.0.0.1:18090 --secret-ref secret://apis/mock \
  --quota '{"rpm":2}' --egress egress-mock --scopes probe.read
npm run pcs -- api-profiles

npm run pcs -- bind-agent --instance builder-a --agent agp_xxx --role builder
npm run pcs -- bind-api --instance builder-a --api api_xxx
npm run pcs -- resolve --instance builder-a
npm run pcs -- audit --limit 20
```

`api.egress` 只是策略**名字**；具体白名单在 Host Runtime 的 `runtime.config.json`
（`egress_policies`）里，PCS 不保存网络策略本身。

开发环境允许回环 `http://127.0.0.1` 的 API Profile 需显式开启：

```bash
PCS_ALLOW_INSECURE_API_URLS=1 npm start
```

生产环境不设该变量，Profile 只接受 `https`。Secret 引用必须形如 `secret://<path>`；
把密钥明文放进 `secret_ref`、`base_url` 或 env 会被直接拒绝。

控制台直接填 API Key 需要配置 Secret Store：

```bash
PCS_SECRET_STORE_URL=http://127.0.0.1:7902 \
PCS_SECRET_STORE_ADMIN_TOKEN=<Secret Store 的 SECRET_STORE_ADMIN_TOKEN> \
npm start
```

`PUT /api-profiles/:id/secret` 只把值转发给 Secret Store（`PUT /v1/secrets`），
PCS 的数据库、日志与响应里都只有 `secret_ref`。未配置时接口返回
`503 SECRET_STORE_NOT_CONFIGURED`，界面仍可只填引用。

## 测试

```bash
npm test        # 自动迁移 platform_control_test 后运行
```

覆盖：注册令牌一次性/过期、管理员 scope、签名与镜像/grant 校验、长轮询与幂等确认、
上报推进 HEALTHY/MISSING、吊销、按 host 隔离；以及 P4 的 Agent 角色/adapter 矩阵、
固定 digest 镜像、`secret_ref` 只存引用、API Profile https-only、
跨角色绑定拒绝、`resolve` 不含密钥值、Profile 审计（11 个用例）。
