# Scheduler Specification

> English · [简体中文](scheduler.zh-CN.md)

> Version: v4.3 · 2026-11-12
> The scheduler is the single source of truth for state. It does only four things: accept tasks, queue them, dispatch them, and keep accounts.
> Allocation and scheduling math (`W`, water filling, concurrency, pressure) is specified in [scheduling-algorithm.md](scheduling-algorithm.md).

---

## 1. Responsibilities

Does:

- Accept tasks (admin app / CLI / external systems).
- Maintain task state and events.
- Dispatch tasks to builders by deterministic rules.
- Maintain instances, leases, fencing tokens, and resource reservations.
- Provide the management API: builder create/start/stop/query, queue stats, event stream.
- Write audit logs.

Does not:

- Does not compile, execute commands, or hold builder SSH private keys.
- The scheduling core does not parse Agent implementation details; the scheduling Agent runs independently under host-runtime inside the container.
- No approvals, no manual gates.
- No multi-tenancy or role permissions.

---

## 2. Task Types (v4)

| `task_type` | Target role | Description |
|---|---|---|
| `task.build` | `builder` | Build/compile/script/test and similar tasks; the admin side sends only a natural-language description, executed by the Agent |
| `task.chat.builder` | `builder` | Chat with the builder robot |
| `task.console.builder` | `builder` | Builder container shell (SSH-equivalent, full permissions) |
| `task.chat.scheduler` | `scheduler` | Chat with the scheduler Agent: explain queues, leases, and dispatch results |
| `task.console.scheduler` | `scheduler` | Scheduler container shell |

> There are no longer `task.review.*`, `task.commit`, `task.test.*`, or `task.ticket.*`.

### 2.1 Scheduler Agent

The scheduler can also bind an Agent Profile with the `scheduler` role (for example, a DeepSeek scheduling assistant).
Its job is **explanation and Q&A**: why a task is waiting, who it will be dispatched to next round, which builder is idlest.

The boundaries are unchanged:

- Queues, priority, leases, and fencing are all decided by deterministic code; the Agent does not participate in dispatch.
- The Agent cannot change priority, jump the queue, or bypass resource reservations.
- When no Agent exists it degrades to deterministic replies, with the same API and task types.

---

## 3. Scheduling Rules

### 3.1 Eligibility Filtering

A task can be claimed by a builder if and only if:

- The task has `state = QUEUED` and `target_role = builder`.
- The builder has `state = ONLINE`.
- The task's `task_type` is within the builder's `allowed_task_types`.
- The OS/capabilities the task requires are a subset of the builder's capabilities: `requirements.os` is empty or equals the builder's `BUILDER_OS`.
- `requirements.target_instance_id` is empty or equals that instance.
- The task is excluded until `next_attempt_at` is reached.

### 3.2 Ordering (Deterministic)

```
effective_priority = priority_class - floor(wait_seconds / aging_after_seconds)
ORDER BY effective_priority ASC, enqueued_at ASC, task_id ASC
```

- `priority_class`: 0 is highest, 3 is lowest; default 2.
- Aging prevents low-priority starvation.
- No LLM, no randomness.

### 3.3 Concurrency Limits

Takes the minimum of:

- Global `global_limit` (default 8).
- Per-builder `instance_limit` (default 2).
- Per-task-type `task_type_limit` (default 4).

### 3.4 Claim Transaction

`claim` completes within a single transaction: instance row lock → host resource row lock → eligibility filtering → admission → create attempt/lease/reservation → set the task to `ASSIGNED`. If any step fails, no task is returned.

---

## 4. State Machines

### 4.1 Tasks

```
QUEUED ──claim──▶ ASSIGNED ──start-ack──▶ RUNNING ──result──▶ SUCCEEDED
   │                  │                      │
   │                  │                      ├──▶ FAILED ──retry──▶ QUEUED
   │                  │                      └──▶ BLOCKED
   └──cancel────────────────────────────────▶ CANCELLED
```

### 4.2 Instances

```
STARTING → ONLINE ⇄ SUSPECT → OFFLINE
              └── DRAINING ──┘
```

### 4.3 Leases

- Default 300s; builders renew every 60s.
- If not renewed before expiry → reclaim the attempt and requeue the task.
- Each attempt generates an incrementing `fencing_token`; result reports must carry the current token, and old tokens are always rejected.

---

## 5. Retries and Dead Letters

| Configuration | Default | Description |
|---|---|---|
| `max_attempts` | 3 | Maximum number of attempts for a retryable failure |
| `retry_backoff` | Exponential backoff 5s / 15s / 45s | No more than 5 minutes |
| `deadline_at` | None | Timed-out tasks are set to FAILED |
| `BLOCKED` | When the limit is reached | Wait for manual resubmission or reset |

---

## 6. Workflows (Simplified)

v4 keeps only one built-in workflow:

```
wft_build = [ EXECUTE(task.build) ]
```

- One task = one build; there are no more REVIEW / APPROVE / COMMIT / VERIFY stages.
- When multiple steps are needed, the Agent completes them within one task, or you submit several tasks in a row.
- `requirements.build.command` remains a low-level capability (scripts, smoke tests); the admin side submits `requirements.build.instruction`, and a builder without an Agent refuses to execute.
- The `workflow_runs` table is kept for compatibility with v3 data and future extension; v4 exposes no workflow configuration page.

---

## 7. API (Minimal Set)

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/tasks` | Submit a task |
| `GET` | `/v1/tasks` | Task list |
| `GET` | `/v1/tasks/:id` | Task details (including attempts/events) |
| `POST` | `/v1/tasks/:id/cancel` | Cancel |
| `GET` | `/v1/queue/stats` | Queue stats |
| `POST` | `/v1/instances/register` | Builder registration |
| `POST` | `/v1/instances/:id/heartbeat` | Heartbeat |
| `POST` | `/v1/claim` | Claim a task |
| `POST` | `/v1/tasks/:id/start-ack` | Acknowledge start |
| `POST` | `/v1/tasks/:id/progress` | Progress |
| `POST` | `/v1/tasks/:id/result` | Result |
| `GET` | `/v1/instances` | Instance list |
| `POST` | `/v1/builders` | Create a builder (container) |
| `POST` | `/v1/builders/:id/:action` | start/stop/restart/remove |
| `GET` | `/v1/events/stream` | SSE event stream |

Authentication: instances use a Bearer token; the admin app uses an optional admin token. v4 no longer distinguishes viewer/operator/approver.

---

## 8. Database Tables

| Table | Purpose |
|---|---|
| `tasks` | Task main table |
| `task_attempts` | Each claim |
| `task_events` | State events |
| `role_instances` | Builder/scheduler instances |
| `leases` | Leases and fencing |
| `resource_reservations` | Resource reservations |
| `resource_profiles` | Resource profiles |
| `task_definitions` | Task type → target role |
| `audit_logs` | Audit |
| `approval_*` | **Retained but no longer written** (v3 migration compatibility) |

---

## 9. Deployment Form

For the single-machine Compose setup see [deploy/compose.yaml](../deploy/compose.yaml); control plane deployments are planned by PCS, and host-runtime launches official ubuntu containers and writes the `/opt/platform/app/` payload.

```yaml
scheduler:
  image: ubuntu:24.04@sha256:<digest>
  ports: ["8443:8443"]
  environment:
    DATABASE_URL: postgres://platform:***@postgres:5432/scheduler
    PCS_PUBLIC_KEY_FILE: /opt/platform/keys/pcs-public.pem
    SCHEDULER_AUTH_TOKEN: ""          # local-dev fallback only when no PCS public key is configured
  depends_on: [postgres]
```

- A single instance is enough; no HA.
- Recovers from PostgreSQL after a restart.
- Migration script: `npm run migrate`, seed: `npm run seed`.

---

## 10. Acceptance Checklist

- [ ] There are only two roles, `scheduler` and `builder`.
- [ ] A task is traceable end to end from QUEUED to SUCCEEDED.
- [ ] After a builder crashes, the task is requeued once its lease expires.
- [ ] Results carrying an old fencing token are rejected.
- [ ] The admin app can perform all operations without switching roles.
- [ ] Builder SSH can be connected directly, without going through the scheduler.
- [ ] Task events and audits are queryable.
