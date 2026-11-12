# Overall Architecture

> English · [简体中文](architecture.zh-CN.md)

> Version: v4.3 · 2026-11-12
> Positioning: small, single-team, built for R&D. Two roles: scheduler and builder; two levels of control plane: PCS and host-runtime.

---

## 1. Architecture Goals

| Goal | Approach |
|---|---|
| Runs on a single dev machine | Docker Compose brings up the scheduler + PostgreSQL + N builders |
| Hosts are extensible | The Hosts page manages local hosts and remote SSH hosts; containers are launched by host-runtime on the host |
| So few roles they need no explanation | Only `scheduler` and `builder` |
| Reproducible build environments | Builders use official Ubuntu 20.04 / 22.04 / 24.04 / 26.04 images pinned by digest |
| Troubleshooting isn't blocked by the platform | Builders ship with sshd, so you can `ssh root@host -p <port>` directly |
| No organizational model | No admins/reviewers/approvals/role permissions; full permissions by default |
| Keep the reliability that actually matters | Task state machine, leases, fencing, idempotency, auditing, failure retries |

**Non-goals**: multi-tenancy, cross-organization approval, production-grade HA, multiple clusters across the public internet, Kubernetes orchestration, a generic workflow engine.

---

## 2. The Two Roles

| `role_id` | Role | Responsibilities | Out of scope |
|---|---|---|---|
| `scheduler` | Scheduler | Receives tasks, queues, admission, dispatches, leases, is the source of truth for state, management API, auditing; can bind a scheduler Agent for explanations and Q&A | Does not run builds, compile code, hold builder SSH private keys, or let the Agent change dispatch rules |
| `builder` | Builder | Runs Agents, executes build/script/test commands, produces artifacts, offers full SSH | Does not change scheduler state or dispatch tasks |

> Testing, review, and after-sales support are all **ordinary build tasks**: users decide which commands to run inside the builder, and the platform no longer creates dedicated roles for them.

---

## 3. Deployment Topology

```
┌──────────────────────────── Docker Host ──────────────────────────────┐
│                                                                       │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐   │
│  │ scheduler    │   │ postgres     │   │ builder-ubuntu22         │   │
│  │ :8443        │──▶│ :5432        │   │ :8080 agent              │   │
│  │ Scheduler API│   └──────────────┘   │ :2222 sshd → host 2222   │   │
│  └──────┬───────┘                      └──────────────────────────┘   │
│         │                              ┌──────────────────────────┐   │
│         │                              │ builder-ubuntu24         │   │
│         └─────────────────────────────▶│ :8080 / :2222 → 2223     │   │
│                                        └──────────────────────────┘   │
│                                        ┌──────────────────────────┐   │
│                                        │ builder-ubuntu26         │   │
│                                        │ :8080 / :2222 → 2224     │   │
│                                        └──────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────┘
                 ▲
                 │ HTTPS (Management API)   SSH (troubleshooting / manual)
                 │
        ┌────────┴───────────┐
        │ Admin app (browser) │
        └─────────────────────┘
```

- All containers share the same Docker network, `platform-net`.
- Only the scheduler API and the builder SSH ports are mapped to the host.
- The admin app connects to PCS (control plane) and the scheduler (task plane); SSH is a separate channel and does not go through the scheduler.
- PostgreSQL is visible only inside the Docker network.

### 3.1 Multiple Hosts

The Compose setup above is a **single-machine reference deployment**. The Hosts page extends the same container model to multiple machines:

```
                 ┌───────────── PCS control plane ──────────────┐
                 │ Host onboarding · Deployment plan ·          │
                 │ Signed commands · Audit                      │
                 └───────┬─────────────────────────┬────────────┘
                         │ outbound long poll      │ outbound long poll
              ┌──────────┴───────────┐   ┌─────────┴──────────┐
              │ Local host           │   │ SSH remote host    │
              │ host-runtime         │   │ host-runtime       │
              │ ├ scheduler container│   │ ├ builder container│
              │ └ builder container  │   │ └ builder container│
              └──────────────────────┘   └────────────────────┘
```

- **Local host**: the machine running the admin app / PCS; no SSH needed. PCS runs probes and bootstrap directly on the local machine.
- **SSH remote host**: the platform stores the private key (AES-256-GCM encrypted; the API returns only the fingerprint) for probing and one-time bootstrap.
- **Bootstrap**: over SSH, PCS writes the host-runtime bundle, configuration, and command public key to
  `$HOME/.platform/host-runtime/<host_id>/` and starts it with a one-time registration token; afterwards the host
  connects to PCS **outbound**, and PCS no longer needs a long-lived SSH session.
- **Deployment**: PCS writes only desired state and signed commands; the container lifecycle is executed by host-runtime on the host.
- **Placement**: schedulers and builders can land on any onboarded host; each host has one root scheduler and can attach any number of child schedulers, and builders belong to the scheduler chosen at deployment time. See [federation.md](federation.md) for the topology.
- **Permission boundary**: PCS does not talk to Docker directly and does not expose host management ports; the private key is used only for probing and bootstrap.

Remote host prerequisites: Docker Engine, a PCS address reachable from the host (`PCS_RUNTIME_URL`),
and Node 22+ (to run host-runtime, or preinstalled by the deployer). Images still need to be pinned by
digest and included in `PCS_IMAGE_ALLOWLIST`.

---

## 4. Component Responsibilities

### 4.1 Scheduler Container `scheduler`

- HTTP API: task submission/query/cancellation, instance registration/heartbeat/claim/result, queue stats, event stream.
- In-memory + PostgreSQL: tasks, instances, leases, events, audit.
- Deterministic scheduling loop: FIFO + priority + aging; **the LLM plays no part in allocation**.
- The scheduler Agent's local MCP `builders` tools: `list_builders`, `builder_exec`, `builder_ask`, `task_status`; they are used only to inspect or operate builders and never influence dispatch decisions.
- Does not create containers or store builder SSH private keys; container lifecycle belongs to PCS and host-runtime, and users connect via SSH directly.

### 4.2 Builder Container `builder`

- Base images: official `ubuntu:20.04` / `22.04` / `24.04` / `26.04`, pinned by digest; the runtime payload (Node, CLI, sshd config) is injected from the host cache.
- Processes: `sshd` + `builder-agent` (register, heartbeat, claim, execute, report).
- Executor: an Agent Adapter (Claude Code / Codex / DeepSeek / custom CLI or HTTP Agent) or deterministic Shell.
- Workspace: `/opt/platform/workspace` (persistent volume); task artifacts live under `/opt/platform/artifacts`.
- SSH: `sshd` inside the container listens on 22 (2222 in the single-machine Compose setup), mapped by the host to a unique port; `root` by default, accepting only the host login public key.
- Full permissions: inside the container you can `apt install`, compile, edit files, and run arbitrary commands; this is a deliberate choice for an R&D platform.

### 4.3 Admin App

- Single-page app; connects to PCS and the scheduler API on open; no built-in demo data.
- Pages: Overview, Builders, Scheduler, Profiles (Agent/API), Tasks, Terminal (SSH), Chat, Logs.
- Mascots: two cute robots (scheduler robot / builder robot), with state expressed through expressions and animation.
- No login role switching, no approval center, no permission matrix.

### 4.4 Infrastructure

| Component | Required | Notes |
|---|---|---|
| Docker Engine 24+ | Yes | Runs all containers |
| PostgreSQL 16 | Recommended | Scheduler persistence; a built-in SQLite mode will also be available for single-machine use (later) |
| Redis | No | Enabled only for high-concurrency event streams |
| Reverse proxy (Caddy/Nginx) | Optional | TLS termination, unified domain |

---

## 5. Data Flow

### 5.1 Submitting a Build

```
Admin app ──POST /v1/tasks──▶ scheduler
scheduler: validate → enqueue (QUEUED) → event TASK_CREATED
builder ──POST /v1/claim──▶ scheduler
scheduler: eligibility filter → admission → lease → ASSIGNED
builder: execute → progress → POST /v1/result (fencing check)
scheduler: SUCCEEDED/FAILED → event → release lease
admin app: poll or refresh via SSE
```

### 5.2 Creating a Builder

```
Admin app ──POST /api/v1/platform/deployments──▶ PCS
PCS: write desired state → signed commands ──long poll──▶ host-runtime
host-runtime: verify signature/generation → create container → inject token → start
builder: register with its owning scheduler → heartbeat → ONLINE
admin app: show SSH address and port
```

> Both paths work: `deploy/compose.yaml` pre-provisions 1–4 builders on different Ubuntu versions;
> the admin app's "New Builder" goes through a PCS deployment plan, and the host SSH port is delivered
> with the deployment intent (`instance.ports`), which Host Runtime writes into `PortBindings`.
> Resource tiers come in light / standard / heavy, and you can also customize CPU, memory, and disk;
> the Agent can be Claude Code, Codex, DeepSeek, or custom, with DeepSeek connected through an
> `llm`-type API Profile.

### 5.3 SSH Troubleshooting

```
User ──ssh root@<host> -p <port>──▶ builder container
```

It does not go through the scheduler, creates no task, and is not subject to an allowlist. All operations are recorded by the container's own shell history / audit plugin (optional).

---

## 6. Task Model

| Field | Description |
|---|---|
| `task_type` | In v4 there are only `task.build`, `task.chat.builder`, `task.console.builder` |
| `target_role` | `builder` |
| `payload` | Commands, repository, branch, environment variable references, etc., defined by the user |
| `state` | `QUEUED → ASSIGNED → RUNNING → SUCCEEDED / FAILED / CANCELLED` |
| `attempt` | One attempt per claim; failures can be retried according to policy |
| `lease` | Lease + fencing token, preventing an old instance from overwriting a new result |
| `audit` | Event table + optional structured logs |

**There are no APPROVE / REVIEW / COMMIT / VERIFY stages.** When review is needed, write the review commands as part of the task, or run them manually inside the builder.

---

## 7. Security Boundaries (v4 Trade-offs)

Retained:

- The scheduler does not execute builds directly.
- Task results carry a fencing token to prevent concurrent overwrites.
- Builder tokens are used only for the scheduling API and are never written to logs.
- PostgreSQL is not exposed to the public internet; the API should sit behind a reverse proxy.

Deliberately relaxed:

- Builders run as `root` by default with full SSH access.
- The admin app has no RBAC; every operation is available.
- Approval is not enforced, and read/write isolation is not enforced.
- Builders can reach the internet (R&D needs it); Compose network policies can tighten this as needed.

> This is an explicit trade-off for a "small R&D-only platform": **exchange recoverability and observability for efficiency**, rather than restricting people through approval workflows.

---

## 8. Reliability

| Scenario | Behavior |
|---|---|
| Builder crash | Lease expires → task is requeued; the old fencing token becomes invalid |
| Scheduler restart | PostgreSQL restores the queue and leases; builders re-register |
| Network jitter | Heartbeat timeout marks SUSPECT, dispatch pauses, and in-flight tasks are not reclaimed immediately |
| Task failure | Retried up to `max_attempts`; after that BLOCKED, waiting for manual intervention |
| Disk full | Builders report resource status, and the scheduler pauses dispatch |
| Builder accidentally deleted | The container can be recreated; the workspace volume can be retained |

---

## 9. Ports

| Service | Container port | Host port | Exposure |
|---|---|---|---|
| PCS management plane | 7901 | 7901 | Internal network / reverse proxy |
| Scheduler API | 8443 | 8443 | Internal network / reverse proxy |
| Scheduler metrics | 9090 | 127.0.0.1:9090 | Local machine |
| Builder agent | 8080 | Not mapped | Docker network |
| Builder SSH | 22 | 2222–2231 (incrementing per deployment) | Internal network |
| PostgreSQL | 5432 | Not mapped | Docker network |

---

## 10. Removals Relative to v3

- Removed roles: `worker`, `tester`, `reviewer`, `after_sales`.
- Removed pages: approval center, audit permissions page, role office (five-role version).
- Removed mechanisms: approval requests/tokens/gates, RBAC, role switching, controlled terminal allowlist, cross-machine mTLS mainline.
- Removed documentation mainlines: the five-role specification and the full 12-interface protocol; the control plane is reduced to a single layer, PCS + host-runtime.
