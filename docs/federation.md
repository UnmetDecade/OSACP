# Control Plane and Host Federation

> English · [简体中文](federation.zh-CN.md)

> Version: v4.3 · 2026-11-12
> This document describes the control plane (PCS), host onboarding, and the recursive scheduler topology; role division is covered in [Overall Architecture](architecture.md).

---

## 1. Roles and Topology

A host has exactly one role; `pcs_hosts.role_mode` is `containers` / `builder` / `scheduler`:

| `role_mode` | Meaning |
|---|---|
| `containers` (default) | The host only provides a container runtime environment and can run multiple builder and scheduler containers at once |
| `builder` | The entire host acts directly as a single builder |
| `scheduler` | The entire host acts directly as a single scheduler |

One rule is hard-coded: **the same host cannot be both a builder and a scheduler**. In container mode, each host has exactly one root scheduler, and any number of child schedulers can also run on the same host; builder containers are unlimited and belong to the scheduler chosen at deployment time. Every scheduler (root or child) has its own database, and PCS pushes the host roster to all schedulers on that host so that builders can register with a child scheduler.

```
Root scheduler (host A)
├── Leaf builder a-1 (owned by root)
├── Child scheduler a-node (host A)
│   └── Leaf builder a-2 (owned by a-node)
├── Child scheduler (host B, i.e. B's root as seen from A)
│   └── Leaf builder b-1
└── Leaf builder a-3
```

---

## 2. Host Merging

`pcs_hosts.parent_host_id` records the parent host. Rules:

- A host cannot merge into itself (`HOST_MERGE_SELF`).
- A host cannot merge into one of its own descendants, which would create a cycle (`HOST_MERGE_CYCLE`).
- Both hosts must already have a root scheduler; if the child has no root scheduler there is no child scheduler to report upward (`CHILD_SCHEDULER_MISSING`), and if the parent has no root scheduler there is nowhere to receive it (`PARENT_SCHEDULER_MISSING`).

Merging changes only one reference row and restarts no containers: from host A's perspective, host B's root scheduler is a child scheduler, while inside B it is still the root scheduler. PCS then calls `POST /v1/federation/parent` on B's root scheduler to set A's root scheduler address as its runtime parent; on separation it writes `null`. Schedulers read this runtime value during each reporting cycle, so merging/separating needs no redeployment.

`POST .../unmerge` clears `parent_host_id`, restoring independence; a parent ignores old children that miss several consecutive reports (90 seconds or more by default), and ΣW falls back automatically.

PCS API:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/platform/fleet` | The entire federation tree: each host's local W, subtree ΣW, builder count, and child hosts |
| `POST` | `/api/v1/platform/hosts/:id/merge` | Merge into a parent, body `{ parent_host_id }` |
| `POST` | `/api/v1/platform/hosts/:id/unmerge` | Separate from the parent |

---

## 3. Work Capability Score W

When creating a builder you provide six resources, normalized to 0–1000 by weight:

| Item | Weight | Cap |
|---|---:|---:|
| CPU cores | 30% | 8 |
| Core clock speed | 15% | 4 GHz |
| Memory | 20% | 32 GB |
| Storage | 10% | 256 GB |
| Model capability | 15% | 10 |
| API capability | 10% | 10 |

```
W = round(1000 × Σ(weight × min(value, cap) / cap))
```

- The formula lives in `pcs-issuer/src/capability.ts`, and the admin app renders the same preview in `admin-app/src/capability.ts`.
- Schedulers do not participate in W; their score is fixed at 0.
- Applying a deployment plan freezes W into the deployment row and injects it into the builder container:

| Environment variable | Value |
|---|---|
| `CAPABILITY_SCORE` | An integer from 0–1000 |
| `CAPABILITY_DETAIL` | JSON of the six raw resources, used by the UI to explain how W is composed |

At startup, a builder reports these two values to the scheduler along with its registration request; older instances that do not report W keep their previous behavior.

---

## 4. Task Difficulty D

A task may carry `difficulty` (0–1000, 0 = unlimited). The scheduler's claim condition:

```sql
($7 <= 0 OR t.difficulty <= $7)   -- $7 is this builder's capability_score
```

That is, a task with difficulty D is dispatched only to builders with W ≥ D. When a child scheduler reports upward it aggregates the subtree's W, so the root scheduler sees the available capability of the whole tree.

---

## 5. Node Reporting

Each child scheduler periodically sends the following to `SCHEDULER_PARENT_URL` at interval `SCHEDULER_FEDERATION_INTERVAL_MS`:

```
POST /v1/nodes/report
x-federation-token: <SCHEDULER_FEDERATION_TOKEN>
{ node_id, host_id, local_score, subtree_score, builder_count,
  max_builder_score, idle_builder_count, url, instances }
```

The parent stores only one row per direct child in `scheduler_nodes`; when computing totals it adds its own local W to each child's `subtree_score`, so grandchildren are never counted twice.

Capacity metrics (`builder_count` / `max_builder_score` / `idle_builder_count`) report values for the **entire subtree**: an intermediate node may itself have no builders, but the subtree contains a machine that can take difficulty D, and upper layers use this to decide which child to push the task to. `instances` likewise aggregates the subtree roster, used to determine which child scheduler a target instance is attached to. `url` is this scheduler's externally reachable address (`SCHEDULER_ADVERTISE_URL`); relay requests are sent directly to this address. Related environment variables:

| Variable | Purpose |
|---|---|
| `SCHEDULER_NODE_ID` | This scheduler's node id in the federation tree, default `<host_id>:root` |
| `SCHEDULER_HOST_ID` | The id of the host it belongs to, injected by PCS at deployment time |
| `SCHEDULER_PARENT_URL` | Initial value of the parent scheduler address; empty means this host is the root. After a host merge, PCS sets it at runtime through `/v1/federation/parent`, with no restart required |
| `SCHEDULER_FEDERATION_TOKEN` | Federation token: PCS injects it into both roots and child nodes. Roots use it to authenticate child reports, and children use it to report; if it is not configured, `/v1/nodes/report` returns 503 |
| `SCHEDULER_ADVERTISE_URL` | The address at which this scheduler is visible to the subtree; if empty, `url` is not reported and the parent will not relay tasks to it |
| `SCHEDULER_RELAY_SYNC_MS` | How often the parent pulls child task status, by default tied to the reclaim cycle |

Query endpoints: `GET /v1/capability` (local summary), `GET /v1/nodes` (direct subtree and report details).

---

## 6. Cross-Scheduler Relay

A task can be submitted to any scheduler; a scheduler executes only what it can handle:

1. **Task with a target instance**: if this scheduler's `role_instances` contains the instance, it stays local; otherwise it looks in the direct child's `instances` roster. A roster hit does not mean the child executes it itself—the child first checks locally and, if not found, goes one level down, so root → child → grandchild can be pushed down hop by hop.
2. **Task without a target instance** (such as a build task): if this scheduler has an online builder with W ≥ D, the task stays local; otherwise it picks a direct child by capacity: when difficulty D > 0, prefer the one whose capability just fits (`max_builder_score` ascending); when difficulty is unlimited, prefer the idler one (`idle_builder_count` descending).

Push-down semantics:

- **Push only, never copy.** The parent task stays in the parent scheduler's own database with state `QUEUED`, but there is an ACTIVE row in `task_relays`, so it is excluded from claim candidates and never runs on both sides.
- The child scheduler creates the task via `POST /v1/tasks`, with `relay: { parent_task_id, parent_node_id, depth }` in the body. Child tasks are deduplicated by the unique constraint on `tasks.relay_parent_task_id`, so duplicate deliveries do not create a second row.
- The parent periodically pulls the child task (`SCHEDULER_RELAY_SYNC_MS`) and mirrors state, summary, and output back onto the parent task; with multi-level relays the output is taken from the nested `child_result`, so the root node still receives the executor's stdout/stderr.
- Cancellation is forwarded downward: cancelling the parent task sends `POST /v1/tasks/:id/cancel` to the child, which forwards it further down.
- The depth limit is `MAX_RELAY_DEPTH = 8`; workflow subtasks are not relayed, because the state machine must stay in one database.
- If the whole subtree cannot handle a task, it stays queued on the original scheduler rather than vanishing; an unreachable child only accumulates `sync_failures` and is not executed twice.

The `relay` field in task details shows the push-down location and child result:

```json
{ "node_id": "hst_...:node-scheduler-a",
  "child_task_id": "task_xxx",
  "state": "DONE", "child_state": "SUCCEEDED",
  "child_result": { "summary": "...", "outputs": { "stdout": "..." } } }
```

The admin app queries task lists per scheduler deployment, so tasks on both roots and child nodes are visible; operations (cancel/retry/events) carry `scheduler_deployment_id` back to the scheduler where the task lives.

---

## 7. Current Implementation Boundaries

Implemented:

- PCS records host roles, the federation tree, and merges/separations; deployment validates role conflicts and cycles.
- Builder W computation, freezing, injection, and reporting; task D claim filtering.
- Child schedulers report subtree ΣW and capacity metrics to the parent; the root aggregates.
- Cross-scheduler relay: push down level by level by target instance or capacity, mirror state/output, forward cancellation downward, max depth 8.
- The admin app's host tree, ΣW, role switching, and task difficulty input and display; child schedulers can likewise add roles under their own cards.

Not yet implemented:

- **Bare-metal role execution**: `role_mode` is recorded and used for deployment conflict validation, but running a whole machine directly as a builder/scheduler (without a container) has no execution path yet.
