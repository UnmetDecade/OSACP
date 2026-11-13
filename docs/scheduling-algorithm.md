# Scheduling Algorithm

> English · [简体中文](scheduling-algorithm.zh-CN.md)

> Version: v0.3 · 2026-11-13
> Scope: the math and rules that decide **which builder runs which task, with how much CPU and memory**.
> Code: [`scheduler/src/core/resources.ts`](../scheduler/src/core/resources.ts), [`capability.ts`](../scheduler/src/capability.ts), [`claim.ts`](../scheduler/src/core/claim.ts), [`repo/resources.ts`](../scheduler/src/repo/resources.ts), [`host-runtime/src/cgroup.ts`](../host-runtime/src/cgroup.ts), [`pcs-issuer/src/service.ts`](../pcs-issuer/src/service.ts).

The scheduling core is deliberately unglamorous: **no LLM, no randomness, no floating point in the hot path**. Every decision is reproducible from rows in PostgreSQL, and every allocation carries a generation that a host can verify.

---

## 0. Two modes, one contract

| | Static | Dynamic |
|---|---|---|
| Capacity model | Fixed budget per deployment | Host resource pool + per-instance cgroup quotas |
| Admission | Deploy-time memory budget; runtime memory reservations | Fair-share grants recomputed every few seconds |
| Concurrency | Fixed `instance_limit` per builder | `k(i, τ)` derived from the remaining grant, per task type |
| Capability `W` | Frozen at deploy time | Live: `W_static + H_res × W_res`, with a percentile-smoothed dispatch value |
| Overcommit | Off | Explicitly allowed; enforced by cgroups |

Both modes share the same queue, lease, fencing, relay and state-machine code. The mode is chosen once on the **root scheduler** of a host and inherited by its node schedulers and builders ([`service.ts:3052`](../pcs-issuer/src/service.ts#L3052)).

Hard rules that hold in both modes:

1. Capability scoring never replaces resource admission, and resource grants never replace Agent/tool matching.
2. One authoritative scheduler per host pool. Node schedulers do not compute local quotas.
3. Host safety is enforced by cgroups, not by the goodwill of containers.
4. Every formula is deterministic and auditable; ties are broken by stable IDs.
5. No task is ever killed to reclaim memory. Squeezing a grant throttles; it never restarts work.

---

## 1. Notation

| Symbol | Meaning |
|---|---|
| `W` | Builder capability score, 0–1000 |
| `D` | Task difficulty, 0–1000; `0` means unrestricted |
| `W_static` | Load-independent part of W: frequency, disk, model, API (max 500) |
| `W_res` | Load-dependent part of W: CPU cores, memory (max 500) |
| `W0` | Nominal ceiling `W_static + W_res(cap)` |
| `W_live(t)` | Live capability `W_static + H_res(t) × W_res(cap)` |
| `W_dispatch` | Conservative value for dispatch: 25th percentile of recent `W_live` |
| `C_cpu`, `C_mem` | Pool capacity: the hard limit of the parent cgroup |
| `cap_i` | Instance `i`'s deployment cap (millicores / bytes) |
| `request_i(τ)` | Resource requirement of one task of type `τ` |
| `reserved_i` | Resources committed by active leases on `i` |
| `grant_i(t)` | Fair-share quota currently granted to `i` |
| `usage_i(t)` | Actual usage (working set / CPU cores) |
| `k(i, τ)` | Concurrent tasks of type `τ` instance `i` may still take |
| `H_res` | Resource-contention coefficient, applied only to `W_res` |
| `PSI` | Pressure Stall Information |

---

## 2. Capability score `W`

### 2.1 Static formula

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

| Component | Weight | Normalization cap |
|---|---|---|
| CPU cores | 30% | 8 |
| Core frequency | 15% | 4.0 GHz |
| Memory | 20% | 32 GiB |
| Disk | 10% | 256 GiB |
| Model capability | 15% | 10 |
| API capability | 10% | 10 |

Caps represent a fully loaded current-generation single machine. Anything above a cap scores full marks, so one oversized host cannot flatten the scale. In static mode `W` is computed once at deployment, frozen, and injected into the builder container ([`capability.ts:45`](../scheduler/src/capability.ts#L45)).

### 2.2 Dynamic split

```
R_freq  = min(freq_ghz / 4,   1)
R_disk  = min(disk_gb  / 256, 1)
R_model = min(model    / 10,  1)
R_api   = min(api      / 10,  1)
R_cpu(c) = min(c / 8,  1)
R_mem(m) = min(m / 32, 1)

W_static    = 1000 × (0.15·R_freq + 0.10·R_disk + 0.15·R_model + 0.10·R_api)   ∈ [0, 500]
W_res(c, m) = 1000 × (0.30·R_cpu(c) + 0.20·R_mem(m))                            ∈ [0, 500]

W0_i        = W_static + W_res(cap_i)                     -- ceiling
W_live_i(t) = W_static + H_res(t) × W_res(cap_i)          -- live
W_dispatch_i(t) = percentile_25({ W_live_i(τ) : τ ∈ last 15 s })
```

Only the CPU/memory half degrades with contention. Frequency, disk, model and API stay constant, so a busy host still advertises the capabilities that do not depend on free memory.

`percentile_25` is nearest-rank over an in-process sliding window ([`repo/resources.ts:329`](../scheduler/src/repo/resources.ts#L329)). Losing the window on restart makes the first recomputation slightly less conservative; it never affects grant correctness.

`w_degrade_scope = whole` is available for setups that want the entire score to fall with contention:

```
W_live = max(w_floor, round(W0 × H_res))
```

### 2.3 `H_res`: actual usage only

```
U_mem = clamp(EWMA_α(working_set(pool)) / C_mem, 0, 1)
U_cpu = clamp(EWMA_α(cpu_usage_cores(pool)) / C_cpu, 0, 1)
H_res = clamp(1 − max(U_mem, U_cpu), h_min, 1)
```

- `working_set = memory.current − memory.stat.inactive_file`, sampled per cgroup in [`cgroup.ts:138`](../host-runtime/src/cgroup.ts#L138);
- `cpu_usage_cores = Δcpu.stat.usage_usec / Δt / 1e6`;
- pool-level usage is smoothed on ingestion with `α = 0.3` ([`repo/hosts.ts:62`](../scheduler/src/repo/hosts.ts#L62));
- `h_min = 0.05`, so `W_live` never reaches zero;
- **committed but unused grants are not counted**. A task that has been admitted but has not touched memory does not lower `W`; the commitment shows up in admission budgets instead.

### 2.4 Which score is used where

| Field | Static | Dynamic | Used for |
|---|---|---|---|
| `capability_ceiling` | frozen `W` | `W0` | Cross-node eligibility (`max_builder_ceiling ≥ D`), cross-mode relay ordering |
| `capability_live` | frozen `W` | `W_live` (instantaneous) | Same-mode relay ordering |
| `capability_dispatch` | frozen `W` | `W_dispatch` (P25, 15 s) | Local claim eligibility and the difficulty filter (`D ≤ dispatch`, falling back to `live` then frozen `W`) |
| `capability_guaranteed` | frozen `W` | `W_static + W_res(equal-share)` | Capacity planning and UI only |

Local eligibility also accepts `max(dispatch, live) ≥ D`, so a builder that just got faster is not rejected for one window. Cross-node eligibility never uses the live score, because a remote snapshot may already be stale.

Any two scores are comparable only when their `capability_schema_version` matches. The implementation uses version `1` ([`repo/resources.ts:496`](../scheduler/src/repo/resources.ts#L496)).

---

## 3. Static mode

### 3.1 Deploy-time admission (PCS)

Before a deployment plan is accepted, PCS runs a fixed checklist ([`service.ts:3201`](../pcs-issuer/src/service.ts#L3201)):

| Check | Rule |
|---|---|
| `host_online` | Host is `ONLINE` or `DEGRADED` |
| `image_pinned` | Image reference ends in `@sha256:<64 hex>` |
| `network_policy` | Policy is in the configured allowlist |
| `agent_binding` | Bound Agent profile matches the role |
| `api_bindings` | Every bound API profile is enabled |
| `scheduler_url` | Builders have a scheduler to register with |
| `memory_budget` | `memory_limit_bytes × count ≤ host.mem_available_bytes` |

A failure returns `409 DEPLOYMENT_CHECK_FAILED` with the full check list.

### 3.2 Claim admission (scheduler)

Inside one transaction, after locking the host and instance rows ([`claim.ts:117`](../scheduler/src/core/claim.ts#L117)):

1. Instance `ONLINE` and bound to an Agent profile.
2. Host state is `NORMAL` or `WARNING`.
3. Active leases on the instance `< instance_limit`.
4. Global leases `< global_limit`; leases in the role pool `< role_pool_limit`.
5. For each candidate: task type limit, capability subset, payload schema, target instance, `D ≤ W` (skipped when `W = 0`, i.e. pre-upgrade builders).
6. Static memory budget:

```
Σ memory_bytes(reservations in HELD|ACTIVE on this host) + request_mem
    ≤ host.mem_available_bytes
```

CPU reservations are recorded but do not gate admission in static mode. This is a known limitation, documented rather than hidden.

### 3.3 Ordering and aging

```
effective_priority = priority_class - floor(waited_seconds / aging_after_seconds)   (P0 never ages)
ORDER BY effective_priority ASC, enqueued_at ASC, task_id ASC
```

Lower numbers run first. Aging lifts starved low-priority tasks one class per `aging_after_seconds` (default 600 s), capped at P1 ([`001_init.sql:23`](../scheduler/sql/001_init.sql#L23)). Every ordering has a stable final key, so equal-priority tasks cannot be reordered by chance.

### 3.4 Concurrency defaults

| Limit | Default |
|---|---|
| `global_limit` | 100 |
| `role_pool_limit` | 20 |
| `instance_limit` | 1 |
| `task_type_limit` | 10 |
| `aging_after_seconds` | 600 |

---

## 4. Dynamic mode

### 4.1 Resource pool

Each host exposes one cgroup v2 tree ([`cgroup.ts:1`](../host-runtime/src/cgroup.ts#L1)):

```
<base>/osacp.slice/
  platform.slice/          host-runtime, scheduler helpers; memory.min protects them
  pool.slice/              every builder; its memory.max / cpu.max is C
    builder-<id>.scope/    one per builder
```

Pool capacity `C_cpu` / `C_mem` is what the host reports; the scheduler treats it as a hard ceiling. If a host does not expose cgroup v2, dynamic scheduling still does the accounting but cannot enforce quotas, and the scheduler records `CGROUP_UNAVAILABLE` instead of pretending ([`claim.ts:369`](../scheduler/src/core/claim.ts#L369)).

### 4.2 Demand

For instance `i`:

```
used_mem_i = working_set_i          (from the instance's cgroup, reported every few seconds)
used_cpu_i = cpu_usage_cores_i

demand_mem_i = min(cap_mem_i, max(reserved_mem_i, used_mem_i, idle_floor_mem))
demand_cpu_i = min(cap_cpu_i, max(reserved_cpu_i, used_cpu_i, idle_floor_cpu))
```

`max` is essential: `reserved` alone under-counts instances that exceed their reservation; `used` alone ignores tasks that were admitted but have not started. `idle_floor` is 128 MiB / 50 mCPU by default and is itself capped by `cap_i` ([`resources.ts:157`](../scheduler/src/core/resources.ts#L157)).

### 4.3 Weights and fair share

```
weight_cpu_i = cap_cpu_i / Σ cap_cpu      (per-mille integer, minimum 1)
weight_mem_i = cap_mem_i / Σ cap_mem

F_i = C × weight_i / Σ_{j ∈ active} weight_j
```

Two instances declared with the same profile get the same weight. Idle instances hold only their floor; the rest of their share is borrowable.

### 4.4 Weighted max-min water filling

The allocator is integer-only so repeated recomputation cannot drift ([`resources.ts:207`](../scheduler/src/core/resources.ts#L207)):

```
1. g_i = min(demand_i, cap_i, floor_i)                 -- floor is the idle floor
2. remaining = C − Σ g_i
3. while remaining > 0 and some g_i < min(demand_i, cap_i):
     W = Σ weight_i over the active set
     for each active i:
       room = min(demand_i, cap_i) − g_i
       add  = min(room, ⌊remaining × weight_i / W⌋, remaining − added_this_round)
       g_i += add;  added_this_round += add
     remaining −= added_this_round
4. integer remainder: one millicore/byte at a time in instance_id order (at most len(items) + 4 rounds)
```

Properties:

- `Σ g_i ≤ C` and `g_i ≤ min(demand_i, cap_i)` always hold;
- unused capacity is not forced out: if total demand is below `C`, the pool stays partly idle;
- identical inputs produce identical outputs; ties resolve by ascending `instance_id`;
- CPU and memory are filled independently, so an instance can be CPU-rich and memory-poor.

Borrowing semantics from the same rule set: an idle instance contributes everything above its floor; when its demand rises, water filling restores it and compresses borrowers. A borrower is marked `OVERCOMMITTED` when its grant falls below what it has already committed; it stops taking new work until the ledger catches up ([`claim.ts:429`](../scheduler/src/core/claim.ts#L429)).

### 4.5 Grant → cgroup mapping

| Grant value | cgroup v2 file |
|---|---|
| `grant_mem` | `memory.low` |
| `grant_cpu` | `cpu.weight = max(1, round(10000 × grant_cpu / C_cpu))` |
| `cap_mem` | `memory.max` |
| `cap_cpu` | `cpu.max = cap_cpu × period / 1000` |
| pressure threshold | `memory.high` |

`memory.high` is where the mode difference becomes visible:

| Pressure state | `memory.high` |
|---|---|
| `NORMAL`, `BUSY` | `cap_mem` (throttle only at the cap) |
| `PRESSURE` | `max(16 MiB, min(cap, 1.1 × grant_mem))` |
| `CRITICAL` | `max(16 MiB, min(cap, 1.0 × grant_mem))` |

Under pressure, an instance is throttled just above its fair share; in normal operation it may borrow up to its cap. `memory.low` is the protected grant, so a well-behaved instance is not reclaimed because a neighbour is greedy. Host-runtime writes every value and reads it back; nothing is assumed ([`cgroup.ts:271`](../host-runtime/src/cgroup.ts#L271)).

### 4.6 Grant lifecycle

```
PENDING ──apply──▶ APPLIED
   │
   ├──▶ FAILED        (cgroup write rejected / pool unavailable)
   └──▶ SUPERSEDED    (a newer generation exists)
```

- Every change allocates a monotonically increasing `generation`; unchanged allocations keep their state and do not churn generations ([`repo/resources.ts:404`](../scheduler/src/repo/resources.ts#L404)).
- Recomputation runs every `GRANT_UPDATE_INTERVAL_MS` (5 s) and immediately after each claim, so a fresh reservation never waits for the periodic tick.
- With `require_applied_before_start = true` (default), a dynamic builder may start a task only after `grant.state === APPLIED` and `applied_generation ≥ generation`. Running without an enforced cap is refused, not silently allowed ([`claim.ts:408`](../scheduler/src/core/claim.ts#L408)).

---

## 5. Concurrency `k(i, τ)`

```
remaining_cpu_i = max(0, budget_cpu_i − reserved_cpu_i)
remaining_mem_i = max(0, budget_mem_i − reserved_mem_i)
budget_*        = min(cap_*, max(grant_*, F_*))

k(i, τ) = min( floor(remaining_cpu_i / request_cpu(τ)),
               floor(remaining_mem_i / request_mem(τ)) )
```

Admission requires `k(i, τ) ≥ 1` **and** `active_leases_of_type(τ) < task_type_instance_limit`.

- `k` may be 0, in which case the instance cannot take that type at all;
- all types share the same `remaining_*`, but each type gets its own `k`;
- the per-instance-per-type cap is `task_type_instance_limit` (default 4), checked against both the computed `k` and the count of active leases of that type;
- the calculation happens under the instance row lock, in the same transaction that writes the reservation ([`claim.ts:494`](../scheduler/src/core/claim.ts#L494)).

Building a task's budget from `max(grant, F_i)` is what lets an idle builder accept work at its guaranteed share before the allocator has grown its grant.

---

## 6. Pressure state machine

Utilization `U = max(memory, cpu)` over the pool, with separate enter and exit thresholds to prevent flapping ([`resources.ts:382`](../scheduler/src/core/resources.ts#L382)):

| From | To | Condition |
|---|---|---|
| `NORMAL` | `BUSY` | `U ≥ 0.70` |
| `BUSY` | `NORMAL` | `U ≤ 0.60` |
| `NORMAL`, `BUSY`, `RECOVERING` | `PRESSURE` | `U ≥ 0.85` |
| `PRESSURE` | `RECOVERING` | `U ≤ 0.75` |
| any state | `CRITICAL` | `U ≥ 0.95` |
| `CRITICAL` | `RECOVERING` | `U ≤ 0.90` |
| `RECOVERING` | `NORMAL` | `U ≤ 0.60` |

Admission rules by state ([`resources.ts:412`](../scheduler/src/core/resources.ts#L412)):

| State | New claims |
|---|---|
| `NORMAL` | Allowed |
| `BUSY` | Allowed, but grants are tighter because `H_res` is lower |
| `PRESSURE` | Denied (`HOST_PRESSURE`, halts the scan) |
| `CRITICAL` | Denied; `memory.high` is squeezed to the grant |
| `RECOVERING` | Allowed; the pool must fall back to `NORMAL` thresholds before leaving |

The thresholds are policy data (`dynamic_policy.pressure_enter` / `pressure_exit`), not hard-coded constants; the defaults above are calibration points, not universal truth.

---

## 7. Queue discipline, blocking and backoff

A naive `LIMIT 1` candidate query makes one unschedulable task block the whole queue. The implementation fixes this with four mechanisms ([`claim.ts:206`](../scheduler/src/core/claim.ts#L206)):

1. **Candidate scan**: up to `max_candidate_scan` (20) ordered candidates are considered per claim; a blocked candidate is recorded and the scan continues.
2. **Durable block state**: a blocked task gets `resource_block_reason`, `blocked_attempts`, `resource_retry_after` and a `TASK_RESOURCE_BLOCKED` event.
3. **Exponential backoff**: attempt `n` retries after `min(backoff_max, base × 2^n)` seconds — 1, 2, 4, 8 … capped at 60 s by default ([`resources.ts:371`](../scheduler/src/core/resources.ts#L371)).
4. **Permanent unschedulability**: a task whose request can never fit (larger than the host's total budget) is marked `unschedulable` after `max_blocked_attempts` (8), with `TASK_UNSCHEDULABLE`, instead of churning forever.

Host-wide and instance-wide blocks (`HOST_PRESSURE`, `CGROUP_UNAVAILABLE`, `GRANT_PENDING`, `GRANT_FAILED`) halt the scan rather than penalising each task in turn — the cause is not the task's fault.

---

## 8. Cross-scheduler routing (federation)

When a task cannot be served locally, it may be pushed **down** to a direct child scheduler. It is never copied; the parent keeps the row as a mirror ([`relay.ts`](../scheduler/src/core/relay.ts)).

Local eligibility check:

- Static: an online builder with `capability_score ≥ D`;
- Dynamic: an online builder with `max(capability_dispatch, capability_live) ≥ D`.

Relay selection ([`relay.ts:150`](../scheduler/src/core/relay.ts#L150)):

1. Only direct children with a fresh snapshot, builders > 0, and `max_builder_ceiling ≥ D` are considered.
2. Same-mode children are preferred; cross-mode eligibility always uses the ceiling, never the live score.
3. Admission-friendly pressure states (`NORMAL`, `BUSY`, `RECOVERING`) rank first.
4. If `D > 0`, prefer the **smallest sufficient** child — do not consume a monster node for a trivial task.
5. If `D = 0`, prefer the idlest child.
6. Ties by `node_id`. Maximum relay depth is 8.

`ΣW` aggregates upward: a node reports the sum of its local builders and its children's subtree scores, so a root sees the whole federation's capacity without polling each builder. Stale children are excluded immediately ([`repo/federation.ts:5`](../scheduler/src/repo/federation.ts#L5)).

---

## 9. Worked example

An 8 GiB / 8-core host runs five 6 GiB / 6-core builders, 4.0 GHz, 64 GiB disk, `model = 8`, `api = 8`:

```
W_static = 1000 × (0.15×1 + 0.10×0.25 + 0.15×0.8 + 0.10×0.8) = 375
W_res    = 1000 × (0.30×6/8 + 0.20×6/32)                    = 262.5 → 263
W0       = 638
```

| Pool usage | `H_res` | `W_live` (resource scope) |
|---|---|---|
| All idle (5%) | 0.95 | 625 |
| One builder busy at 3 GiB / 3 cores (50%) | 0.50 | 507 |
| Two builders near full (95%) | 0.10 | 401 |
| Fully saturated | 0.05 | 388 |
| Grants committed, usage still low | 0.95 | 625 |

The last row is the key property: commitments lower admission budgets, but they do not lower the capability score before work actually uses memory.

Water filling with `C_mem = 6 GiB`, two instances, both `cap = 4 GiB`, `weight = 0.5`:

| Step | A | B | Pool |
|---|---|---|---|
| Initial demand | 3 GiB | 1 GiB | 4 GiB used, 2 GiB idle |
| A's demand rises to 5 GiB | 4 GiB (cap) | 1 GiB | 5 GiB used, 1 GiB idle |
| B's demand rises to 4 GiB | 3 GiB (fair share) | 3 GiB (fair share) | 6 GiB, full |

If A had already committed more than 3 GiB at that point, it becomes `OVERCOMMITTED`, keeps running, and stops taking new work.

---

## 10. Determinism and invariants

1. All capacities and grants are integers: millicores and bytes.
2. Every ordering ends in a stable key (`task_id`, `instance_id`, `node_id`).
3. `Σ grant ≤ C` and `grant_i ≤ min(demand_i, cap_i)` are checked by the algorithm's structure, not by an afterthought.
4. Every grant change increments a generation and emits `INSTANCE_GRANT_UPDATED` on the outbox; hosts reject older generations.
5. `INSTANCE_OVERCOMMITTED` is emitted when a grant is squeezed below committed reservations.
6. Claims, releases and pressure changes all trigger recomputation, so the ledger never waits for a "later" pass.
7. Nothing in this document depends on wall-clock randomness or LLM output.

---

## 11. Configuration

| Field | Default | Enforced |
|---|---|---|
| `round` / weights / ceilings | see §2.1 | ✅ |
| `h_min` | 0.05 | ✅ |
| `w_floor` | 25 | ✅ (`whole` scope only) |
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
| `max_instances_per_host` | 64 | ⏳ reserved |
| `cpu_single_overcommit` | 4 | ⏳ reserved |
| `overcommit_warn` | 2.0 | ⏳ reserved |
| `recovery_hold_seconds` | 60 | ⏳ reserved |
| `reclaim_cooldown_seconds` / `reclaim_check_window_seconds` / `reclaim_max_steps` | 3 / 5 / 3 | ⏳ reserved |

⏳ = parsed, normalized and exposed in the API, but not yet used by the allocator. They are tuning points for the next iteration; the document says so instead of pretending.

---

## 12. Implementation map

| Concern | File |
|---|---|
| W formula, split, live/guaranteed scores | [`scheduler/src/capability.ts`](../scheduler/src/capability.ts) |
| H_res, demand, water filling, `k(i, τ)`, backoff, pressure transitions | [`scheduler/src/core/resources.ts`](../scheduler/src/core/resources.ts) |
| Grant ledger, pressure state, W_live persistence | [`scheduler/src/repo/resources.ts`](../scheduler/src/repo/resources.ts) |
| Claim transaction and admission order | [`scheduler/src/core/claim.ts`](../scheduler/src/core/claim.ts) |
| Relay routing and `ΣW` | [`scheduler/src/core/relay.ts`](../scheduler/src/core/relay.ts), [`repo/federation.ts`](../scheduler/src/repo/federation.ts) |
| cgroup layout, grant application, pool report | [`host-runtime/src/cgroup.ts`](../host-runtime/src/cgroup.ts) |
| Deploy-time checks and mode inheritance | [`pcs-issuer/src/service.ts`](../pcs-issuer/src/service.ts) |
| Dynamic-scheduling schema | [`scheduler/sql/008_dynamic_scheduling.sql`](../scheduler/sql/008_dynamic_scheduling.sql) |
