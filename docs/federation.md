# 控制面与主机联邦

> 版本：v4.3 · 2026-11-12
> 本文说明控制面（PCS）、主机接入与递归调度机拓扑；角色划分见 [总体架构](architecture.md)。

---

## 1. 角色与拓扑

一台主机只有一种角色，`pcs_hosts.role_mode` 取 `containers` / `builder` / `scheduler`：

| `role_mode` | 含义 |
|---|---|
| `containers`（默认） | 主机只提供容器运行环境，可以同时跑多个构建机与调度机容器 |
| `builder` | 整台主机直接充当一台构建机 |
| `scheduler` | 整台主机直接充当一台调度机 |

写死一条规则：**同一台主机不能同时是构建机和调度机**。容器模式下，每台主机有且仅有一台根调度机，还可以在同一台主机上再起任意多台结点调度机；构建机容器不限，按部署时选择的调度机归属。每台调度机（根或结点）各自一套库，PCS 会把主机名册推给该主机上的所有调度机，构建机才能注册到结点。

```
根调度机（主机 A）
├── 叶构建机 a-1（归属根）
├── 结点调度机 a-node（主机 A）
│   └── 叶构建机 a-2（归属 a-node）
├── 结点调度机（主机 B，即 B 的根在 A 视角下的形态）
│   └── 叶构建机 b-1
└── 叶构建机 a-3
```

---

## 2. 主机并入

`pcs_hosts.parent_host_id` 记录上级主机。规则：

- 不能并入自己（`HOST_MERGE_SELF`）。
- 不能并入自己的下级，否则成环（`HOST_MERGE_CYCLE`）。
- 两台主机都必须已有根调度机；下级没有根调度机就没有可向上汇报的结点（`CHILD_SCHEDULER_MISSING`），上级没有根调度机则无处接收（`PARENT_SCHEDULER_MISSING`）。

并入只改一行引用，不重启任何容器：主机 B 的根调度机在主机 A 的视角里是结点调度机，而在 B 内部仍然是根调度机。PCS 随后调用 B 根调度机的 `POST /v1/federation/parent`，把 A 根调度机的地址写成它的运行时上级；脱离时写入 `null`。调度机在上报周期里读取这个运行时值，所以合并/脱离不需要重部署。

`POST .../unmerge` 把 `parent_host_id` 置空即恢复独立；父结点会忽略连续错过多次上报的旧子结点（默认 90 秒以上），ΣW 自动回落。

PCS 接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/v1/platform/fleet` | 整棵联邦树：每台主机的本地 W、子树 ΣW、构建机数、子主机 |
| `POST` | `/api/v1/platform/hosts/:id/merge` | 并入上级，body `{ parent_host_id }` |
| `POST` | `/api/v1/platform/hosts/:id/unmerge` | 脱离上级 |

---

## 3. 工作能力值 W

创建构建机时给出六项资源，按权重归一化到 0–1000：

| 项 | 权重 | 上限 |
|---|---:|---:|
| CPU 核心数 | 30% | 8 |
| 核心频率 | 15% | 4 GHz |
| 内存 | 20% | 32 GB |
| 存储 | 10% | 256 GB |
| 模型能力 | 15% | 10 |
| API 能力 | 10% | 10 |

```
W = round(1000 × Σ(权重 × min(值, 上限) / 上限))
```

- 公式在 `pcs-issuer/src/capability.ts`，管理应用 `admin-app/src/capability.ts` 做同一份预览。
- 调度机不参与 W，分值固定为 0。
- 部署计划应用时把 W 冻结进部署行，并注入构建机容器：

| 环境变量 | 内容 |
|---|---|
| `CAPABILITY_SCORE` | 0–1000 的整数 |
| `CAPABILITY_DETAIL` | 六项原始资源 JSON，用于界面解释 W 的构成 |

构建机启动时把这两个值随注册请求上报给调度机；没上报 W 的旧实例保持原有行为。

---

## 4. 任务难度 D

任务可以带 `difficulty`（0–1000，0 = 不限）。调度机领取条件：

```sql
($7 <= 0 OR t.difficulty <= $7)   -- $7 是该构建机的 capability_score
```

即难度 D 的任务只会派给 W ≥ D 的构建机。结点调度机向上汇报时汇总子树 W，根调度机据此看到整棵树的可用能力。

---

## 5. 结点上报

每个结点调度机按 `SCHEDULER_FEDERATION_INTERVAL_MS` 周期向 `SCHEDULER_PARENT_URL` 发：

```
POST /v1/nodes/report
x-federation-token: <SCHEDULER_FEDERATION_TOKEN>
{ node_id, host_id, local_score, subtree_score, builder_count,
  max_builder_score, idle_builder_count, url, instances }
```

父结点在 `scheduler_nodes` 只保存直接子结点的一行，取总数时把自己的本地 W 与各子结点的 `subtree_score` 相加，因此孙结点不会被重复计算。

容量指标（`builder_count` / `max_builder_score` / `idle_builder_count`）报的是**整棵子树**的值：中间结点自己可能一台构建机都没有，但子树里有能接住难度 D 的机器，上层据此决定往哪个子结点下推任务。`instances` 同样汇总子树名册，用于判断目标实例挂在哪个子结点下。`url` 是本调度机对外可达的地址（`SCHEDULER_ADVERTISE_URL`），中继请求直接打到这个地址。相关环境变量：

| 变量 | 作用 |
|---|---|
| `SCHEDULER_NODE_ID` | 本调度机在联邦树里的节点 id，默认 `<host_id>:root` |
| `SCHEDULER_HOST_ID` | 所属主机 id，PCS 部署时注入 |
| `SCHEDULER_PARENT_URL` | 上级调度机地址的初始值；为空表示本机是根。主机并入后由 PCS 通过 `/v1/federation/parent` 在运行时设置，不需要重启 |
| `SCHEDULER_FEDERATION_TOKEN` | 联邦令牌：PCS 给根和结点都注入。根用它校验子结点上报，结点用它上报；未配置时 `/v1/nodes/report` 返回 503 |
| `SCHEDULER_ADVERTISE_URL` | 本调度机对子树可见的地址；为空时不上报 `url`，父结点不会向它中继任务 |
| `SCHEDULER_RELAY_SYNC_MS` | 父结点拉取子任务状态的周期，默认与回收周期同源 |

查询接口：`GET /v1/capability`（本机汇总）、`GET /v1/nodes`（直接子树与上报明细）。

---

## 6. 跨调度机中继

任务提交到哪台调度机都可以，调度机只执行自己接得住的：

1. 任务**带目标实例**：本机 `role_instances` 里有该实例就留在本机；否则在直接子结点的 `instances` 名册里找。名册命中不代表子结点自己执行——子结点同样先查本地，查不到再往下一层找，所以 根 → 结点 → 孙结点 可以逐跳下推。
2. 任务**不带目标实例**（如构建任务）：本机有在线且 W ≥ D 的构建机就留在本机，否则按容量挑一个直接子结点：难度 D > 0 时优先能力刚好够的（`max_builder_score` 升序），不限难度时优先更闲的（`idle_builder_count` 降序）。

下推语义：

- **只下推、不复制**。父任务留在父调度机自己的库里，状态保持 `QUEUED`，但 `task_relays` 里有 ACTIVE 行，领取候选会排除它，不会两边同时执行。
- 子调度机通过 `POST /v1/tasks` 建任务，body 带 `relay: { parent_task_id, parent_node_id, depth }`。子任务用 `tasks.relay_parent_task_id` 唯一约束去重，重复投递不会建出第二条。
- 父调度机周期拉取子任务（`SCHEDULER_RELAY_SYNC_MS`），把状态、摘要和输出镜像回父任务；多级中继时输出从嵌套的 `child_result` 里取，最终根结点拿到的仍是执行方的 stdout/stderr。
- 取消向下转发：父任务取消 → 向子任务 `POST /v1/tasks/:id/cancel`，子任务再向下转发。
- 深度上限 `MAX_RELAY_DEPTH = 8`；工作流子任务不中继，状态机必须留在同一个库里。
- 子树整体接不住时任务留在原调度机排队，不会凭空消失；子结点不可达只累计 `sync_failures`，不重复执行。

任务详情里的 `relay` 字段给出下推位置与子任务结果：

```json
{ "node_id": "hst_...:node-scheduler-a",
  "child_task_id": "task_xxx",
  "state": "DONE", "child_state": "SUCCEEDED",
  "child_result": { "summary": "...", "outputs": { "stdout": "..." } } }
```

管理应用按部署逐台调度机查任务列表，所以根和结点上的任务都能看到；操作（取消/重试/事件）会带 `scheduler_deployment_id` 回到任务所在的调度机。

---

## 7. 当前实现边界

已实现：

- PCS 记录主机角色、联邦树、并入/脱离；部署时校验角色冲突与环。
- 构建机 W 的计算、冻结、注入、上报；任务 D 的领取过滤。
- 结点调度机向父结点上报子树 ΣW 与容量指标，根结点聚合。
- 跨调度机中继：按目标实例或容量逐级下推，镜像状态/输出，取消向下转发，最大深度 8。
- 管理应用的主机树、ΣW、角色切换、任务难度输入与展示；结点调度机同样可以在自己的卡片下添加角色。

尚未实现：

- **裸机角色执行**：`role_mode` 已记录并用于部署冲突校验，但整机直接作为构建机/调度机运行（不套容器）还没有执行路径。
