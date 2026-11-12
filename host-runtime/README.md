# Host Runtime

> English · [简体中文](README.zh-CN.md)

See [../docs/architecture.md](../docs/architecture.md) and [../docs/federation.md](../docs/federation.md). This directory contains **two processes** and **one role-instance skeleton**:

| Process | Entry point | Responsibility |
|---|---|---|
| Host Runtime daemon | `src/runtime.ts` | Register with PCS, heartbeat, long-poll commands, verify signatures, drive the Docker container lifecycle, report actual state |
| Watchdog | `src/watchdog.ts` | Independently samples CPU/memory/disk and time since last PCS contact, writes `host-state.json`; holds no credentials |
| Role instance (role-agent) | `src/main.ts` | Claims tasks from the scheduler and executes them, asking local admission first; does not manage containers |

The daemon is **outbound only**: it never listens on a management port and every call goes to PCS; locally it opens a single 0600 unix socket for role instances to request admission.
PCS holds desired state, Runtime holds actual state, and Docker is the single source of truth.

## 1. Host Runtime daemon

```
Startup → read identity (run/identity/host.json)
  ├─ no identity → enroll with one-time PCS_ENROLLMENT_TOKEN → store host JWT + host_id
  ├─ identity present → renew when the token is near expiry
  │
  ├→ heartbeat/report (15s)
  ├→ long-poll commands (30s) → verify/validate → generation check → execute → ack
  └→ reconcile (15s): restart containers that exited; rebuild missing ones from desired state
        └─ PCS unreachable / watchdog protection / insufficient admission → create no new containers
```

- **Command verification**: Ed25519 + canonical JSON; any failure in the signature, `host_id`, expiry, image digest/repository allowlist,
  network policy, env credential keys, volume mounts, port mappings or `rgr_` grants is rejected and recorded as a failure.
- **Idempotency**: an already-processed `command_id` simply replays its result; an instance's `generation` only increases,
  and old commands return `{ignored:true,reason:"STALE_GENERATION"}`.
- **No retries on failure**: failed Docker operations are marked FAILED and acked; PCS must resend, and the command is not retried indefinitely.
- **Restart recovery**: `runtime-state.json` (0600, atomic write) holds desired state; containers keep running after a restart,
  and only missing ones are rebuilt. A corrupt state file is backed up and the process starts from empty state.
- **Revocation**: after PCS returns `HOST_REVOKED`, the daemon stops claiming commands and creating new containers, but **does not kill running containers**.
- **PCS unreachable**: after `max(45s, 3×heartbeat)` PCS is considered unreachable and new creation is paused; running containers are left alone.
- **Fixed endpoints only**: the Docker Engine API is called over bare HTTP on a unix socket for
  create/start/stop/restart/remove/inspect/list/pull — **no exec, no arbitrary shell, no arbitrary host paths**.

### Container baseline (v4 R&D containers)

Inside the container it is **root + writable root + `CapAdd:["ALL"]`**: SSH in and you have full privileges to `apt install`,
change system configuration and start arbitrary processes. The isolation boundary is not privilege reduction inside the container but the container boundary itself:

- CPU / Memory / MemorySwap / PidsLimit / BlkioWeight limits;
- no Docker socket and no host paths (named-volume `Mounts`, no `Binds`);
- network policies still reject `host` and `container:` modes;
- non-privileged, `Init:true`, `unless-stopped`, json-file log rotation (50m × 5).

Builder images are published for Ubuntu 20.04 / 22.04 / 24.04 / 26.04 and include `openssh-server`;
the SSH port travels in the signed command as part of the deployment intent (`instance.ports`), Host Runtime writes it into
`HostConfig.PortBindings`, and you connect with `ssh root@<host> -p <port>`. Reference images and Compose live in
`deploy/` at the repository root.

### Independent watchdog

The watchdog is a separate process that only reads `/proc`, `statfs` and the supervisor-written `pcs-last-seen.json`;
it does not read the Docker socket and holds no scheduler token or platform credentials.

```
NORMAL → WARNING → THROTTLED → PROTECTING → RECOVERING → NORMAL
```

- Escalation must persist for `sustain_seconds`; recovery first stabilizes for `recover_seconds`, then observes for `recovering_seconds`.
- If PCS has been unreachable longer than `pcs_lost_seconds`, the state goes **straight to PROTECTING**, regardless of local metrics.
- `PROTECTING` rejects all new containers; `THROTTLED` only rejects new deployments and still allows START/RESTART.
- A missing or stale state file (`> max(15s, 3×sample)`) is always treated as `WATCHDOG_UNAVAILABLE` — fail closed.

### Local admission (preventing oversubscription)

Before `start-ack`, a role instance asks Runtime over the unix socket:

```
POST /admission/check   { grant_id, kind:"TASK", instance_id, task_id, attempt_id, resources }
POST /admission/release { grant_id }
GET  /grants            → aggregate + items[{grant_id, instance_id, attempt_id, expires_at}]
```

- `allocatable = total - host_reserve - system_reserve - safety_margin`
- `available = min(allocatable - deployment_grants - task_grants, live MemAvailable - safety_margin)`
- Validation and reservation run serially on the same promise chain, so two tasks can never observe the same remaining capacity.
- `grant_id` is idempotent; reusing the same grant for a different attempt returns `GRANT_CONFLICT`; grants are reclaimed automatically when their TTL expires.
- **Crash reconciliation**: on startup, a role instance fetches `items` and releases stale grants left in its own name (from a previous kill that had no chance to release),
  preventing phantom occupancy until TTL.
- Container usage is rebuilt by the reconciler from the **labels of containers actually running**, with no double counting.
- If a role instance cannot obtain admission (denied or socket unavailable), it responds `accepted:false`; the scheduler returns the task to the queue and **does not consume a retry**.

### Running

```bash
npm install
cp runtime.host.example.json runtime.host.json   # edit pcs_url / key paths / allowlist

# the enrollment token is generated by PCS host-add and passed only via an environment variable
export PCS_ENROLLMENT_TOKEN=enr_xxx
./scripts/runtime.sh start     # start watchdog + runtime (development; production uses two systemd units)
./scripts/runtime.sh status
./scripts/runtime.sh logs
./scripts/runtime.sh stop
```

After the first successful enrollment, the identity is written to `identity_dir/host.json` (0600); the enrollment token is then invalid and can be deleted.
`PCS_COMMAND_PUBLIC_KEY_FILE` must exist, otherwise the process exits immediately (it will not start without the public key).

### Configuration (runtime.host.json)

| Field | Default | Description |
|---|---|---|
| `pcs_url` | `http://127.0.0.1:7901` | PCS address (`PCS_URL` env var takes precedence) |
| `pcs_ca_file` | unset | Internal CA used to verify the PCS server certificate (`PCS_CA_FILE` takes precedence) |
| `pcs_client_cert_file` | unset | mTLS client certificate (`PCS_CLIENT_CERT_FILE` takes precedence); configure together with KEY |
| `pcs_client_key_file` | unset | mTLS client private key (`PCS_CLIENT_KEY_FILE` takes precedence) |
| `identity_dir` | `run/identity` | Host identity and JWT; directory 0700, files 0600 |
| `state_dir` | `run/state` | `runtime-state.json`, `host-state.json`, `pcs-last-seen.json` |
| `command_public_key_file` | — | PCS command public key; refuses to start if missing |
| `image_allowlist` | `[]` | Allowed repository prefixes; empty array = deny everything |
| `network_policies` | `{"default":"bridge"}` | Policy name → Docker network; `host`/`container:` are rejected |
| `docker_socket` | `/var/run/docker.sock` | Docker Engine socket |
| `admission_socket` | `run/runtime.sock` | Local admission unix socket (0600) |
| `admission.*` | see example | Reserved capacity, per-task limit, grant TTL |
| `heartbeat_seconds` / `report_seconds` | 15 | Heartbeat and report intervals |
| `command_wait_seconds` | 30 | Long-poll wait |
| `container_stop_timeout_seconds` | 30 | Container stop timeout |
| `remove_volumes_on_remove` | false | Whether REMOVE deletes named volumes (kept by default) |
| `watchdog.*` | see example | Thresholds, sustain/recovery windows, PCS-unreachable threshold |

### Tests

```bash
npm test        # 65 cases
npm run typecheck
```

Covers: the watchdog state machine and fail-closed behavior, command signature/image/network/credential/generation checks,
admission concurrency and oversubscription prevention plus socket permissions, the reconciler's DEPLOY/START/STOP/RESTART/REMOVE and reconciliation;
plus P4's profile validation, the seven-step Tool Policy Guard, default-deny egress, API adapter
(auth injection/quota/fallback/secret rejection), stdio Agent execution and Agent switching/crash.

Test agents use `../agents/demo-agent.mjs` inside the repo by default; when syncing `agents/` elsewhere on a remote test machine,
override with `AGENT_FILE=/path/to/demo-agent.mjs`. The CLI wrapper has a separate protocol test:
`node agents/test-cli-agent.mjs` (stub CLI, no real model needed).

## 2. Role instance (role-agent)

See [../docs/federation.md](../docs/federation.md): the complete lifecycle of a role instance.
It **makes no scheduling decisions** — which task to claim is decided by the scheduler; it only does "ask → check locally once more → execute → report",
and every write carries `lease_token` + `fencing_token`.

```
Register → heartbeat(10s) ─────────────────────┐
  │                                            │
  ├→ config sync(30s) ← /v1/instances/:id/config │
  │     version unchanged → 304                  │
  │                                            │
  └→ claim loop(configurable) ← scheduler /v1/claim │
        │  got an assignment                     │
        ▼                                       │
  Host Runtime admission (unix socket, live capacity) │
        │ denied/unavailable → start-ack{accepted:false} │
        ▼                                       │
  start-ack → lease renewal timer → progress reports → execute │
        │                                       │
        ├─ cancellation probe (task CANCELLED) → abort │
        ├─ renewal failure FENCING_STALE → give up, write no result │
        └─ result → submit-result (idempotent)   │
```

- **Registration failure does not exit**: if the scheduler is not up, it retries with backoff and the process stays resident.
- **Admission fails closed**: if `host_admission_socket` is configured but the socket is unavailable, assignments are rejected; the live-capacity check is never bypassed.
- **Backoff after admission denial**: wait according to `claim_interval_seconds` before claiming again, instead of hammering the same task with attempts.
- **Startup reconciliation**: release task grants left over from this instance's previous crash before claiming begins.
- **Heartbeat and lease are separate**: a heartbeat only means "the instance is alive"; a lease means "this attempt belongs to me".
- **Lost lease = stop immediately**: do not submit a result; leave it to the scheduler to reclaim and a new instance to rerun.
- **Exit deregisters**: after SIGTERM, in-flight tasks finish, then `deregister`; a timeout sends `force:true`.
- **Artifacts are uploaded by the executor**: register → `PUT content` → `complete`; the scheduler recomputes SHA-256 before using it as approval evidence.
- **Explicit upstream artifact handoff**: downstream roles only download artifacts listed in `requirements.upstream_artifacts`,
  and after downloading they verify them against the handoff list's `sha256`; the scheduler only authorizes instances covered by that handoff list.
- **One working directory per attempt**: `<workspace_dir>/<attempt_id>/`, deleted when finished (`keep_workspace` can preserve it).

### Role executors (`src/roles/`)

v4 has only two roles, so the executors cover just these task types:

| Role | Task type | What it does |
|---|---|---|
| builder | `task.build` | Runs `requirements.build.command` inside the workspace and uploads the full log as an artifact; falls back to a deterministic build manifest when there is no command |
| builder | `task.chat.builder` | Tamp (builder bot) conversation; can be handed to an Agent when one is bound |
| builder | `task.console.builder` | Full shell inside the container (equivalent to SSH), no command allowlist |
| scheduler | `task.chat.scheduler` | Relay (scheduler bot) conversation |
| scheduler | `task.console.scheduler` | Full shell inside the scheduler container |

`task.console.*` always goes to the deterministic executor and is never routed to an external Agent; only `task.chat.*` consults
`agent.task_types` to decide whether to hand off to an Agent. A build command timeout (15 minutes by default) or non-zero exit code
keeps the log artifact and fails with `BUILD_TIMEOUT` / `BUILD_FAILED` respectively.

### Running

```bash
# prerequisite: scheduler at 127.0.0.1:7801, with docker-host-01 / dev-box and the corresponding role instances in the database
cp runtime.config.example.json runtime.config.json
./scripts/start.sh scheduler builder-ubuntu20-a builder-ubuntu22-a builder-ubuntu24-a
./scripts/stop.sh scheduler builder-ubuntu20-a builder-ubuntu22-a builder-ubuntu24-a
```

When the scheduler enables instance JWTs, each instance reads its own token from the mounted directory (`<dir>/<instance_id>.jwt`, re-read on every request):

```bash
INSTANCE_TOKEN_DIR=run/tokens ./scripts/start.sh builder-ubuntu22-a builder-ubuntu24-a
```

Shared tokens are still available during the transition via `SCHEDULER_TOKEN=xxx`; if neither is configured while the scheduler requires auth, registration returns 401.

| Field | Default | Description |
|---|---|---|
| `scheduler_url` | `http://127.0.0.1:7801` | Scheduler address |
| `scheduler_ca_file` | unset | Internal CA used to verify the scheduler certificate (`SCHEDULER_CA_FILE` takes precedence) |
| `scheduler_client_cert_file` | unset | mTLS client certificate (`SCHEDULER_CLIENT_CERT_FILE` takes precedence); configure together with KEY |
| `scheduler_client_key_file` | unset | mTLS client private key (`SCHEDULER_CLIENT_KEY_FILE` takes precedence) |
| `host_admission_socket` | unset | Host Runtime admission socket; when unset, falls back to in-process `LocalAdmission` |
| `heartbeat_seconds` | 10 | Heartbeat interval |
| `claim_interval_seconds` | 2 | How often to ask when idle |
| `lease_renew_seconds` | 60 | Lease renewal interval |
| `progress_seconds` | 3 | Progress reporting (also probes for cancellation) |
| `config_sync_seconds` | 30 | Config sync interval |
| `workspace_dir` | `data/workspace` | Root of the role executor working directories; one subdirectory per attempt |
| `keep_workspace` | false | Debugging: keep the working directory after the task ends |
| `instances[].slots` | 1 | How many tasks to run concurrently |
| `instances[].slot_memory_bytes` | 1 GiB | Memory budget per slot |

When PCS and the scheduler use an internal CA / mTLS, Host Runtime reads the CA and client certificates explicitly rather than relying on the system trust chain:

```bash
export PCS_CA_FILE=/secure/pki/ca.crt
export PCS_CLIENT_CERT_FILE=/secure/pki/client.crt
export PCS_CLIENT_KEY_FILE=/secure/pki/client.key
export SCHEDULER_CA_FILE=/secure/pki/ca.crt
export SCHEDULER_CLIENT_CERT_FILE=/secure/pki/client.crt
export SCHEDULER_CLIENT_KEY_FILE=/secure/pki/client.key
```

The process exits immediately if a certificate file is missing or if CERT is configured without KEY. Artifact upload/download and ordinary JSON requests
share the same HTTP(S) channel, so they automatically carry the client certificate too. The Secret Store client still uses `fetch`,
so in an internal-CA setup set `NODE_EXTRA_CA_CERTS` separately (see [../secret-store/README.md](../secret-store/README.md)).

## 3. Agent / API integration (P4)

See the Agent/API profiles section of [../docs/admin-app.md](../docs/admin-app.md). Beyond the deterministic executor, a role instance can load
Agent Profiles according to PCS bindings and let an adapter execute tasks; all external API traffic egresses through the local API adapter.

### 3.1 Profile loading and envelope validation

- `profiles_file` in `runtime.config.json` points to the runtime view exported by PCS `resolve`
  (`agent_profiles[]` / `api_profiles[]` / `bindings`); **the file contains only `secret_ref` references, never key values**.
- Only instances bound by PCS enter Agent mode; instances with no binding/profile keep using the deterministic executor
  (P2/P3 compatible). If bound but validation fails → **the instance fails to start**; there is no silent downgrade.
- Startup validation: role/adapter matrix (only builder / scheduler, both allowing `stdio-jsonrpc` / `http-local`), binding consistency,
  the API set loaded by the instance = the PCS binding set, and any `tool_api_profile_ids` declared by the Agent must already be bound.
- Each assignment validates the envelope again: `agent.profile_id` / `agent.version` / `api_profiles[]`
  must match what was loaded locally. A mismatch → `start-ack {accepted:false}`, back to the queue, **no retry consumed**,
  write `profile-audit.jsonl`, and do not call the Agent.
- Whether a task type is handed to the Agent is decided by `agent.task_types`; types not in the list fall back to the deterministic executor.

### 3.2 Adapters

| Adapter | Transport | Applies to |
|---|---|---|
| `stdio-jsonrpc` | JSON-RPC 2.0 subprocess, one JSON per line | All roles that allow Agents |
| `http-local` | one-shot localhost HTTP JSON-RPC | builder / scheduler (no reverse tool callbacks) |

The contracts for `agent.prepare` / `agent.execute` / `agent.cancel` / `agent.health`, along with
`agent.event` (progress/log/artifact), `agent.result` and `tool.call`, are specified in §3.
The adapter subprocess environment contains only `PLATFORM_*` (workspace, task, tool_token, local API proxy address);
**no scheduler token, no instance JWT, no Secret Store address**.

#### 3.2.1 CLI Agent Adapter (Claude Code / Codex)

`agents/cli-agent.mjs` is a generic `stdio-jsonrpc` wrapper; a profile only needs to point at it:

```json
{
  "adapter": "stdio-jsonrpc",
  "entrypoint": ["node", "/opt/platform/agents/cli-agent.mjs"],
  "args": ["--provider", "claude"],
  "task_types": ["task.build", "task.chat.builder"]
}
```

- `--provider claude` invokes `claude -p <prompt> --output-format json`; `--provider codex` invokes
  `codex exec <prompt>`; `--provider custom --command <bin>` connects any CLI.
- The external CLI receives only a minimal environment by default (`PATH`, `LANG`, `HOME=workspace`, task identifiers),
  and does not inherit host credentials; model keys must be explicitly allowed with `--pass-env <NAME>`. `PLATFORM_TOOL_TOKEN` /
  `PLATFORM_API_PROXY` / `PLATFORM_API_PROFILES` are never passed in; external CLI stdout/stderr
  never leaks into the protocol channel.
- Non-chat tasks require the CLI to write `<workspace>/result.json` (`summary` + `outputs[]`); the adapter only accepts
  relative paths inside the workspace. Chat tasks map stdout to `reply`, and the executor writes `mode=agent`.
- If the CLI is not installed, `prepare` returns `ready:false` and the task fails with `AGENT_NOT_READY`; there is no downgrade.
- Controlled terminals `task.console.*` **always use the deterministic executor**, even when the instance has an Agent bound; only chat tasks
  `task.chat.*` are handed to the Agent according to `task_types`.
- Use `scripts/seed-cli-agents.mjs` to register Claude/Codex profiles with PCS:
  `ADMIN_TOKEN=... AGENT_IMAGE=<digest-pinned image> node scripts/seed-cli-agents.mjs --bind builder-ubuntu22-a:claude`.
- The adapter has its own protocol-level test: `node agents/test-cli-agent.mjs` (using `agents/fixtures/stub-cli.mjs`;
  no real model or CLI credentials needed).

### 3.3 Tool Policy Guard

`tool.call` emitted by the model is only a request. `src/agent-runtime/tool-policy.ts` rejects it through a fixed seven-step check:

1. Attempt identity: `tool_token` must be randomly generated for this attempt (never reused across tasks);
2. Profile allowlist `allowed_tools`; not listed → `TOOL_NOT_ALLOWED`, outside the catalog → `TOOL_UNKNOWN`;
3. Workflow phase;
4. Argument schema and workspace paths (`WORKSPACE_PATH_DENIED`);
5. Resources/network/`action_scope`; the profile for `api.call` must be within the bindings;
6. Idempotency key: same key with different arguments is rejected (`TOOL_IDEMPOTENCY_CONFLICT`), same key with same arguments returns the first result;
7. Audit: write only the tool, argument digest, result digest, duration and decision — **never argument bodies or keys**.

There is also a `max_turns` limit (`TOOL_TURN_LIMIT`). Tool return values are marked as untrusted input and
do not participate in later authorization decisions. The platform catalog currently contains only `demo.echo`, `workspace.read/write` and `api.call`;
there is no arbitrary shell or arbitrary host path.

### 3.4 API Adapter and secrets

- Every instance with a bound API starts a local proxy on `127.0.0.1:<random port>`; the Agent only receives
  `PLATFORM_API_PROXY` and a `/<api_profile>/<path>` handle.
- The adapter strips any `authorization` / `cookie` / `host` / `x-api-key` supplied by the Agent,
  then fetches credentials from the Secret Store and injects them. Credentials live only in the adapter's memory and **never enter env, logs, artifacts or audit**.
- The Secret Store authenticates the instance JWT (`sub` = instance_id); if it cannot be read or is revoked, the task fails closed.
  `cacheMs` defaults to 0, so revocation and rotation take effect on the next call.
- Quotas: `rpm` / `daily_calls` are counted per profile; exceeding them returns 429.
- Retries: only GET/HEAD or requests with an idempotency key are retried, at most once; non-idempotent requests are never blindly replayed.
- Redirects: `redirect: manual`; the Location target goes through the egress policy again and is never followed silently.
- Fallback: when the primary profile fails with a retryable error, profiles are tried in order and audit records `fallback_from`.
- Egress: deny by default; a profile must declare an `egress` policy name, Host Runtime's `egress_policies`
  provides the host allowlist, and only `https` is permitted (local development with `allow_loopback_egress` allows loopback http).
  Cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, etc.) and loopback/private/
  link-local addresses are rejected no matter what the allowlist says; every address returned by DNS must be validated.

Audit files are written under `audit_dir` (default `data/audit`, 0700 directory / 0600 files):
`tool-audit.jsonl`, `api-audit.jsonl`, `profile-audit.jsonl`.

### 3.5 Configuration fields (runtime.config.json, new in P4)

| Field | Default | Description |
|---|---|---|
| `profiles_file` | unset | Profile file exported by PCS `resolve`; when unset, Agent mode is not enabled |
| `secret_store_url` | unset | Secret Store address; if an instance binds APIs without it → startup fails (fail closed) |
| `egress_policies` | `{}` | Policy name → allowed hosts; empty = deny all |
| `allow_loopback_egress` | false | **Local development only**: allow API profiles to reach loopback http |
| `audit_dir` | `data/audit` | Tool/API/profile audit directory |
| `instances[].agent_profile_version` | unset | Version reference reported at registration when no Profile file is used |
| `instances[].api_profile_ids` | `[]` | API references reported at registration when no Profile file is used |
| `instances[].api_adapter_port` | 0 (random) | Local API proxy port; usually fixed at 8090 inside containers |

The `SECRET_STORE_URL` environment variable takes precedence over `secret_store_url`; instance tokens are still re-read from
`INSTANCE_TOKEN_DIR/<instance_id>.jwt` on every request.

### 3.6 Failure semantics

| Situation | Result |
|---|---|
| Envelope Profile/version/API mismatch | `start-ack accepted:false`, back to the queue, no retry consumed |
| Agent uses an unauthorized tool / invalid arguments | `FAILED`, `TOOL_*` error code, not retryable |
| API egress denied by policy | `FAILED`, `EGRESS_*`, not retryable |
| Secret unauthorized/revoked | `FAILED`, `SECRET_*`, not retryable |
| API quota 429 / 5xx / network jitter | Task fails; retryable per profile semantics |
| Adapter crash | `FAILED AGENT_CRASHED`, **role-agent stays ONLINE**, task retryable |
| prepare not ready | `FAILED AGENT_NOT_READY` |

## Directory

```
src/
  runtime.ts              Host Runtime daemon entry point
  runtime-config.ts       Daemon configuration (runtime.host.json)
  identity.ts             Identity persistence (0600) and token availability checks
  pcs-client.ts           PCS HTTP client (enroll/heartbeat/commands/ack/report/renew)
  command-verify.ts       Canonical JSON, Ed25519 verification and all policy checks
  docker-engine.ts        Fixed-endpoint Docker Engine API (unix socket)
  container-spec.ts       §7 container security configuration
  runtime-state.ts        Desired-state persistence (atomic writes, corrupt-file backup)
  reconciler.ts           Desired state ↔ actual state reconciliation
  watchdog.ts             Independent watchdog process
  watchdog-state.ts       State machine and container admission decisions
  admission-broker.ts     Local admission broker + unix socket server
  host-admission-client.ts Admission client on the role-instance side
  host-report.ts          §6.4 host reporting
  agent.ts / client.ts    Role-instance lifecycle and scheduler client
  exec-types.ts           Executor context and failure semantics
  executor.ts             Task type → executor registry
  roles/                  v4 executors: builder (task.build), chat-console
                          (task.chat.* / task.console.*), shell tool
  agent-runtime/
    types.ts              Agent/API profile runtime view and tool catalog
    profiles.ts           Profile file loading, role/adapter matrix, envelope validation
    stdio-adapter.ts      stdio JSON-RPC adapter
    http-local-adapter.ts localhost HTTP adapter
    tool-policy.ts        Tool Policy Guard (fixed seven steps)
    egress.ts             Default-deny egress, DNS/metadata/private-network validation
    secret-client.ts      Exchanges instance identity for short-lived credentials from the Secret Store
    api-adapter.ts        Local API proxy: auth injection, quotas, retries, fallback, audit
    agent-executor.ts     Assembles the Guard/Adapter, uploads artifacts and maps failures
scripts/
  runtime.sh              Start/stop/status/logs for watchdog + runtime
  start.sh / stop.sh      Start/stop role instances
test/                     Watchdog, command, admission, reconciler and role-instance tests
```

## Boundaries

- **Executors are a development reference implementation**: `task.build` runs the configured command directly in the workspace, and `task.console.*`
  is a full shell inside the container; neither pretends to complete external-system operations.
- **No platform write credentials held**: Agent subprocesses and terminal environments contain no scheduler token, instance JWT or Secret Store address;
  credentials live only in API adapter memory.
- **No Docker socket in containers**: role containers use the local socket for admission and never operate Docker directly.
- **Agents never see instance identity**: the adapter environment has no instance JWT, Secret Store address or scheduler token;
  credentials exist only in API adapter memory. The local API proxy has no additional authentication and relies on listening only on loopback inside the container;
  if production runs untrusted processes in the same container, add container-local network isolation or unix socket permissions.
- **Secret Store is a reference implementation**: file backend (0600) + per-instance policy + short TTL, not Vault/KMS;
  when replacing it for production, keep the contract "resolve per instance identity, store references only, revocable, audit without values".
- **No task-level priorities**: that is the scheduler's job.
- **Single control plane, not HA**: while PCS or Runtime restarts, new creation is paused according to the fail-closed rules above; the system never guesses state.
- **Images must be pullable in advance**: only digest-pinned images are accepted; if a registry is unreachable, deployment fails and never falls back to a tag.
