# 侧载

> [English](sideload.md) · 简体中文

> 版本：v4.5 · 2026-11-13
> 侧载是一个 curl 令牌：局域网内的一台设备拿它就能通过控制面驱动某台主机上的构建机。

---

## 1. 模型

- 一个侧载只属于**一台主机**，在该主机的「AI Agent 工作室」里创建。
- 侧载**不是 Agent**：没有容器、不在调度机注册、没有心跳、没有自己的租约。
  调用链路是 `设备 → PCS → 主机的根调度机 → 构建机`，与管理应用走同一套任务 / 租约 / fencing。
- 一台主机的 Studio 只显示**它自己的侧载**；并入的下级主机保留自己的侧载，侧载永远看不到其他主机的
  侧载。构建机则来自本机根调度机管辖的整棵子树，因为那才是任务真正能跑到的地方。
- 因为它不是 Agent，工作室里画的是**主机卡通**，不是机器人。

---

## 2. 权限

权限是封闭集合。未知值直接拒绝（`SIDELOAD_SCOPE_UNKNOWN`），不会被静默丢弃。

| 权限 | 允许的操作 |
|---|---|
| `tasks:read` | `GET /tasks`、`GET /tasks/:id`、`GET /tasks/:id/events`、`GET /tasks/:id/artifacts`、`GET /artifacts/:id/download` |
| `tasks:write` | `POST /tasks`、`POST /attachments`、`POST /tasks/:id/cancel`、`/retry`、`/answer` |
| `builders:read` | `GET /builders`（根调度机子树） |
| `queue:read` | `GET /queue` |
| `console:run` | 创建 `task.console.*` 任务；必须同时有 `tasks:write` |

`console:run` 是叠加在 `tasks:write` 之上的闸门：控制台任务会在构建机上执行 shell 命令，不能由写任务隐式带出。

---

## 3. 管理端 API

管理端路由使用常规的管理员 Bearer 令牌。

| 方法 | 路径 | 权限 | 用途 |
|---|---|---|---|
| `POST` | `/api/v1/platform/sideloads` | `host:admin` | 创建令牌 |
| `GET` | `/api/v1/platform/sideloads?host_id=` | `host:read` | 列出令牌（全部或指定主机） |
| `DELETE` | `/api/v1/platform/sideloads/:id` | `host:admin` | 删除令牌 |

创建请求：

```json
{
  "host_id": "hst_…",
  "name": "笔记本",
  "scopes": ["tasks:read", "tasks:write", "builders:read"],
  "expires_in_days": 30
}
```

- `expires_in_days` 可选（1–3650），不填表示永不过期。
- 响应包含 `sideload`、`token`、`base_url`。**明文令牌只在这里出现一次**；控制面只保存 SHA-256 哈希和后四位
  （`token_hint`）。
- 删除是永久的：记录立即消失，令牌在下一次调用时就是未知令牌（`403 SIDELOAD_TOKEN_INVALID`）。
  删除已经删除的令牌返回 `SIDELOAD_NOT_FOUND`。

---

## 4. 侧载 API

每个请求用 `authorization: Bearer sdl_…` 携带令牌。响应体就是调度机自己的任务 / 实例 / 队列投影，与管理应用
看到的一致。

| 方法 | 路径 | 需要的权限 |
|---|---|---|
| `GET` | `/api/v1/sideload/me` | 任意有效令牌 |
| `GET` | `/api/v1/sideload/builders` | `builders:read` |
| `GET` | `/api/v1/sideload/tasks?status=&limit=` | `tasks:read` |
| `POST` | `/api/v1/sideload/tasks` | `tasks:write`（`task.console.*` 另需 `console:run`） |
| `GET` | `/api/v1/sideload/tasks/:id` | `tasks:read` |
| `GET` | `/api/v1/sideload/tasks/:id/events` | `tasks:read` |
| `POST` | `/api/v1/sideload/tasks/:id/cancel` | `tasks:write` |
| `POST` | `/api/v1/sideload/tasks/:id/retry` | `tasks:write` |
| `POST` | `/api/v1/sideload/tasks/:id/answer` | `tasks:write` |
| `POST` | `/api/v1/sideload/attachments` | `tasks:write` |
| `GET` | `/api/v1/sideload/tasks/:id/artifacts` | `tasks:read` |
| `GET` | `/api/v1/sideload/artifacts/:id/download` | `tasks:read` |
| `GET` | `/api/v1/sideload/queue` | `queue:read` |

### curl

```bash
export SIDELOAD_TOKEN='sdl_…'

# 我是谁（主机、权限、在线状态）
curl -sS "$PCS/api/v1/sideload/me" -H "authorization: Bearer $SIDELOAD_TOKEN"

# 根调度机子树里的构建机
curl -sS "$PCS/api/v1/sideload/builders" -H "authorization: Bearer $SIDELOAD_TOKEN"

# 创建任务（target_instance_id 可选，调度机按 W 选构建机）
curl -sS "$PCS/api/v1/sideload/tasks" \
  -H "authorization: Bearer $SIDELOAD_TOKEN" -H 'content-type: application/json' \
  -d '{"task_type":"task.console.builder","requirements":{"console":{"command":"nproc"}}}'

# 状态与事件流
curl -sS "$PCS/api/v1/sideload/tasks/<task_id>" -H "authorization: Bearer $SIDELOAD_TOKEN"
curl -sS "$PCS/api/v1/sideload/tasks/<task_id>/events" -H "authorization: Bearer $SIDELOAD_TOKEN"
```

`GET /me` 返回令牌所属主机、权限、`last_seen_at` 和过期时间，设备可以自己确认权限，不必问管理员。

### 文件进出

调度机有专门的文件通道，侧载不需要再把文件塞进 stdout。

**输入文件。** `POST /api/v1/sideload/attachments` 接收 JSON `{name, media_type, data_base64}`（单个附件
24 MiB，单次请求 32 MiB），返回附件引用。把引用放进任务：控制台任务用
`requirements.console.attachments`，构建任务用 `requirements.build.attachments`。命令执行前，构建机会把
它们写到 `<workspace>/attachments/`，并通过 `PLATFORM_ATTACHMENTS` 提供清单。任意格式都原样保存。

```bash
curl -sS "$PCS/api/v1/sideload/attachments" \
  -H "authorization: Bearer $SIDELOAD_TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"data.csv\",\"media_type\":\"text/csv\",\"data_base64\":\"$(base64 < data.csv)\"}"
```

**输出文件。** 控制台任务支持 `requirements.console.collect`：一组工作区相对路径，目录会递归展开
（不跟随符号链接）。上限：32 个路径、128 个文件、单文件 64 MiB、合计 256 MiB。每个文件都走调度机的
制品通道并由服务端重算 SHA-256；任务输出里会有 `artifacts`（`name`、`artifact_id`、`sha256`、
`size_bytes`、`media_type`），没能取回的路径列在 `collect_skipped`。Agent / 构建任务声明上传的产物
同样通过下面这组接口读取。

```json
{
  "task_type": "task.console.builder",
  "requirements": {
    "console": {
      "command": "g++ -O2 -std=c++17 hello.cpp -o hello && ./hello > result.txt",
      "collect": ["hello", "result.txt"]
    }
  }
}
```

**下载。** `GET /api/v1/sideload/tasks/:id/artifacts` 列出任务的文件；随后
`GET /api/v1/sideload/artifacts/:id/download` 返回原始字节，并带上记录的 `content-type`、
`content-disposition` 以及 `x-artifact-sha256` / `x-artifact-name`。不包 JSON、不转格式：64 MiB 的二进制
文件逐字节到达。列表里的名称（含相对目录）可用于在本地还原目录结构。

`scripts/sideload-project.mjs` 把两个方向都封装好了：

```bash
SIDELOAD_TOKEN='sdl_…' PCS_URL='http://192.168.10.110:7901' \
  node scripts/sideload-project.mjs --out tmp/hello-cpp \
  --upload ./input/data.csv \
  --command 'g++ -O2 -std=c++17 hello.cpp -o hello && ./hello > result.txt' \
  --collect .
```

需要 `tasks:write` + `console:run`（下载还需要 `tasks:read`）；`--instance <id>` 指定构建机。`--upload`
可重复，`--collect` 默认 `.` 且可重复；脚本会先按调度机的 SHA-256 校验每个下载文件，再写入 `--out`。

---

## 5. 在线状态与过期

- `last_seen_at` 在认证通过的调用上更新，最多每 30 秒写一次。
- 最近 120 秒内调用过，工作室显示**在线**；已过期的令牌始终显示已失效，即使刚调用过。
- 删除和过期在下一个请求生效：设备在删除后收到 `403 SIDELOAD_TOKEN_INVALID`，过期后收到 `403 SIDELOAD_EXPIRED`。
- 主机没有运行中的调度机时返回 `503 SCHEDULER_NOT_DEPLOYED`；令牌仍然有效，部署调度机后自动恢复。

---

## 6. 安全说明

- 把令牌当密码对待。它只显示一次；丢了就删掉再建一个。
- 面向可信局域网。如果 PCS 暴露到更大范围，请加 HTTPS 与防火墙 / VPN。
- 令牌只到 PCS。PCS 在内部解析主机的根调度机，设备看不到调度机地址或实例凭证。
- `builders` 返回根调度机子树（本机 + 并入的下级主机），也就是任务真正能跑到的地方；侧载卡片本身仍严格按主机隔离。
- 创建与删除写入 `sideload.create` / `sideload.delete` 审计记录；令牌及其哈希不写日志。

---

## 7. 管理界面

- 侧载区在 AI Agent 工作室里、根调度机上方排成一行，每张卡片都用带动画的连接线连到调度机。
  「接入侧载」卡片点开填写名称、勾选权限、选择有效期（7 / 30 / 90 天或永不过期）。
- 创建成功后对话框只展示一次明文令牌、复制按钮和控制面地址。
- 每张侧载卡片显示主机卡通、在线 / 离线状态、令牌后四位和权限标签。点开可看权限、时间、来源地址，以及**删除**。
