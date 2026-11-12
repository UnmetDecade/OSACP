# 构建机

> [English](builders.md) · 简体中文

> 版本：v4.3 · 2026-11-12
> 构建机是唯一的工作角色：一台可 SSH 的 Ubuntu 容器，或整台裸机主机。

---

## 1. 系统版本

| `builder_os` | 基础镜像 | 适用 |
|---|---|---|
| `ubuntu20.04` | 官方 `ubuntu:20.04` | 老项目、旧 glibc、旧内核头文件 |
| `ubuntu22.04` | 官方 `ubuntu:22.04` | 兼容性优先 |
| `ubuntu24.04` | 官方 `ubuntu:24.04` | 默认推荐 |
| `ubuntu26.04` | 官方 `ubuntu:26.04` | 尝鲜、前瞻验证（以官方发布为准） |

规则：

- 镜像按 digest 固定，并且在 PCS 的 `PCS_IMAGE_ALLOWLIST` 内；管理应用展示 digest，不只展示 tag。
- 镜像是**纯官方 Ubuntu**，不烘焙平台运行时。Node、Agent CLI、openssh deb 从主机缓存
  （`~/.platform/cache`）只读挂入；实例运行时在部署时写入 `/opt/platform/app`。
- 一个构建机实例 = 一个容器 = 一个系统版本；同一次任务不跨系统。
- 允许同一版本多实例，显示名由使用者填（可中文），实例 ID 由控制面派生。
- `role_mode=builder` 的裸机主机不需要容器：整台主机直接注册为一台构建机。

---

## 2. 容器内目录

```
/opt/platform/
├── app/                       # 实例运行时（部署时写入，只读）
│   ├── agent-runtime.mjs
│   └── sshd_config
├── agents/                    # CLI Agent 适配器（部署时写入）
├── cache/                     # 主机缓存（只读挂载）
│   ├── node/                  # Node 22+
│   ├── agents/                # claude / codex
│   └── openssh/*.deb          # 与镜像同版本的 ssh/sshd
├── tokens/                    # 实例 JWT（0600，部署时写入）
├── keys/                      # 授权公钥（只读）
├── workspace/                 # 工作区（卷）
├── artifacts/                 # 产物暂存（卷）
├── state/                     # 已装软件包清单（按实例隔离的卷）
├── apt-cache/                 # 主机共享 deb 缓存（卷）
├── logs/                      # 本地日志缓冲
└── audit/                     # 本地审计
```

必需系统包由缓存里的 deb 离线安装（`openssh-server`、`bash`、`git`、`curl`、
`ca-certificates`、`jq`）。构建链（`build-essential`、`cmake`、`python3`、`nodejs` 等）
不预装，由任务自己在容器里安装；`/opt/platform/state` 记录包清单，重建后可恢复。

`docker-cli` 只用于「容器内构建镜像」场景，默认不挂 Docker Socket。

---

## 3. SSH 完整权限

v4 刻意提供**完全权限的 SSH**，用于研发排障与手工构建。

| 项 | 默认 |
|---|---|
| 用户 | `root` |
| 认证 | **只允许密钥**；部署时把主机登录公钥写进容器 `authorized_keys` |
| 端口 | 容器 `22` → 宿主分配的唯一端口，随部署计划下发 |
| 权限 | 完整 shell、可安装软件、可访问网络 |
| 会话 | 交互式 PTY，标准 ssh 客户端 |
| 审计 | 可选：`sshd` 日志、shell 历史、`script` 录制 |

管理应用展示：

```
ssh root@<host> -p <port>
```

并提供「复制命令」与「打开 Web 终端」动作。主机没有可用公钥时，容器仍可通过
PCS 的 Web 终端进入；`sshd` 不接受密码登录。

> 公钥来源是主机自己的 `authorized_keys` 与 `~/.platform/keys/*.pub`。
> 调度机与 PCS 都不保存构建机 SSH 私钥；SSH 不经过调度机。

---

## 4. 构建机 Agent

### 4.0 名称与实例 ID

界面上填的是**显示名**（`display_name`），可以中文、最长 32 个字符；卡片、列表、详情页都显示它。
实例 ID（`instance_id`）由控制面按显示名派生，只用于容器名、卷名、调度机 `node_id` 和结点库名，必须是 ASCII：

- `a-z` / `0-9` 原样保留，空格与 `. _ / -` 转成 `-`；
- 其余字符（含中文）转成 `-<Unicode 码点>-`，例如「测试构建机」→ `27979-35797-26500-24314-26426`；
- 合并连续 `-` 并去掉首尾 `-`；超过 48 个字符时截断并追加名称哈希前 8 位；
- 已经是合法 ASCII id 的 `instance_id` 原样使用，不再二次派生。

同一台主机内实例 ID 唯一；不同主机可以同名。调度机同样规则，`SCHEDULER_NODE_ID` 为 `<host_id>:<instance_id>`。

### 4.1 启动参数

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `SCHEDULER_URL` | 是 | 归属调度机地址 |
| `INSTANCE_ID` | 是 | 实例 ID，例如 `builder-ubuntu22-a` |
| `INSTANCE_TOKEN_DIR` | 是 | 实例 JWT 所在目录，默认 `/opt/platform/tokens` |
| `ROLE_ID` | 是 | 固定 `builder` |
| `BUILDER_OS` | 是 | `ubuntu20.04` / `ubuntu22.04` / `ubuntu24.04` / `ubuntu26.04` |
| `WORKSPACE_DIR` | 否 | 默认 `/opt/platform/workspace` |
| `AGENT_PROFILE_ID` | 否 | 绑定的 Agent（Claude Code / Codex / DeepSeek / 自定义）；不填则只跑确定性 Shell |
| `PLATFORM_AGENT_PASS_ENV` | 否 | 容器环境放行给 Agent 适配器的变量名，逗号分隔 |
| `MAX_CONCURRENCY` | 否 | 默认 1 |

### 4.2 生命周期

```
STARTING → REGISTERING → ONLINE ⇄ SUSPECT → OFFLINE
                              └── DRAINING
```

- `ONLINE`：心跳正常，可领取任务。
- `SUSPECT`：45s 无心跳，暂停派发；在途任务继续。
- `DRAINING`：不再领取，等待在途任务结束。
- `OFFLINE`：手动停止或心跳超时。

### 4.3 执行循环

1. `claim` 领取任务（长轮询 25s）。
2. 校验 fencing token 与租约。
3. 创建工作区 `workspace/<task_id>/<attempt_id>`。
4. 选择执行器：
   - 绑定 Agent → Agent Adapter（stdio JSON-RPC / HTTP；DeepSeek 走 OpenAI 兼容 HTTP）。
   - 未绑定 → 确定性 Shell 执行器（直接执行 payload 中的命令）。
5. 持续上报 `progress`。
6. 上传产物到 `artifacts`，`result` 上报摘要。
7. 清理工作区（可配置保留）。

---

## 5. 资源与限制

| 项 | 默认 | 说明 |
|---|---|---|
| CPU | 2 core | 可按实例配置 |
| 内存 | 4 GiB | 编译大项目时调高 |
| 磁盘 | 20 GiB | 工作区 + 产物；由宿主配额与卷约束 |
| PIDs | 512 / 1024 | 4 GiB 以下 512，以上 1024 |
| 超时 | 1 小时 | 任务级 `deadline_at` |
| 网络 | 允许出站 | 研发需要；可按 `network_policy` 收紧 |

限制由 host-runtime 创建容器时写入，容器内不能自行放宽。

---

## 6. 卷

| 卷 | 挂载点 | 说明 |
|---|---|---|
| `state`（按实例隔离） | `/opt/platform/state` | 已装软件包清单，重建后恢复环境 |
| `shared-apt-cache`（主机共享） | `/opt/platform/apt-cache` | 复用下载过的 deb，不共享已装环境 |
| `workspace` | `/opt/platform/workspace` | 跨任务保留，便于复现 |
| `artifacts` | `/opt/platform/artifacts` | 产物暂存 |
| `keys`（只读） | `/opt/platform/keys` | 授权公钥 |

---

## 7. 健康检查

| 检查 | 命令 | 失败处理 |
|---|---|---|
| 实例心跳 | 调度机 45s 未收到 | 标记 SUSPECT，暂停派发 |
| sshd | `nc -z localhost 22` | host-runtime 重启容器 |
| 磁盘 | 实例上报工作区可用空间 | 调度机暂停派发 |
| 容器退出 | host-runtime 对账 | 按期望态重建 |

---

## 8. 安全说明（明确取舍）

- 默认 root + 完全 SSH 是**有意为之**，不是遗漏。
- 建议只在可信内网使用；公网暴露必须加防火墙/VPN。
- 容器只接受密钥登录；主机登录公钥在部署时注入。
- 构建机 token 与 SSH 私钥分离：token 用于调度，私钥只给使用者。
- 不在镜像里放业务密钥；需要时通过环境变量或 Secret Store 注入。
- 如果未来需要收紧：把 `root` 改为 `builder` 用户 + sudo，或启用 `AllowUsers`/`ForceCommand`。

---

## 9. 参考 Compose 片段

单机 Compose 是参考部署，控制面部署走 PCS 部署计划。

```yaml
services:
  builder-ubuntu22:
    image: ubuntu:22.04@sha256:<digest>
    hostname: builder-ubuntu22
    environment:
      SCHEDULER_URL: http://scheduler:8443
      INSTANCE_ID: builder-ubuntu22-a
      ROLE_ID: builder
      BUILDER_OS: ubuntu22.04
    ports:
      - "2222:22"
    volumes:
      - builder22-state:/opt/platform/state
      - shared-apt-cache:/opt/platform/apt-cache
      - ./keys:/opt/platform/keys:ro
      - builder22-app:/opt/platform/app:ro
    cpus: 2
    mem_limit: 4g
    pids_limit: 1024
    networks: [platform-net]
```
