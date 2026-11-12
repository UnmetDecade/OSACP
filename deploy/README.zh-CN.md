# 部署资产

> [English](README.md) · 简体中文

v4 的调度机与构建机都是容器，本目录是可直接构建的参考实现。

| 文件 | 作用 |
|---|---|
| `compose.yaml` | 单机编排：PostgreSQL + 调度机 + Ubuntu 20/22/24/26 四台构建机 |
| `builder/Dockerfile` | 旧版构建机镜像（仅 compose 参考；控制面部署已改为裸 ubuntu） |
| `builder/entrypoint.sh` | 旧版镜像入口（仅 compose 参考） |
| `builder/app-entrypoint.sh` | 裸 ubuntu 构建机入口：从主机缓存取 Node/CLI/ssh，启动实例运行时 |
| `scheduler/Dockerfile` | 旧版调度机镜像（仅 compose 参考；控制面部署已改为裸 ubuntu） |
| `scheduler/entrypoint.sh` | 旧版镜像入口（仅 compose 参考） |
| `scheduler/app-entrypoint.sh` | 裸 ubuntu 调度机入口：从主机缓存取 Node/CLI/ssh，迁移并启动 |
| `.env.example` | 密码与令牌模板 |

## 快速开始

```bash
cd deploy
cp .env.example .env
mkdir -p keys tokens data/postgres data/artifacts

# 每台机器一份 SSH 密钥（公钥进容器，私钥自己保存）
ssh-keygen -t ed25519 -N "" -f keys/scheduler
ssh-keygen -t ed25519 -N "" -f keys/builder20
ssh-keygen -t ed25519 -N "" -f keys/builder22
ssh-keygen -t ed25519 -N "" -f keys/builder24
ssh-keygen -t ed25519 -N "" -f keys/builder26

docker compose -f compose.yaml --env-file .env up -d --build
```

启动后：

| 入口 | 地址 |
|---|---|
| 调度机 API | `http://<host>:8443` |
| 调度机 SSH | `ssh root@<host> -p 2200` |
| builder20 SSH | `ssh root@<host> -p 2222` |
| builder22 SSH | `ssh root@<host> -p 2223` |
| builder24 SSH | `ssh root@<host> -p 2224` |
| builder26 SSH | `ssh root@<host> -p 2225` |

容器内是 root + 可写根 + `CapAdd:["ALL"]`，SSH 进去可以 `apt install`、改系统配置、跑任意
工具链。隔离边界是容器本身、CPU/内存/PID 限额与网络策略，不是容器内的权限收缩。

调度机容器里同时跑一个 `scheduler` 角色的 host-runtime 实例，负责
`task.chat.scheduler` 与 `task.console.scheduler`。默认回复是确定性的（队列快照）；
如果挂载 PCS 导出的运行时视图并设置 `PROFILES_FILE`，对话会路由给绑定的调度 Agent
（例如 DeepSeek 调度助手）。派发规则始终由调度服务决定，Agent 不参与排队。

## 多主机：本地主机与 SSH 主机

Compose 仍是最快的单机路径；需要把构建机放到别的机器时，用管理页的「主机」：

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

### 交互时延

终端和对话里的每条命令都是一个独立任务，等待时间主要来自「任务入队 → 实例来领」。
`CLAIM_INTERVAL_SECONDS`（默认 `0.5`，代码里的兜底值仍是 `2`）控制实例多久轮询一次
调度机：几台机器的小平台用 0.5 秒，机器很多时调回 1–2 秒省数据库。
控制台前端另有自适应轮询（前 5 秒 150ms 一档，随后退避到 1 秒）。

Profile 从 PCS 导出的运行时视图挂载：把 `agent_profiles` + `bindings` 写到文件，
挂进容器并在 `deploy/.env` 指定 `PROFILES_FILE=/opt/platform/profiles.json`（构建机
和调度机 entrypoint 都会把它写进 `runtime.config.json`）。

## 实例令牌

调度机启用实例 JWT 时，把 PCS 签发的令牌放到 `tokens/<instance_id>.jwt`，容器通过只读卷
`/opt/platform/tokens` 读取：

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
