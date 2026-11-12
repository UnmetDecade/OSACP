# 平台管理应用（v4）

> [English](README.md) · 简体中文

小型研发平台的单页管理应用：两个角色（调度机 / 构建机）、两个机器人（派令 / 夯台），
没有管理员、审核员、审批与权限矩阵。架构说明见 [../docs/admin-app.zh-CN.md](../docs/admin-app.zh-CN.md)。

数据全部来自实时连接：页面同源代理到调度机与控制面（`/api/scheduler`、`/api/pcs`），
打开页面即同步，之后每 15 秒刷新。没有演示模式，也没有内置数据。

## 运行

```bash
npm install
npm run dev      # http://localhost:5173（本仓库开发时用的 5178）
npm run build    # 类型检查 + 生产构建
node scripts/capture-ui.mjs            # 全路由截图（需要调度机与 PCS 可达）
node scripts/capture-ui.mjs --dark     # 深色模式
ADMIN_TOKEN=... node scripts/capture-ui.mjs  # 带令牌截图
node scripts/capture-readme.mjs --lang en    # 生成 README 截图/动画到 ../docs/assets
```

开发服务器把 `/api/pcs` 代理到 `http://127.0.0.1:7901`、`/api/scheduler` 代理到
`http://127.0.0.1:8443`（见 `vite.config.ts`，可用 `VITE_PCS_TARGET` /
`VITE_SCHEDULER_TARGET` 覆盖）。页面不填连接地址；左下角状态按钮显示「未连接 / 实时 / 连接失败」，
点击可立即重新同步。

管理员令牌由开发代理注入，浏览器不需要持有：把 `PCS_ADMIN_TOKEN=...` 写进
`admin-app/.env.local`（已被 `.gitignore` 的 `*.local` 覆盖，权限 600），或在启动
`npm run dev` 前设置同名环境变量。代理只在请求没有自带 `Authorization` 时补上，
所以 `sessionStorage` 里的令牌仍然优先。令牌不会进入前端包、URL 或 localStorage。

API 前缀带 `/api`：`/scheduler` 本身是页面路由，拿它当代理前缀时刷新该页面会把
导航请求转发给调度机，看到的是 `{"code":"ROUTE_NOT_FOUND"}`。

连接时只校验调度机可达性，PCS 连不上不影响查看任务与构建机状态。连接后每 15 秒增量
同步一次，并在窗口重新获得焦点时刷新；写操作完成后立即刷新。

实时连接行为：

- 创建构建机走 PCS 部署计划（`plan_id` / `plan_digest`），宿主 SSH 端口通过
  `instance.ports` 下发，由 Host Runtime 写进 `PortBindings`。
- 任务提交使用 `wft_build` 单阶段工作流，任务事件来自 `/v1/tasks/:id/events`。
- Agent / API Profile 由控制面维护，界面只做绑定。
  绑定只改控制面事实，Host Runtime 重新加载后才切换执行 Agent。
- 对话与容器终端都是普通调度任务（`task.chat.*` / `task.console.*`），保留租约与
  fencing；终端是完整 shell，没有命令白名单。
- 日志页只显示控制面审计记录，不伪造数据。

## 机器人、对话与容器终端

实例卡片把调度机画成「派令」、构建机画成「夯台」：空闲、工作中、告警、离线各有状态
动画。卡片和详情页可以直接更换 Agent Profile，可选角色为 builder 或 scheduler。

- **对话**（`/chat`）：每条消息通过 `POST /v1/tasks` 创建一次 `task.chat.<role>`，轮询到
  终态后显示回复。确定性执行器返回 `mode=deterministic`，Agent Profile 返回
  `mode=agent`，界面会标注回复来源。对话只保存在当前标签页，刷新即清空。
- **终端**（`/terminal`）：命令经 `task.console.builder` 或 `task.console.scheduler`
  派发，在容器内执行完整 shell，与 SSH 等价；没有命令白名单。需要交互式 shell 时直接
  `ssh root@<host> -p <port>`。

## 主机

一台主机 = 一台跑 Docker 的机器，调度机与构建机都是它上面的容器。侧栏底部的「当前主机」
决定其余页面看到什么——总览、构建机、调度机、任务、终端、对话都只显示这台主机的组件和
任务；切换后左上方页面内容随之切换。主机页（`/hosts`）不在上方导航里，从侧栏底部
主机菜单的「管理主机」进入。每台主机有一台根调度机，可再加挂结点调度机；页面上的「部署调度机」只针对当前主机。
主机按接入方式分两类：

- **本地主机**：运行管理页面 / PCS 的机器，不需要 SSH。PCS 直接在本机探测与引导。
- **SSH 主机**：填地址、端口、用户和私钥接入，要求已装 Docker 且当前用户能访问 Docker。

添加主机时 PCS 会立刻探测一次（系统、架构、Docker 版本、当前用户是否有 Docker 权限），
结果显示在主机行上；之后也可以手动「探测」，探测只读，不修改主机。

私钥的处理：

- 浏览器只在提交表单时把私钥发给 PCS，提交后立即从组件状态里清空。
- PCS 用 AES-256-GCM 加密入库，密钥来自 `PCS_CREDENTIAL_KEY_FILE`；接口与页面只回显
  SHA-256 指纹，任何时候都不会把私钥读回来。
- 探测时私钥临时写入 0600 文件，命令结束即删；使用 `BatchMode=yes`、`IdentitiesOnly=yes`
  与独立的临时 `known_hosts`。

「启动运行时」把 host-runtime 装到主机上：

1. PCS 用 esbuild 把 `host-runtime` 打成自包含的 `runtime.mjs` / `watchdog.mjs`；
2. 通过 SSH（本地主机则直接在机器上执行）写到 `$HOME/.platform/host-runtime/<host_id>/`；
3. 用一次性注册令牌启动，主机主动连 PCS 拉签名命令；入网后状态变 ONLINE / DEGRADED。

引导可重复：再次点击「重新引导运行时」只会停掉该主机目录下的旧进程并重启。远程主机需要
能访问 `PCS_RUNTIME_URL`，并且有 Node 22+。详细前置条件见
[../deploy/README.zh-CN.md](../deploy/README.zh-CN.md#多主机本地主机与-ssh-主机)。

「部署调度机」把调度机容器落到选中的主机（本地或 SSH 都可以）：填调度机镜像、数据库地址、
宿主端口和资源，PCS 生成部署计划后由该主机的 host-runtime 拉起容器。每台主机只有一台根调度机，
根调度机已存在时只能再加挂结点调度机；PCS 以 `ROOT_SCHEDULER_EXISTS` 拒绝重复部署根。
数据库地址会作为部署意图的 env 下发，表单里只该填研发库凭据。

主机行能直接跳到「新建构建机」，表单会预选这台主机；点击主机名会把它设为当前主机。

## 创建构建机

- 主机：从状态为 ONLINE / WARNING 的主机中选择；没有可部署主机时先到主机页接入。
- 系统：Ubuntu 20.04 / 22.04 / 24.04 / 26.04。
- 资源档位：轻量 / 标准 / 重型，或「自定义」填 CPU（0.5–16 核）、内存（512–65536 MiB）、
  磁盘（8–1024 GiB）。
- Agent：Claude Code / Codex / DeepSeek / 自定义。
- API 权限：勾选该构建机可以访问的 API Profile。
- SSH：宿主端口自动顺延，创建后显示 `ssh root@<host> -p <port>`。

## 选择 Agent（Claude Code / Codex / DeepSeek）

两种接入方式：

- **stdio-jsonrpc**：`agents/cli-agent.mjs` 把任务与工作区提示交给外部 CLI，再把 stdout
  映射为 `agent.result`。启动 CLI 前会剥离 `PLATFORM_TOOL_TOKEN` / `PLATFORM_API_PROXY` /
  `PLATFORM_API_PROFILES`，取消时杀进程组。
- **http-local**：OpenAI 兼容的 HTTP Agent，DeepSeek 走这一类；模型地址与密钥放在
  llm 类型的 API Profile 里，Agent Profile 只保存 `model_api_profile_id` 引用。

```bash
# 在 PCS 注册 Claude Code / Codex Profile（镜像仍须 digest 固定）
ADMIN_TOKEN=... AGENT_IMAGE=registry.example/agents/claude@sha256:<64hex> \
  PLATFORM_DIR=/opt/platform AGENT_NODE=node \
  AGENT_PASS_ENV=ANTHROPIC_API_KEY \
  node scripts/seed-cli-agents.mjs --bind builder-ubuntu22-a:claude
```

`AGENT_PASS_ENV` 只列变量名（可逗号分隔），外部 CLI 默认不继承宿主环境。绑定只写控制面：
重启实例后才真正切换执行 Agent。

CLI 未安装时任务以 `AGENT_NOT_READY / CLI_NOT_INSTALLED` 失败，不会静默改用其他执行器。

## 技术栈

- React 19 + TypeScript + Vite
- `react-router-dom` 7：路由
- 零 UI 框架依赖：自带中性浅色 / 深色设计 token、内联 SVG 图标与组件

## 目录

```
src/
├── App.tsx                     # 路由：/ /hosts /builders /scheduler /profiles /tasks /terminal /chat /logs
├── api.ts                      # 实时请求门面
├── store.ts                    # 运行时数据仓库（同步写入，页面只读）
├── host-context.tsx            # 当前主机（sessionStorage，侧栏底部切换）
├── host-tasks.ts               # 任务 → 主机：已派发按实例，未派发归主机的调度机
├── characters.ts               # 派令 / 夯台 的 SVG 形象与状态
├── types.ts                    # Host / Instance / Task / AgentProfile / ApiProfile
├── live/
│   ├── config.ts               # 同源连接与可选的 sessionStorage 令牌
│   ├── client.ts               # 调度机 / PCS 请求与错误归一化
│   ├── sync.ts                 # 服务端事实 → 页面数据模型
│   ├── actions.ts              # 部署计划、实例动作、任务、Agent 绑定
│   └── context.tsx             # LiveProvider：15s 同步与全局刷新
├── components/                 # Layout、UI 原子组件、Character、DeployScheduler
└── pages/
    ├── Dashboard.tsx           # 研发工作台
    ├── Hosts.tsx               # 主机：本地 / SSH 接入、探测、引导 host-runtime
    ├── Builders.tsx            # 构建机列表 + 新建（主机 / 系统 / 自定义资源 / Agent）
    ├── BuilderShow.tsx         # 构建机详情、SSH、换 Agent
    ├── Scheduler.tsx           # 调度机、队列、调度 Agent
    ├── Tasks.tsx               # 任务列表 / 详情 / 提交
    ├── Terminal.tsx            # 容器内完整 Shell
    ├── Chat.tsx                # 与派令 / 夯台对话
    └── Profiles.tsx            # Agent / API Profile 与绑定
```

## 已实现的领域约束

- **主机是部署边界**：部署计划必须指定一台 ONLINE / DEGRADED 主机；PCS 只写期望态与
  签名命令，容器由该主机上的 host-runtime 创建，PCS 不直接调用 Docker。
- **每台主机一台根调度机**：PCS 用 `ROOT_SCHEDULER_EXISTS` 拒绝重复部署根；结点调度机按父调度机递归挂载。
- **任务按主机归属**：已指派的任务跟随目标实例所在主机；未指派的任务归当前主机的调度机，
  没有调度机的主机不显示它们。
- **私钥单向**：SSH 私钥只进不出，接口与页面只有指纹；加密密钥不在数据库里。
- **部署计划摘要**：预览生成 `plan_id` + `plan_digest`；应用时重新计算，不一致返回
  `PLAN_CHANGED`。
- **SSH 端口随部署下发**：构建机固定容器端口 22，宿主端口由 PCS 按计划递增；
  控件读取部署记录的 `ports` 并显示 `ssh_host` / `ssh_port`。
- **镜像必须固定 digest**：创建构建机时复用同系统已有构建机的 digest，只有 tag 会报错。
- **无角色权限**：没有管理员 / 审核员 / 审批；连接后可做所有操作。
- **界面不出现密钥**：API 只展示 `secret_ref` 与轮换时间；令牌只存 `sessionStorage`。
- **审计只追加**：部署、实例动作、任务、Agent 绑定都会写入控制面审计。

## 上手路径

1. 总览 → 看派令 / 夯台与队列概况。
2. 主机 → 添加本地主机 → 探测 → 启动运行时；再添加一台 SSH 主机看接入表单。
3. 构建机 → 新建 → 选主机 → 选 Ubuntu 24.04 → 资源「自定义」→ 选 DeepSeek Coder → 创建。
4. 调度机 → 查看调度 Agent（DeepSeek 调度助手）→「问派令」。
5. 任务 → 提交构建 → 看事件时间线与日志。
6. 终端 → 直接执行管道、重定向与 `apt`。
7. 日志 → 查看调度机与控制面的操作记录。

## 下一步

- 套 Tauri 2 外壳：令牌与 SSE 移到 Rust 侧，页面经 IPC 白名单调用；补齐 Windows 打包与签名。
- 日志页接入真实日志采集（当前实时模式明确显示未接入，不伪造数据）。
- 用 OpenAPI 生成 `packages/contracts`，让请求/响应类型与文档同源。
- 列表页改用 Refine resource 定义，流程页保持自研（见规范 §3）。
