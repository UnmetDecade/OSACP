# 分配调度算法

> [English](scheduling-algorithm.md) · 简体中文

> 版本：v0.3 · 2026-11-13
> 范围：决定**哪个 Builder 运行哪个任务、分到多少 CPU 和内存**的数学与规则。
> 代码：[`scheduler/src/core/resources.ts`](../scheduler/src/core/resources.ts)、[`capability.ts`](../scheduler/src/capability.ts)、[`claim.ts`](../scheduler/src/core/claim.ts)、[`repo/resources.ts`](../scheduler/src/repo/resources.ts)、[`host-runtime/src/cgroup.ts`](../host-runtime/src/cgroup.ts)、[`pcs-issuer/src/service.ts`](../pcs-issuer/src/service.ts)。

调度核心刻意保持"无聊"：**没有 LLM，没有随机数，热路径里没有浮点**。每个决策都能从 PostgreSQL 的行复现，每次分配都带一个主机可以校验的代数（generation）。

---

## 0. 两种模式，一套契约

| | 静态 | 动态 |
|---|---|---|
| 容量模型 | 每个部署固定预算 | 主机资源池 + 每实例 cgroup 配额 |
| 准入 | 部署期内存预算；运行期内存预留 | 每几秒重算一次的公平份额授予（grant） |
| 并发 | 每个 Builder 固定 `instance_limit` | 由剩余授予量按任务类型推导的 `k(i, τ)` |
| 能力值 `W` | 部署时冻结 | 实时：`W_static + H_res × W_res`，派发用百分位平滑值 |
| 超卖 | 关闭 | 显式允许，由 cgroup 强制执行 |

两种模式共用同一套队列、租约、fencing、中继和状态机代码。模式在主机**根调度器**上选定一次，由其节点调度器和 Builder 继承（[`service.ts:3052`](../pcs-issuer/src/service.ts#L3052)）。

两种模式下都成立的硬规则：

1. 能力评分永远不能替代资源准入，资源授予也永远不能替代 Agent/工具匹配。
2. 每个主机池只有一个权威调度器；节点调度器不计算本地配额。
3. 主机安全由 cgroup 保证，不依赖容器的自觉。
4. 所有公式都是确定性的、可审计的；平局用稳定 ID 打破。
5. 为了回收内存而杀死任务是不允许的。压缩授予只会限流，不会重启工作。

---

## 1. 符号

| 符号 | 含义 |
|---|---|
| `W` | Builder 能力值，0–1000 |
| `D` | 任务难度，0–1000；`0` 表示不限 |
| `W_static` | W 中与负载无关的部分：主频、磁盘、模型、API（上限 500） |
| `W_res` | W 中与负载相关的部分：CPU 核数、内存（上限 500） |
| `W0` | 名义上限 `W_static + W_res(cap)` |
| `W_live(t)` | 实时能力 `W_static + H_res(t) × W_res(cap)` |
| `W_dispatch` | 派发用的保守值：近期 `W_live` 的 25 分位 |
| `C_cpu`、`C_mem` | 池容量：父 cgroup 的硬上限 |
| `cap_i` | 实例 `i` 的部署上限（毫核 / 字节） |
| `request_i(τ)` | 类型 `τ` 的单个任务资源需求 |
| `reserved_i` | 实例 `i` 上活跃租约已承诺的资源 |
| `grant_i(t)` | 当前授予实例 `i` 的公平份额 |
| `usage_i(t)` | 实际用量（工作集 / CPU 核数） |
| `k(i, τ)` | 实例 `i` 还能接受多少个类型 `τ` 的并发任务 |
| `H_res` | 资源争用系数，只作用于 `W_res` |
| `PSI` | Pressure Stall Information |

---

## 2. 能力值 `W`

### 2.1 静态公式

```
W = round(1000 × (
      0.30 × min(cores    / 8,   1) +
      0.15 × min(freq_ghz / 4,   1) +
      0.20 × min(mem_gb   / 32,  1) +
      0.10 × min(disk_gb  / 256, 1) +
      0.15 × min(model    / 10,  1) +
      0.10 × min(api      / 10,  1)
    ))
```

| 分项 | 权重 | 归一化上限 |
|---|---|---|
| CPU 核数 | 30% | 8 |
| 主频 | 15% | 4.0 GHz |
| 内存 | 20% | 32 GiB |
| 磁盘 | 10% | 256 GiB |
| 模型能力 | 15% | 10 |
| API 能力 | 10% | 10 |

上限代表"当前世代的一台满配单机"。超过上限一律计满分，避免一台超大主机把整个分数量表压平。静态模式下 `W` 在部署时计算一次、冻结，并注入 Builder 容器（[`capability.ts:45`](../scheduler/src/capability.ts#L45)）。

### 2.2 动态拆分

```
R_freq  = min(freq_ghz / 4,   1)
R_disk  = min(disk_gb  / 256, 1)
R_model = min(model    / 10,  1)
R_api   = min(api      / 10,  1)
R_cpu(c) = min(c / 8,  1)
R_mem(m) = min(m / 32, 1)

W_static    = 1000 × (0.15·R_freq + 0.10·R_disk + 0.15·R_model + 0.10·R_api)   ∈ [0, 500]
W_res(c, m) = 1000 × (0.30·R_cpu(c) + 0.20·R_mem(m))                            ∈ [0, 500]

W0_i        = W_static + W_res(cap_i)                     -- 上限
W_live_i(t) = W_static + H_res(t) × W_res(cap_i)          -- 实时
W_dispatch_i(t) = percentile_25({ W_live_i(τ) : τ ∈ 最近 15 s })
```

只有 CPU/内存那一半会随争用衰减。主频、磁盘、模型、API 保持不变，因此一台忙碌的主机仍然对外宣称那些不依赖空闲内存的能力。

`percentile_25` 在进程内滑动窗口上做最近秩取值（[`repo/resources.ts:329`](../scheduler/src/repo/resources.ts#L329)）。重启丢失窗口只会让第一次重算略微不那么保守，不影响授予的正确性。

需要整体随争用衰减的部署可以把 `w_degrade_scope` 设为 `whole`：

```
W_live = max(w_floor, round(W0 × H_res))
```

### 2.3 `H_res`：只算真实用量

```
U_mem = clamp(EWMA_α(working_set(pool)) / C_mem, 0, 1)
U_cpu = clamp(EWMA_α(cpu_usage_cores(pool)) / C_cpu, 0, 1)
H_res = clamp(1 − max(U_mem, U_cpu), h_min, 1)
```

- `working_set = memory.current − memory.stat.inactive_file`，按 cgroup 采样（[`cgroup.ts:138`](../host-runtime/src/cgroup.ts#L138)）；
- `cpu_usage_cores = Δcpu.stat.usage_usec / Δt / 1e6`；
- 池级用量在入库时按 `α = 0.3` 平滑（[`repo/hosts.ts:62`](../scheduler/src/repo/hosts.ts#L62)）；
- `h_min = 0.05`，保证 `W_live` 永不为零；
- **已承诺但未使用的授予不计入**。一个已准入但尚未触碰内存的任务不会拉低 `W`；它的承诺体现在准入预算里。

### 2.4 各处使用哪个分数

| 字段 | 静态 | 动态 | 用途 |
|---|---|---|---|
| `capability_ceiling` | 冻结的 `W` | `W0` | 跨节点资格判定（`max_builder_ceiling ≥ D`）、跨模式中继排序 |
| `capability_live` | 冻结的 `W` | `W_live`（瞬时） | 同模式中继排序 |
| `capability_dispatch` | 冻结的 `W` | `W_dispatch`（P25，15 s） | 本地领取资格与难度过滤（`D ≤ dispatch`，回退到 `live`、再回退到冻结 `W`） |
| `capability_guaranteed` | 冻结的 `W` | `W_static + W_res(均分)` | 容量规划与 UI 展示 |

本地资格同样接受 `max(dispatch, live) ≥ D`，刚变快的构建机不会因为一个窗口的平滑值被拒之门外。跨节点资格绝不使用实时值，因为远端快照可能已经过期。

任意两个分数只有在 `capability_schema_version` 相同时才可比较。当前实现使用版本 `1`（[`repo/resources.ts:496`](../scheduler/src/repo/resources.ts#L496)）。

---

## 3. 静态模式

### 3.1 部署期准入（PCS）

接受部署计划前，PCS 执行固定清单（[`service.ts:3201`](../pcs-issuer/src/service.ts#L3201)）：

| 检查项 | 规则 |
|---|---|
| `host_online` | 主机为 `ONLINE` 或 `DEGRADED` |
| `image_pinned` | 镜像引用以 `@sha256:<64 位十六进制>` 结尾 |
| `network_policy` | 策略在配置的允许列表内 |
| `agent_binding` | 绑定的 Agent profile 与角色匹配 |
| `api_bindings` | 每个绑定的 API profile 均已启用 |
| `scheduler_url` | Builder 有可注册的调度器 |
| `memory_budget` | `memory_limit_bytes × count ≤ host.mem_available_bytes` |

失败返回 `409 DEPLOYMENT_CHECK_FAILED`，并附完整检查清单。

### 3.2 领取准入（调度器）

在同一事务中，锁定主机行和实例行之后（[`claim.ts:117`](../scheduler/src/core/claim.ts#L117)）：

1. 实例 `ONLINE` 且绑定了 Agent profile。
2. 主机状态为 `NORMAL` 或 `WARNING`。
3. 实例上的活跃租约 `< instance_limit`。
4. 全局租约 `< global_limit`；角色池内租约 `< role_pool_limit`。
5. 对每个候选：任务类型上限、能力子集、payload schema、目标实例、`D ≤ W`（`W = 0` 即升级前的 Builder 时跳过）。
6. 静态内存预算：

```
Σ memory_bytes(本主机 HELD|ACTIVE 预留) + request_mem
    ≤ host.mem_available_bytes
```

静态模式下 CPU 预留会被记录，但**不**参与准入判定。这是一个已知限制，文档写明而不是隐藏。

### 3.3 排序与老化

```
effective_priority = priority_class - floor(waited_seconds / aging_after_seconds)   （P0 永不老化）
ORDER BY effective_priority ASC, enqueued_at ASC, task_id ASC
```

数值小的先运行。老化让饥饿的低优先级任务每 `aging_after_seconds`（默认 600 s）提升一级，最高到 P1（[`001_init.sql:23`](../scheduler/sql/001_init.sql#L23)）。每个排序都以稳定键收尾，同优先级任务不可能被随机重排。

### 3.4 并发默认值

| 限制 | 默认值 |
|---|---|
| `global_limit` | 100 |
| `role_pool_limit` | 20 |
| `instance_limit` | 1 |
| `task_type_limit` | 10 |
| `aging_after_seconds` | 600 |

---

## 4. 动态模式

### 4.1 资源池

每台主机暴露一棵 cgroup v2 树（[`cgroup.ts:1`](../host-runtime/src/cgroup.ts#L1)）：

```
<base>/osacp.slice/
  platform.slice/          host-runtime、调度辅助进程；memory.min 保护它们
  pool.slice/              所有 Builder；其 memory.max / cpu.max 即 C
    builder-<id>.scope/    每个 Builder 一个
```

池容量 `C_cpu` / `C_mem` 由主机上报，调度器视之为硬上限。若主机没有 cgroup v2，动态调度仍会做记账，但无法强制执行配额，此时调度器记录 `CGROUP_UNAVAILABLE`，而不是假装成功（[`claim.ts:369`](../scheduler/src/core/claim.ts#L369)）。

### 4.2 需求

对实例 `i`：

```
used_mem_i = working_set_i          （来自实例 cgroup，每几秒上报）
used_cpu_i = cpu_usage_cores_i

demand_mem_i = min(cap_mem_i, max(reserved_mem_i, used_mem_i, idle_floor_mem))
demand_cpu_i = min(cap_cpu_i, max(reserved_cpu_i, used_cpu_i, idle_floor_cpu))
```

`max` 是必需的：只看 `reserved` 会低估超出预留的实例；只看 `used` 会忽略已准入但尚未启动的任务。`idle_floor` 默认 128 MiB / 50 mCPU，且本身也受 `cap_i` 约束（[`resources.ts:157`](../scheduler/src/core/resources.ts#L157)）。

### 4.3 权重与公平份额

```
weight_cpu_i = cap_cpu_i / Σ cap_cpu      （千分比整数，最小 1）
weight_mem_i = cap_mem_i / Σ cap_mem

F_i = C × weight_i / Σ_{j ∈ active} weight_j
```

两个用同一 profile 声明的实例权重相同。空闲实例只占住自己的地板，其余份额可被借用。

### 4.4 加权 max-min 注水

分配器全程使用整数，重复重算不会漂移（[`resources.ts:207`](../scheduler/src/core/resources.ts#L207)）：

```
1. g_i = min(demand_i, cap_i, floor_i)                 -- floor 即 idle floor
2. remaining = C − Σ g_i
3. while remaining > 0 and 仍有 g_i < min(demand_i, cap_i):
     W = 活跃集合上的 Σ weight_i
     对每个活跃 i:
       room = min(demand_i, cap_i) − g_i
       add  = min(room, ⌊remaining × weight_i / W⌋, remaining − 本轮已分配)
       g_i += add;  本轮已分配 += add
     remaining −= 本轮已分配
4. 整数余数：按 instance_id 顺序，一次一毫核/一字节补齐（最多 len(items) + 4 轮）
```

性质：

- 恒有 `Σ g_i ≤ C` 且 `g_i ≤ min(demand_i, cap_i)`；
- 不会强行塞满：总需求低于 `C` 时，池子保持部分空闲；
- 相同输入必然产生相同输出；平局按 `instance_id` 升序；
- CPU 与内存独立注水，因此一个实例可能 CPU 富余而内存紧张。

同一套规则给出的借用语义：空闲实例贡献地板以上的全部容量；它的需求上升时，注水会恢复它并压缩借用者。当借用者的授予被压到已承诺量以下，会被标记为 `OVERCOMMITTED`，继续运行但停止接收新工作，直到账本追平（[`claim.ts:429`](../scheduler/src/core/claim.ts#L429)）。

### 4.5 授予 → cgroup 映射

| 授予值 | cgroup v2 文件 |
|---|---|
| `grant_mem` | `memory.low` |
| `grant_cpu` | `cpu.weight = max(1, round(10000 × grant_cpu / C_cpu))` |
| `cap_mem` | `memory.max` |
| `cap_cpu` | `cpu.max = cap_cpu × period / 1000` |
| 压力阈值 | `memory.high` |

`memory.high` 是两种模式差异最直观的地方：

| 压力状态 | `memory.high` |
|---|---|
| `NORMAL`、`BUSY` | `cap_mem`（只在 cap 处限流） |
| `PRESSURE` | `max(16 MiB, min(cap, 1.1 × grant_mem))` |
| `CRITICAL` | `max(16 MiB, min(cap, 1.0 × grant_mem))` |

压力下实例被限流在公平份额略上方；正常状态下可以借用直至 cap。`memory.low` 是受保护的授予，因此行为良好的实例不会因为邻居贪婪而被回收。host-runtime 写入每个值并读回校验，不做任何假设（[`cgroup.ts:271`](../host-runtime/src/cgroup.ts#L271)）。

### 4.6 授予生命周期

```
PENDING ──apply──▶ APPLIED
   │
   ├──▶ FAILED        （cgroup 写入被拒 / 池不可用）
   └──▶ SUPERSEDED    （存在更新的代数）
```

- 每次变化分配单调递增的 `generation`；未变化的分配保持原状态，不刷代数（[`repo/resources.ts:404`](../scheduler/src/repo/resources.ts#L404)）。
- 重算每 `GRANT_UPDATE_INTERVAL_MS`（5 s）运行一次，并在每次领取后立即触发，新预留不必等待周期 tick。
- `require_applied_before_start = true`（默认）时，动态 Builder 只有在 `grant.state === APPLIED` 且 `applied_generation ≥ generation` 后才能启动任务。没有强制上限就运行会被拒绝，而不是默默放行（[`claim.ts:408`](../scheduler/src/core/claim.ts#L408)）。

---

## 5. 并发 `k(i, τ)`

```
remaining_cpu_i = max(0, budget_cpu_i − reserved_cpu_i)
remaining_mem_i = max(0, budget_mem_i − reserved_mem_i)
budget_*        = min(cap_*, max(grant_*, F_*))

k(i, τ) = min( ⌊remaining_cpu_i / request_cpu(τ)⌋,
               ⌊remaining_mem_i / request_mem(τ)⌋ )
```

准入要求 `k(i, τ) ≥ 1` **且** `active_leases_of_type(τ) < task_type_instance_limit`。

- `k` 可以为 0，表示该实例完全不能接这类任务；
- 所有类型共享同一个 `remaining_*`，但每种类型各有自己的 `k`；
- 每实例每类型上限为 `task_type_instance_limit`（默认 4），同时约束算出的 `k` 与该类型的活跃租约数；
- 计算发生在实例行锁内、写入预留的同一事务中（[`claim.ts:494`](../scheduler/src/core/claim.ts#L494)）。

用 `max(grant, F_i)` 构造任务预算，使得空闲 Builder 在分配器调高其授予之前，就能按保证份额接活。

---

## 6. 压力状态机

池上利用率 `U = max(memory, cpu)`，进入与退出阈值分离以避免抖动（[`resources.ts:382`](../scheduler/src/core/resources.ts#L382)）：

| 从 | 到 | 条件 |
|---|---|---|
| `NORMAL` | `BUSY` | `U ≥ 0.70` |
| `BUSY` | `NORMAL` | `U ≤ 0.60` |
| `NORMAL`、`BUSY`、`RECOVERING` | `PRESSURE` | `U ≥ 0.85` |
| `PRESSURE` | `RECOVERING` | `U ≤ 0.75` |
| 任意状态 | `CRITICAL` | `U ≥ 0.95` |
| `CRITICAL` | `RECOVERING` | `U ≤ 0.90` |
| `RECOVERING` | `NORMAL` | `U ≤ 0.60` |

各状态的准入规则（[`resources.ts:412`](../scheduler/src/core/resources.ts#L412)）：

| 状态 | 新领取 |
|---|---|
| `NORMAL` | 允许 |
| `BUSY` | 允许，但 `H_res` 更低，授予更紧 |
| `PRESSURE` | 拒绝（`HOST_PRESSURE`，并终止本轮扫描） |
| `CRITICAL` | 拒绝；`memory.high` 压缩到授予值 |
| `RECOVERING` | 允许；必须回落到 `NORMAL` 的退出阈值才能离开 |

阈值是策略数据（`dynamic_policy.pressure_enter` / `pressure_exit`），不是硬编码常量；上面的默认值是标定点，不是普适真理。

---

## 7. 队列纪律、阻塞与退避

朴素的 `LIMIT 1` 候选查询会让一个不可调度的任务堵死整条队列。实现用四个机制解决（[`claim.ts:206`](../scheduler/src/core/claim.ts#L206)）：

1. **候选扫描**：每次领取最多考察 `max_candidate_scan`（20）个有序候选；被阻塞的候选记录在案，扫描继续。
2. **持久化阻塞状态**：被阻塞任务获得 `resource_block_reason`、`blocked_attempts`、`resource_retry_after`，并发出 `TASK_RESOURCE_BLOCKED` 事件。
3. **指数退避**：第 `n` 次尝试后等待 `min(backoff_max, base × 2^n)` 秒 —— 1、2、4、8 …… 默认封顶 60 s（[`resources.ts:371`](../scheduler/src/core/resources.ts#L371)）。
4. **永久不可调度**：需求永远放不下的任务（大于主机总预算），在 `max_blocked_attempts`（8）次后标记 `unschedulable` 并发出 `TASK_UNSCHEDULABLE`，而不是无限空转。

主机级和实例级阻塞（`HOST_PRESSURE`、`CGROUP_UNAVAILABLE`、`GRANT_PENDING`、`GRANT_FAILED`）会终止扫描，而不是逐个惩罚任务 —— 原因不在任务身上。

---

## 8. 跨调度器中继（联邦）

任务在本地无法服务时，可以被**向下**推送给直接子调度器。它从不被复制：父调度器保留该行作为镜像（[`relay.ts`](../scheduler/src/core/relay.ts)）。

本地资格判定：

- 静态：存在在线 Builder 满足 `capability_score ≥ D`；
- 动态：存在在线 Builder 满足 `max(capability_dispatch, capability_live) ≥ D`。

中继选择（[`relay.ts:150`](../scheduler/src/core/relay.ts#L150)）：

1. 只考虑快照新鲜、Builder 数 > 0、且 `max_builder_ceiling ≥ D` 的直接子节点。
2. 优先同模式子节点；跨模式资格一律使用上限值，绝不用实时值。
3. 准入友好的压力状态（`NORMAL`、`BUSY`、`RECOVERING`）排前。
4. `D > 0` 时优先**刚好够用**的子节点 —— 不为琐碎任务占用巨型节点。
5. `D = 0` 时优先最空闲的子节点。
6. 平局按 `node_id`。最大中继深度为 8。

`ΣW` 向上聚合：节点上报本地 Builder 与其子节点子树分数之和，因此根节点无需轮询每个 Builder 就能掌握整个联邦的容量。过期子节点会被立即排除（[`repo/federation.ts:5`](../scheduler/src/repo/federation.ts#L5)）。

---

## 9. 算例

一台 8 GiB / 8 核主机运行五个 6 GiB / 6 核 Builder，4.0 GHz，64 GiB 磁盘，`model = 8`，`api = 8`：

```
W_static = 1000 × (0.15×1 + 0.10×0.25 + 0.15×0.8 + 0.10×0.8) = 375
W_res    = 1000 × (0.30×6/8 + 0.20×6/32)                    = 262.5 → 263
W0       = 638
```

| 池用量 | `H_res` | `W_live`（resource 作用域） |
|---|---|---|
| 全部空闲（5%） | 0.95 | 625 |
| 一个 Builder 忙在 3 GiB / 3 核（50%） | 0.50 | 507 |
| 两个 Builder 接近满载（95%） | 0.10 | 401 |
| 完全饱和 | 0.05 | 388 |
| 已承诺授予，但用量仍低 | 0.95 | 625 |

最后一行是关键性质：承诺会降低准入预算，但在工作真正占用内存之前，不会降低能力分数。

注水，`C_mem = 6 GiB`，两个实例，均 `cap = 4 GiB`、`weight = 0.5`：

| 步骤 | A | B | 池 |
|---|---|---|---|
| 初始需求 | 3 GiB | 1 GiB | 用 4 GiB，空闲 2 GiB |
| A 需求升至 5 GiB | 4 GiB（达 cap） | 1 GiB | 用 5 GiB，空闲 1 GiB |
| B 需求升至 4 GiB | 3 GiB（公平份额） | 3 GiB（公平份额） | 6 GiB，已满 |

若此刻 A 已承诺超过 3 GiB，它变为 `OVERCOMMITTED`：继续运行，但停止接收新工作。

---

## 10. 确定性与不变量

1. 所有容量与授予都是整数：毫核与字节。
2. 每个排序都以稳定键（`task_id`、`instance_id`、`node_id`）收尾。
3. `Σ grant ≤ C` 与 `grant_i ≤ min(demand_i, cap_i)` 由算法结构保证，而不是事后补丁。
4. 每次授予变化都递增代数并通过 outbox 发出 `INSTANCE_GRANT_UPDATED`；主机会拒绝更旧的代数。
5. 授予被压到已承诺预留以下时发出 `INSTANCE_OVERCOMMITTED`。
6. 领取、释放、压力变化都会触发重算，账本从不等待一个"稍后"的轮次。
7. 本文档中没有任何一环依赖墙上时钟随机性或 LLM 输出。

---

## 11. 配置

| 字段 | 默认值 | 是否生效 |
|---|---|---|
| 四舍五入 / 权重 / 上限 | 见 §2.1 | ✅ |
| `h_min` | 0.05 | ✅ |
| `w_floor` | 25 | ✅（仅 `whole` 作用域） |
| `w_degrade_scope` | `resource` | ✅ |
| `idle_floor_cpu_millicores` | 50 | ✅ |
| `idle_floor_mem_bytes` | 128 MiB | ✅ |
| `ewma_alpha` | 0.3 | ✅ |
| `dispatch_window_seconds` | 15 | ✅ |
| `pressure_enter` / `pressure_exit` | 0.70/0.85/0.95 · 0.60/0.75/0.90 | ✅ |
| `require_applied_before_start` | true | ✅ |
| `task_type_instance_limit` | 4 | ✅ |
| `backoff_base_seconds` / `backoff_max_seconds` | 1 / 60 | ✅ |
| `max_blocked_attempts` | 8 | ✅ |
| `max_candidate_scan` | 20 | ✅ |
| `max_instances_per_host` | 64 | ⏳ 预留 |
| `cpu_single_overcommit` | 4 | ⏳ 预留 |
| `overcommit_warn` | 2.0 | ⏳ 预留 |
| `recovery_hold_seconds` | 60 | ⏳ 预留 |
| `reclaim_cooldown_seconds` / `reclaim_check_window_seconds` / `reclaim_max_steps` | 3 / 5 / 3 | ⏳ 预留 |

⏳ = 已被解析、归一化并在 API 中暴露，但分配器尚未使用。它们是下一轮的调参点；文档如实标注，而不是假装已生效。

---

## 12. 实现索引

| 关注点 | 文件 |
|---|---|
| W 公式、拆分、实时/保证分数 | [`scheduler/src/capability.ts`](../scheduler/src/capability.ts) |
| H_res、需求、注水、`k(i, τ)`、退避、压力迁移 | [`scheduler/src/core/resources.ts`](../scheduler/src/core/resources.ts) |
| 授予账本、压力状态、W_live 持久化 | [`scheduler/src/repo/resources.ts`](../scheduler/src/repo/resources.ts) |
| 领取事务与准入顺序 | [`scheduler/src/core/claim.ts`](../scheduler/src/core/claim.ts) |
| 中继路由与 `ΣW` | [`scheduler/src/core/relay.ts`](../scheduler/src/core/relay.ts)、[`repo/federation.ts`](../scheduler/src/repo/federation.ts) |
| cgroup 布局、授予应用、池上报 | [`host-runtime/src/cgroup.ts`](../host-runtime/src/cgroup.ts) |
| 部署期检查与模式继承 | [`pcs-issuer/src/service.ts`](../pcs-issuer/src/service.ts) |
| 动态调度 schema | [`scheduler/sql/008_dynamic_scheduling.sql`](../scheduler/sql/008_dynamic_scheduling.sql) |
