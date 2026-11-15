# 部署

> [English](deployment.md) · 简体中文

> 版本：v4.3 · 2026-11-12
> 只有一条路径：PCS + host-runtime。`scripts/deploy.sh` 在一台机器上启动控制面
> （PostgreSQL + PCS + 界面），其他主机在界面里添加。

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

PCS、host-runtime 和管理端需要 Node；PostgreSQL 以及 host-runtime 在各主机上创建的容器需要 Docker。

---

## 2. 部署

只有一条路径：PCS + host-runtime。用一条脚本在控制机启动控制面，之后在界面里添加主机、
部署调度机与构建机。`scripts/deploy.sh` 可以重复执行。

### 2.1 启动控制面

```bash
scripts/deploy.sh
```

脚本会：

1. 启动本地 PostgreSQL 容器（除非设置了 `PCS_DATABASE_URL`）；
2. 生成 PCS 签名密钥和 SSH 凭据密钥（`~/.config/platform/pcs-credential.key`）；
3. 安装依赖、构建管理端和部署 payload；
4. 准备主机缓存（`~/.platform/cache`：Linux Node、openssh deb、可选 CLI）；
5. 迁移数据库并启动 PCS——管理端由 PCS 自己托管（`PCS_WEB_DIR`）。

打开 `http://127.0.0.1:7901`，注册第一个账号（成为管理员），把本机添加为本地主机，
启动 runtime，再部署调度机和构建机。

接入远程主机时，用 `PCS_HOST=0.0.0.0 PCS_RUNTIME_URL=http://<内网IP>:7901` 启动，再通过 SSH 添加。
PCS 在前台运行，Ctrl+C 停止。可用环境变量：`PCS_PORT`、`PCS_DATABASE_URL`、
`PCS_SCHEDULER_DATABASE_URL`、`PCS_IMAGE_ALLOWLIST`、`PCS_REGISTRATION`、`PCS_SESSION_HOURS`。

管理员令牌用 `npm run pcs -- admin-token --operator <name>` 签发，自动化仍可使用。
管理应用改用账号登录：第一个注册的账号成为管理员，之后的注册需要审批
（默认 `PCS_REGISTRATION=approval`）。

### 2.2 接入主机

1. **本地主机**：PCS 所在机器，直接探测，不需要 SSH。
2. **SSH 主机**：填地址、端口、用户和私钥；私钥加密入库，接口只返回指纹。
3. **启动运行时**：PCS 把 host-runtime bundle 写到 `$HOME/.platform/host-runtime/<host_id>/`，
   用一次性注册令牌启动；主机入网后状态变 ONLINE。
4. **部署调度机 / 构建机**：部署计划落到选中的主机，容器由该主机的 host-runtime 创建。

远程主机前置条件：Docker Engine、当前用户能访问 Docker、能访问 `PCS_RUNTIME_URL`、Node 22+。

### 2.3 部署载荷与主机缓存

调度机与构建机都不构建镜像：官方 ubuntu（digest 固定）+ 部署时写入的运行时载荷。

```bash
node scripts/build-app-payload.mjs
# 产物：deploy/scheduler/app/ 与 deploy/builder/app/，同步到 PCS 的
# PCS_SCHEDULER_APP_DIR / PCS_BUILDER_APP_DIR（默认 <pcs>/app/{scheduler,builder}）
```

Node、Claude Code、openssh deb 放在主机缓存 `~/.platform/cache/`，只读挂到
`/opt/platform/cache`。准备一次即可，见 [deploy/README.zh-CN.md](../deploy/README.zh-CN.md#裸-os-镜像--主机缓存调度机与构建机)。

### 2.4 管理应用（仅前端开发）

部署好的控制面已经托管构建产物，这一节只用于前端开发：

```bash
cd admin-app
npm install
npm run dev
```

开发代理把 `/api/pcs` 转到 `http://127.0.0.1:7901`、`/api/scheduler` 转到
`http://127.0.0.1:8443`；可用 `VITE_PCS_TARGET` / `VITE_SCHEDULER_TARGET` 覆盖。
会话是 HttpOnly Cookie + CSRF 令牌，`.env.local` 里不再写共享令牌。

---

## 4. 端口与网络

| 端口 | 用途 | 建议 |
|---|---|---|
| 7901 | PCS 管理面 | 反代 + TLS；只开内网 |
| 8443 | 调度机 API | 反代 + TLS；只开内网 |
| 2200 | 调度机 SSH | 内网 / VPN |
| 2222–2231 | 构建机 SSH | 内网 / VPN |
| 55432 | PostgreSQL（`scripts/deploy.sh`） | 为让调度机容器访问而发布；只开内网 |

管理界面由 PCS 在 7901 上托管。绝不要把管理端发布到公网；需要公网访问请用侧载令牌。

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
