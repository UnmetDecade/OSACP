# 部署

> [English](deployment.md) · 简体中文

> 版本：v4.3 · 2026-11-12
> 两条路径：单机 Compose 跑通闭环；PCS + host-runtime 管多台主机。

---

## 1. 最低配置

| 项 | 最小 | 推荐 |
|---|---|---|
| CPU | 4 core | 8 core |
| 内存 | 8 GB | 16–32 GB |
| 磁盘 | 60 GB SSD | 200 GB SSD |
| 系统 | Ubuntu 22.04+ / Debian 12+ | Ubuntu 24.04 |
| Docker | 24+，含 compose plugin | 最新稳定版 |
| Node | 22+（PCS、host-runtime、管理应用） | 22 LTS |

单机 Compose 只需要 Docker；多主机控制面需要 Node 在 PCS 与每台主机上可执行。

---

## 2. 路径 A：单机 Compose

`deploy/compose.yaml` 是唯一事实来源，起 PostgreSQL + 调度机 + Ubuntu 20/22/24/26
四台构建机。完整的准备步骤见 [deploy/README.zh-CN.md](../deploy/README.zh-CN.md)，最短路径：

```bash
cd deploy
cp .env.example .env                 # 改 POSTGRES_PASSWORD；模型凭据可留空
mkdir -p keys tokens data/postgres data/artifacts

# 主机登录公钥：容器里的 sshd 只接受密钥
ssh-keygen -t ed25519 -N "" -f keys/scheduler
ssh-keygen -t ed25519 -N "" -f keys/builder
for os in 20 22 24 26; do cp keys/builder.pub "keys/builder$os.pub"; done

docker compose -f compose.yaml --env-file .env up -d --build
```

启动后：

| 入口 | 地址 |
|---|---|
| 调度机 API | `http://<host>:8443` |
| 调度机 SSH | `ssh root@<host> -p 2200` |
| 构建机 SSH | `ssh root@<host> -p 2222–2225` |

调度机会自动迁移并种子。构建机注册到 `http://scheduler:8443`；实例 JWT 放在
`deploy/tokens/<instance_id>.jwt`，通过只读卷 `/opt/platform/tokens` 读取。

---

## 3. 路径 B：PCS + host-runtime（多主机）

控制面把「期望态」与「实际态」分开：PCS 写部署计划并下发签名命令，host-runtime 在主机上
执行，管理应用只读写 PCS 与调度机 API。

### 3.1 启动 PCS

```bash
cd pcs-issuer
npm install
npm run keygen          # ES256 JWT 密钥 + Ed25519 命令签名密钥（已存在则保留）
npm run migrate         # 建 platform_control 库

PCS_HOST=0.0.0.0 \
PCS_RUNTIME_URL=http://pcs.example:7901 \
PCS_CREDENTIAL_KEY_FILE=$HOME/.config/platform/pcs-credential.key \
PCS_IMAGE_ALLOWLIST=docker.io/library/ \
npm start
```

`PCS_CREDENTIAL_KEY_FILE` 是 32 字节密钥（0600），用于 AES-256-GCM 加密主机 SSH 私钥；
不配置时只能接入本地主机。生成一次：

```bash
umask 077 && openssl rand -out ~/.config/platform/pcs-credential.key 32
```

管理员令牌用 `npm run pcs -- admin-token --operator <name>` 签发，管理应用通过
`PCS_ADMIN_TOKEN` 使用它。

### 3.2 接入主机

1. **本地主机**：PCS 所在机器，直接探测，不需要 SSH。
2. **SSH 主机**：填地址、端口、用户和私钥；私钥加密入库，接口只返回指纹。
3. **启动运行时**：PCS 把 host-runtime bundle 写到 `$HOME/.platform/host-runtime/<host_id>/`，
   用一次性注册令牌启动；主机入网后状态变 ONLINE。
4. **部署调度机 / 构建机**：部署计划落到选中的主机，容器由该主机的 host-runtime 创建。

远程主机前置条件：Docker Engine、当前用户能访问 Docker、能访问 `PCS_RUNTIME_URL`、Node 22+。

### 3.3 部署载荷与主机缓存

调度机与构建机都不构建镜像：官方 ubuntu（digest 固定）+ 部署时写入的运行时载荷。

```bash
node scripts/build-app-payload.mjs
# 产物：deploy/scheduler/app/ 与 deploy/builder/app/，同步到 PCS 的
# PCS_SCHEDULER_APP_DIR / PCS_BUILDER_APP_DIR（默认 <pcs>/app/{scheduler,builder}）
```

Node、Claude Code、openssh deb 放在主机缓存 `~/.platform/cache/`，只读挂到
`/opt/platform/cache`。准备一次即可，见 [deploy/README.zh-CN.md](../deploy/README.zh-CN.md#裸-os-镜像--主机缓存调度机与构建机)。

### 3.4 启动管理应用

```bash
cd admin-app
npm install
printf 'PCS_ADMIN_TOKEN=%s\n' '<admin-jwt>' > .env.local   # 0600，已被 gitignore
npm run dev
```

开发代理把 `/api/pcs` 转到 `http://127.0.0.1:7901`、`/api/scheduler` 转到
`http://127.0.0.1:8443`；可用 `VITE_PCS_TARGET` / `VITE_SCHEDULER_TARGET` 覆盖。
生产构建 `npm run build`，由反向代理托管静态文件并转发两个 API 前缀。

---

## 4. 端口与网络

| 端口 | 用途 | 建议 |
|---|---|---|
| 7901 | PCS 管理面 | 反代 + TLS；只开内网 |
| 8443 | 调度机 API | 反代 + TLS；只开内网 |
| 2200 | 调度机 SSH | 内网 / VPN |
| 2222–2231 | 构建机 SSH | 内网 / VPN |
| 5432 | PostgreSQL | 不映射 |

如果公网访问管理应用，必须在前面加 Caddy/Nginx + HTTPS + 基础认证/VPN。

---

## 5. 备份

必需：

- PostgreSQL：`pg_dump` 每日一次，保留 7 天。调度机库与 `platform_control` 都要备份。
- 构建机工作区卷：可选（代码可从仓库重建）。
- `.env`、`keys/`、`~/.config/platform/pcs-credential.key`：离线保存。

`scripts/backup-restore.sh backup OUTDIR` 会导出两个库、比对行数并写 SHA256SUMS；
`restore` 只恢复到独立后缀库，不覆盖源库。

---

## 6. 升级

```bash
# 单机 Compose
docker compose pull
docker compose up -d scheduler
docker compose exec scheduler npm run migrate
docker compose restart builder-ubuntu22   # 逐个重启构建机

# 控制面
cd pcs-issuer && npm run migrate && npm start
node scripts/build-app-payload.mjs        # 重建载荷后重新应用部署计划
```

- 调度机与构建机可独立升级。
- 数据库迁移向后兼容；不自动回滚。
- 升级前备份 PostgreSQL。

---

## 7. 常见故障

| 症状 | 处理 |
|---|---|
| 构建机一直 STARTING | `docker logs`；检查实例 JWT、`SCHEDULER_URL` 与调度机连通性 |
| 任务一直 QUEUED | 检查构建机能力、OS 要求、并发上限与租约 |
| SSH 连不上 | 确认宿主端口映射、`authorized_keys` 权限 600、sshd 是否启动 |
| 主机一直 OFFLINE | 检查 `PCS_RUNTIME_URL`、注册令牌是否过期、host-runtime 日志 |
| 调度机部署报 `ROOT_SCHEDULER_EXISTS` | 主机已有根调度机；改为在该根下加结点调度机 |
| 磁盘满 | 清理 `/opt/platform/workspace` 与产物；扩容卷 |

---

## 8. 验收清单

- [ ] 单机 Compose 四个容器健康，或 PCS 中主机为 ONLINE。
- [ ] 管理应用能连上 PCS 与调度机并看到构建机。
- [ ] 能提交 `task.build` 并看到 SUCCEEDED。
- [ ] 能 SSH 进任意构建机（仅密钥）。
- [ ] 停止构建机后任务重新入队。
- [ ] 备份脚本可执行、可恢复。
