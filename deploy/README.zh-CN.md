# 部署资产

> [English](README.md) · 简体中文

v4 的调度机与构建机都是容器，本目录是控制面部署所消费的资产。

| 文件 | 作用 |
|---|---|
| `compose.demo.yaml` | 一条命令的演示：PostgreSQL + PCS + 调度机 + 一台构建机 + 管理界面 |
| `builder/Dockerfile` | 演示用构建机镜像（控制面部署已改为裸 ubuntu） |
| `builder/entrypoint.sh` | 演示镜像入口 |
| `builder/app-entrypoint.sh` | 裸 ubuntu 构建机入口：从主机缓存取 Node/CLI/ssh，启动实例运行时 |
| `scheduler/Dockerfile` | 演示用调度机镜像（控制面部署已改为裸 ubuntu） |
| `scheduler/entrypoint.sh` | 演示镜像入口 |
| `scheduler/app-entrypoint.sh` | 裸 ubuntu 调度机入口：从主机缓存取 Node/CLI/ssh，迁移并启动 |
| `demo-initdb.sql` | 在演示用 PostgreSQL 数据卷里创建调度机数据库 |
| `pcs/Dockerfile`, `pcs/entrypoint.sh` | 演示用控制面镜像：生成密钥、迁移数据库、签发演示管理令牌 |
| `web/Dockerfile`, `web/nginx.conf` | 演示用界面镜像：托管管理端静态资源，同源代理 PCS 与调度机 |

## 演示（一条命令）

```bash
scripts/demo.sh
```

自动构建 PostgreSQL + PCS + 调度机 + 管理端，启动后输出
`http://127.0.0.1:18080`（可用 `DEMO_PORT` 改端口；调度机默认发布在
`127.0.0.1:18443`）。密钥、管理令牌和数据库密码都会自动生成；只对回环地址
开放端口。首次运行需要构建四个镜像，耗时几分钟。

演示按示例工程的故事线准备：一台开发机上有界面、中间层、驱动三个构建机；一台
折叠进来的内核主机自带调度机实例和构建机；开发、测试、售后通过三个侧载令牌接入。
脚本还会提交几条 Shell 任务，让工作室里有运行中、已完成和排队中的工作。

用 **admin / admin** 登录。这个密码只在演示模式预置，并且绕过了正常的长度策略；
它存在的前提是演示界面只绑定回环地址。真实部署里第一个注册的账号成为管理员，
密码至少 10 位。

停止：`scripts/demo.sh --down`（加 `--volumes` 同时删除数据）。

演示不打包 host-runtime，也不挂载 Docker socket，因此不支持主机接入：添加主机时
会直接提示「演示模式不支持添加主机」。调度机和构建机以静态容器运行；需要管理主机
请使用完整部署。

## 部署

只有一条部署路径，在仓库根目录：

```bash
scripts/deploy.sh
```

它在一台机器上启动 PostgreSQL、PCS 和管理端，构建 payload 与主机缓存，并由 PCS 托管界面。
本目录存放这次部署消费的资产：payload 入口、演示用 compose 文件和演示界面镜像。

## 多主机：本地主机与 SSH 主机

其他主机在管理页里添加：

1. **添加本地主机** —— PCS 所在机器，直接探测，无需 SSH。
2. **添加 SSH 主机** —— 填地址、端口、用户和私钥；私钥加密入库，界面只显示指纹。
3. **启动运行时** —— PCS 把 host-runtime bundle 写到
   `$HOME/.platform/host-runtime/<host_id>/`，用一次性注册令牌启动；主机入网后状态变 ONLINE。
4. **新建构建机时选择主机** —— 部署计划落到选中的主机，容器由该主机的 host-runtime 创建。
5. **部署调度机** —— 在主机卡片上填写调度机镜像、数据库地址、宿主端口和资源。每台主机只有
   一台根调度机（PCS 用 `ROOT_SCHEDULER_EXISTS` 拒绝重复），可再加挂结点调度机；调度机容器
   连 PostgreSQL，宿主上的库可用 `172.17.0.1:5432` 访问。

PCS 需要这些环境变量：

| 变量 | 说明 |
|---|---|
| `PCS_CREDENTIAL_KEY_FILE` | 32 字节密钥文件（0600），用于 AES-256-GCM 加密 SSH 私钥；未配置时只能加本地主机 |
| `PCS_RUNTIME_SOURCE_DIR` | host-runtime 源码目录，PCS 引导时用 esbuild 打成自包含 `.mjs`；默认 `../host-runtime` |
| `PCS_RUNTIME_URL` | 远程主机访问 PCS 的地址，例如 `http://pcs.example:7901`；本地主机自动用 `127.0.0.1` |
| `PCS_RUNTIME_NODE` | 远程主机上的 node 路径，默认 `node`；要求 Node 22+ |
| `PCS_SCHEDULER_IMAGE` | 调度机镜像，digest 固定，建议 `docker.m.daocloud.io/library/ubuntu@sha256:…` |
| `PCS_SCHEDULER_APP_DIR` | 调度机部署载荷目录，默认 `<pcs 目录>/app/scheduler`（`scripts/build-app-payload.mjs` 的产物） |
| `PCS_BUILDER_IMAGES` | 构建机镜像表，`ubuntu24.04=<镜像>,ubuntu22.04=<镜像>`；配置后按系统直接用官方 ubuntu |
| `PCS_BUILDER_APP_DIR` | 构建机部署载荷目录，默认 `<pcs 目录>/app/builder` |
| `PCS_SCHEDULER_DATABASE_URLS` | 按主机覆盖调度机数据库，`host_id=postgres://…` 逗号分隔；每台主机一个调度机、各自一套库时使用，未配置的主机退回 `PCS_SCHEDULER_DATABASE_URL` |
| `PCS_SCHEDULER_URLS` | 按主机指定该主机构建机注册的调度机，`host_id=http://…` 逗号分隔；未配置的主机退回 `PCS_SCHEDULER_URL` |

## 裸 OS 镜像 + 主机缓存（调度机与构建机）

两个角色都不构建镜像：直接用官方 ubuntu（digest 固定），应用和运行时都不在镜像里。

1. `node scripts/build-app-payload.mjs` 生成两份载荷：`deploy/scheduler/app/`（约 600K：
   调度服务、容器内 Agent 运行时、SQL、入口脚本、CLI 适配器）和
   `deploy/builder/app/`（约 120K：实例运行时、CLI 适配器、sshd/Codex 配置、入口脚本）；
2. 分别同步到控制面 `PCS_SCHEDULER_APP_DIR` / `PCS_BUILDER_APP_DIR`
   （默认 `<pcs 目录>/app/{scheduler,builder}`）；
3. 部署计划把 payload 作为 `files` 写进容器 `/opt/platform/app/`，命令固定为
   `/bin/bash /opt/platform/app/entrypoint.sh`；
4. Node、Claude Code、openssh deb 放在主机缓存 `~/.platform/cache/`，部署时只读挂到
   `/opt/platform/cache`——同一台主机上所有容器共用，换代码只换 payload（几百 KB），
   不重建、不传输镜像。

构建机镜像按系统取 `PCS_BUILDER_IMAGES`（`ubuntu24.04=<ubuntu@sha256:…>,…`）；不配置时
用界面里随系统给出的官方镜像 digest。缓存里的 openssh deb 必须和镜像版本一致（当前是
24.04）；版本不一致时入口脚本会退回 `apt-get` 安装 openssh。

主机缓存准备一次即可：

```bash
mkdir -p ~/.platform/cache/{node,agents,openssh}
cp -a /path/to/node-v22.20.0-linux-x64/. ~/.platform/cache/node/
install -m 0755 /path/to/claude ~/.platform/cache/agents/claude
# ssh/sshd 不装进镜像：在 ubuntu:24.04 里只下载 deb，首次启动由入口脚本离线 dpkg -i
docker run --rm -v ~/.platform/cache/openssh:/out ubuntu:24.04 bash -c \
  'apt-get update -qq && apt-get install -y -qq --download-only --no-install-recommends openssh-server \
   && cp /var/cache/apt/archives/*.deb /out/'
```

工具链（git、编译器等）不保留：容器里需要时由 Agent 自己装，重建容器后重装。

远程主机前置条件：Docker Engine、当前用户能访问 Docker、能访问 `PCS_RUNTIME_URL`。
PCS 默认只监听 `127.0.0.1`；要让远程主机入网，需设置 `PCS_HOST=0.0.0.0` 或用反向代理暴露管理面。
镜像仍必须 digest 固定且在 `PCS_IMAGE_ALLOWLIST` 内——远程主机按命令里的镜像地址自行拉取。

生成凭据密钥：

```bash
umask 077 && openssl rand -out ~/.config/platform/pcs-credential.key 32
```

引导是可重复的：再次点击「重新引导运行时」会停掉该主机目录下的旧进程并重启，不会动其他目录。

## 模型凭据与 CLI Agent

CLI 不在镜像里：放在主机缓存 `~/.platform/cache/agents/`（`claude`、`codex`），容器内
`PATH` 已经包含它；旧版 compose 镜像仍按 `CLAUDE_CODE_VERSION` / `CODEX_VERSION` 构建参数内置。
**任何镜像和缓存都不含密钥**，凭据只在运行时注入：

```dotenv
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
PLATFORM_AGENT_PASS_ENV=ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL,DEEPSEEK_API_KEY,CODEX_HOME
```

凭据要经过两层显式放行，缺任一层都只是 Agent 认证失败，不会退回明文或别的执行器：

1. `PLATFORM_AGENT_PASS_ENV`：容器环境 → Agent 适配器进程（host-runtime 不放行 `PLATFORM_` 前缀）；
2. Agent Profile 的 `--pass-env`：适配器 → 外部 CLI（`agents/cli-agent.mjs` 默认只传最小环境）。

默认端点：Claude Code 走 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`，
Codex 走 `CODEX_HOME=/opt/platform/codex/config.toml` 里的 DeepSeek Responses API。
换回官方 Anthropic 时覆盖 `ANTHROPIC_BASE_URL` 即可。

### 用 API Profile 转发模型流量

Agent Profile 可以引用 API Profile：在 Agent 的「模型 API」里选一个 `llm` 类型的 Profile，部署构建机 / 调度机时
界面会自动把它带上。host-runtime 会把 `ANTHROPIC_BASE_URL` 指向本机适配器
（`http://127.0.0.1:<port>/<api_profile_id>`）并配一个占位密钥。真实密钥在出口处用随部署下发的
实例身份令牌向 Secret Store 解析：

- 密钥不进入容器环境变量、部署载荷、数据库和日志；
- egress 默认拒绝：适配器只访问该 Profile `base_url` 里的主机名（每个 Profile 合成一条策略；
  Profile 自己写了 `egress` 时以它为准）；
- 按 Profile 的 rpm / 每日配额与每次调用一条审计（不含正文）都在适配器里执行；
- 这条路径不需要主机上的凭据文件，构建机可以不配 `~/.config/platform/agent-env`。

Base URL 必须提供 Anthropic Messages 接口（Claude Code 调 `/v1/messages`），并写到主机根路径：
`https://api.deepseek.com/anthropic`、`https://api.anthropic.com`，或任何同协议的代理。
Codex 不走适配器（它的提供方设置来自 `CODEX_HOME`），仍用凭据文件那条路径。

部署绑定 API Profile 的实例要求控制面有 `PCS_SECRET_STORE_URL`，容器才知道去哪里解析 `secret://`；
`scripts/deploy.sh` 会启动 Secret Store 并设置它，必要时再设 `PCS_SECRET_STORE_CONTAINER_URL`
（例如 macOS 上容器经 Docker 网桥网关访问）。没有它时 Profiles 页面会提示，部署计划以
`SECRET_STORE_NOT_CONFIGURED` 拒绝。

实例身份令牌按 `PCS_INSTANCE_TOKEN_HOURS`（默认 720，即 30 天）签发，随部署写到
`/opt/platform/tokens/<instance_id>.jwt`。

[LiteLLM](https://github.com/BerriAI/litellm) 也可以作为 API Profile 的后端：它的 Anthropic 兼容接口
正是 CLI 需要的，Profile 填代理根地址和 Key，上游密钥与虚拟 Key 限额留在代理里。

```yaml
model_list:
  - model_name: claude-sonnet-4-5
    litellm_params:
      model: anthropic/claude-sonnet-4-5
      api_key: os.environ/ANTHROPIC_UPSTREAM_KEY
  - model_name: claude-haiku-4-5
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

代理放在可信网络内，不要把 master key 发给构建机。Codex 也可以走 LiteLLM 的 OpenAI 兼容端点，
改 `CODEX_HOME` 里 `base_url` 和 `env_key` 即可。

### 交互时延

终端和对话里的每条命令都是一个独立任务，等待时间主要来自「任务入队 → 实例来领」。
`CLAIM_INTERVAL_SECONDS`（默认 `0.5`，代码里的兜底值仍是 `2`）控制实例多久轮询一次
调度机：几台机器的小平台用 0.5 秒，机器很多时调回 1–2 秒省数据库。
控制台前端另有自适应轮询（前 5 秒 150ms 一档，随后退避到 1 秒）。

Profile 由 PCS 随部署下发：`/opt/platform/profiles.json` 里是 Agent Profile 的运行时视图、
当前实例绑定的 API Profile 与 `bindings`；构建机和调度机 entrypoint 把它和
`API_PROFILE_IDS`、`EGRESS_POLICIES_JSON` 一起写进 `runtime.config.json`。
手工部署（不用 PCS）时按同样格式自己提供文件，并用 `PROFILES_FILE=/opt/platform/profiles.json` 指过去。

## 实例令牌

绑定 API Profile 时，PCS 随部署签发实例身份令牌并写到 `/opt/platform/tokens/<instance_id>.jwt`，
容器通过只读卷 `/opt/platform/tokens` 读取；令牌的 `aud` 是 `scheduler`，Secret Store 用它校验解析请求。
不用 PCS 时可以手工签发：

```bash
npm --prefix ../pcs-issuer run issue -- instance \
  --id builder-ubuntu22-a --role builder --host docker-host-01 \
  --out deploy/tokens/builder-ubuntu22-a.jwt
```

未启用鉴权（`SCHEDULER_AUTH_TOKEN` 为空且未配置 PCS 公钥）时可以留空。

## 说明

- 26.04 镜像在官方 `ubuntu:26.04` 可用前会构建失败，属预期的「预览」状态；可先用
  `UBUNTU_VERSION=24.04` 验证流程。
- 构建机 SSH 默认只允许公钥；如需密码登录，自行改 `builder/sshd_config` 并挂载密码。
- 生产环境把 8443 / 2222-2225 / 2200 限制在内网或 VPN，不要直接暴露公网。
