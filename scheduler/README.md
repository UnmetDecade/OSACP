# Scheduler

> English · [简体中文](README.zh-CN.md)

See [../docs/scheduler.md](../docs/scheduler.md). The scheduler is the single state authority:
the whole chain "state machine → claim → lease → reclaim → retry" runs inside PostgreSQL transactions.
v4 has only two roles (scheduler / builder), the workflow keeps a single build step, and there are no approval or review stages.

Stack: Node 22 + TypeScript + PostgreSQL 16 (`pg` direct, no ORM). No Redis, no message queue.

## Implemented

| Spec | Content | Notes |
|---|---|---|
| §4 state machine | Table-driven transitions + `409 STATE_CONFLICT` | Illegal transitions are rejected in one place, `statemachine.ts` |
| §4.4 versioning and concurrency | `version` optimistic lock, append-only events (database triggers block UPDATE/DELETE) | |
| §3.2 eligibility filtering | role / task type / capability subset / `payload_schema` / ONLINE / host status / `requirements.target_instance_id` | Capability-level health reserves an `unhealthy` field; targeted tasks are claimed only by the designated instance |
| §3.3 ordering | Deterministic ordering by effective priority + enqueue time + `task_id` | See "Differences from the spec" below |
| §3.4 claim | `FOR UPDATE SKIP LOCKED` + admission + lease creation in one transaction | If admission fails, the task stays `QUEUED` and `resource_block_reason` is written |
| §3.5 concurrency | `min(global, role_pool, instance, task_type)` + host budget | Aging raises priority every 600s, capped at P1, recording `TASK_AGED` |
| §5 leases | `lease_token` / `fencing_token` / 30s startup window / renewal / reclaim | A stale attempt write gets `409 FENCING_STALE` |
| §6 admission | `HELD → ACTIVE / RELEASED / RECLAIMED` reservations | Budget checks are simplified; see "Not implemented" |
| §8 retries | 5m/15m/45m backoff, non-retryable error codes, dead-letter marking | The backoff table comes from `scheduler_config.retry_backoff_seconds` and is configurable; `PAYLOAD_INVALID` / `AUTH` etc. are not retried |
| §10 API | Task API, worker protocol endpoints, `healthz` / `readyz` / `queue/stats` | |
| §6.1 transport security | Native `https` server; optional mTLS client certificates | Certificates are issued by an internal CA; transport identity and Bearer/JWT identity are validated separately |
| §7.3 / §7.10–7.12 | Capability narrowing, `drain` / `resume`, config sync, deregistration | Capabilities have a ceiling and can only narrow |
| §8.1 Outbox | State transitions and `outbox_events` written in the same transaction; `GET /v1/events` cursor replay, `GET /v1/events/stream` SSE | SSE is only a notification; the outbox is authoritative |
| §7 workflows | v4 template `wft_build` has a single step, `EXECUTE(task.build)` | Phase advancement and result submission share one transaction; no REVIEW / APPROVE / VERIFY |
| §7.3 approval | Approval tables and signature verification remain in the code, but v4 does not use them by default | Seeded workflows have `approval_policy_ref = NULL`, and the admin app has no approval entry point |
| §3.2 instance identity | ES256 JWT: `sub` = instance_id, scope determines permissions, `assertSelf` blocks cross-instance access | Falls back to a shared `AUTH_TOKEN` when no PCS public key is configured (local development only) |
| §7.8 artifacts | `POST /v1/artifacts` → `PUT .../content` → `POST .../complete`; read with `GET .../content` | On complete, **the server recomputes SHA-256** and the approval digest uses that value; downloads are authorized only for the owner or for instances the scheduler has handed off via `requirements.upstream_artifacts` |
| P4 Agent/API | Registration and config-sync carry only `agent.profile_id` / `agent.version` / `api_profiles[]` references; the claim envelope likewise carries only references | The scheduler does not load profile implementations or touch `secret_ref` values; switching Agents only changes PCS bindings and instance configuration |
| Chat / container terminal | `sql/004_chat_console.sql` registers `task.chat.<role>` / `task.console.<role>` and adds them to each instance's allowed task types | They are ordinary tasks and reuse audit, leases and fencing; the terminal is a full shell inside the container, equivalent to SSH |

## Not implemented (next steps)

- Expiry sweeps for approval requests and bulk `INVALIDATED` after a subject changes.
- Automatic renewal of instance tokens (PCS issues 24h tokens; they must be remounted before expiry).
- OIDC / user login: the scheduler only verifies tokens; admin-side user authentication stays in PCS / the admin app.
- Mapping client certificates to instance identity: mTLS is only a transport gate; instance identity still comes from the JWT `sub`.
- The other half of two-phase admission: the **cross-process** handshake in which Host Runtime re-checks a `HELD` reservation and moves it to `ACTIVE` (currently the transition happens at start-ack).
- Redis Streams / an external message bus: SSE currently polls the outbox directly, which is enough for a single control plane; cross-process broadcast will need the messaging layer.
- Event retention policy (the spec requires 30 days) and archival cleanup jobs.
- `/metrics`.
- Object storage and presigned URLs: artifacts currently land in a local directory, and the endpoint semantics stay the same.

## Chat and controlled terminals (P5 addition)

- `task.chat.<role>`: the request body is in `requirements.chat` (`session_id` / `message` / `history`);
  Host Runtime's deterministic executor or the bound Agent returns `outputs.reply` and `outputs.mode`.
- `task.console.<role>`: the request body is in `requirements.console`; Host Runtime runs a full
  shell inside the container (no command allowlist, equivalent to SSH), and the scheduler only dispatches and records.
- Both task types can target a specific builder with `requirements.target_instance_id`; the candidate SQL
  for claims filters out non-matching instances.
- These task definitions use `max_attempts=1` so chat/terminal commands are not executed repeatedly; a failure is recorded as terminal.

## Directory

```
src/
├── statemachine.ts      # transition table (the only place that decides "what can become what")
├── db.ts                # connection pool, transactions, database time
├── auth.ts              # instance auth: JWT verification, scope, assertSelf; shared-token fallback
├── jwt.ts               # ES256 JWT verification (no third-party library)
├── core/claim.ts        # claim: eligibility + admission + lease, one transaction
├── core/attempts.ts     # start-ack / renew / progress / result (advances the workflow on termination)
├── core/workflow.ts     # workflow phase advancement + approval decisions
├── core/artifacts.ts    # artifact registration, storage, server-side digest verification
├── loops/reaper.ts      # startup window timeout, lease expiry → reclaim / requeue / dead letter
├── repo/instances.ts    # registration, heartbeat, SUSPECT/OFFLINE, drain/resume, deregistration, config-sync
├── repo/outbox.ts       # event cursor reads (SSE / polling API)
├── repo/task-insert.ts  # minimal task-write unit (shared by workflows and the task repository, avoiding cycles)
├── repo/tasks.ts        # task CRUD, cancellation, event queries
├── http/server.ts       # bare node:http routing
└── main.ts              # process entry point + two background sweeps
sql/001_init.sql         # schema (§9 + [added] fields)
sql/002_seed.sql         # demo data (scheduler + 3 Ubuntu builders + wft_build template)
sql/003_profiles.sql     # [added] role_instances.agent_profile_version / api_profile_ids
sql/004_chat_console.sql # [added] task.chat.* / task.console.* task definitions and instance allowlists
test/                    # 51 cases, including fault injection
scripts/demo.sh          # end-to-end HTTP demo
scripts/reset.sh         # reset the database and reload demo data
scripts/dev-server.sh    # start/stop
```

## Quick start

Prerequisite: PostgreSQL 16 is running and `pg` can connect to it.

```bash
npm install
npm run migrate            # create database + tables
npm run seed               # demo data (optional)
npm test                   # needs the scheduler_test database: DATABASE_URL=... npm run migrate

npm start                  # listens on 127.0.0.1:7801
./scripts/demo.sh          # in another terminal, run the end-to-end demo

# events: SSE live stream / cursor replay
curl -N "http://127.0.0.1:7801/v1/events/stream?after=0"
curl "http://127.0.0.1:7801/v1/events?after=0&limit=50"

# workflow: start a build workflow → view the result (v4 has one build step)
curl -X POST http://127.0.0.1:7801/v1/workflows -H 'content-type: application/json' \
  -d '{"workflow_template_id":"wft_build","payload_ref":"git://repo/demo"}'
curl http://127.0.0.1:7801/v1/workflows/<run_id>

# or submit a build task directly
curl -X POST http://127.0.0.1:7801/v1/tasks -H 'content-type: application/json' \
  -d '{"task_type":"task.build","priority":2,
       "requirements":{"build":{"command":"npm test","workdir":"."}}}'
```

How to enable authentication: run `npm run keygen` in `pcs-issuer` to generate keys, then set
`PCS_PUBLIC_KEY_FILE=../pcs-issuer/keys/public.pem` for the scheduler; issue instance tokens with
`npm --prefix ../pcs-issuer run issue -- instance --id builder-ubuntu22-a ...` and place them in Host Runtime's `token_dir`.

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:sched_dev_pw@127.0.0.1:5432/scheduler` | |
| `PORT` | `7801` | |
| `HOST` | `127.0.0.1` | Listen address; in production put it on the internal network with TLS/mTLS |
| `TICK_MS` | `1000` | Background sweep interval |
| `DISABLE_LOOPS` | unset | Set to `1` to run HTTP only, without background sweeps (for unit tests) |
| `PCS_PUBLIC_KEY_FILE` | unset | Path to the PCS public key PEM; once set, instance endpoints accept only ES256 JWTs (legacy approval verification uses it too) |
| `PCS_PUBLIC_KEY` | unset | Same as above, but the PEM content directly (newlines may be written as `\n`); takes precedence over the file |
| `ARTIFACT_DIR` | `./data/artifacts` | Artifact directory; after switching production to object storage, endpoint semantics stay the same |
| `AUTH_TOKEN` | unset | **Transitional fallback**: shared Bearer token when no PCS public key is configured; ignored once a public key is set |
| `SCHEDULER_TLS_CERT_FILE` | unset | Server certificate PEM; must be configured together with `SCHEDULER_TLS_KEY_FILE` |
| `SCHEDULER_TLS_KEY_FILE` | unset | Server private key PEM |
| `SCHEDULER_TLS_CA_FILE` | unset | CA for client certificate verification; required when mTLS is enabled |
| `SCHEDULER_MTLS` | unset | Set to `1` to require client certificates; needs CERT/KEY/CA all in place |

> v4's default workflow does not use approvals; the approval endpoint remains, but without a configured PCS public key it returns `503 APPROVAL_NOT_CONFIGURED`.

Enable TLS / mTLS:

```bash
../scripts/pki.sh /secure/pki       # generate the internal CA, scheduler server certificate and shared client certificate
SCHEDULER_TLS_CERT_FILE=/secure/pki/scheduler.crt \
SCHEDULER_TLS_KEY_FILE=/secure/pki/scheduler.key \
SCHEDULER_TLS_CA_FILE=/secure/pki/ca.crt \
SCHEDULER_MTLS=1 \
npm start
```

The server certificate SANs must include the address clients actually use (default `localhost` / `127.0.0.1`;
additional addresses are added through extra `pki.sh` arguments). Client certificates are only a transport gate;
instance identity still comes from the JWT; if the certificate is missing or untrusted, the TLS handshake fails immediately.
The P6 acceptance script is `../scripts/e2e-p6.sh`.

## Three key design decisions

**1. Time comes only from the database.**
Lease expiry, SUSPECT decisions and backoff windows all use `app_now()`, never `Date.now()`.
`app_now()` reads a `_clock` table; with offset 0 in production it is equivalent to `now()`.
Tests use it as a time machine, verifying "45 seconds without a heartbeat" and "lease expired at 301 seconds" without actually sleeping.

**2. Claiming is one SQL statement, not a flow.**
`SELECT ... FOR UPDATE SKIP LOCKED` + attempt/lease/reservation writes in the same transaction.
There is no application-level "read then write", so when two instances claim concurrently exactly one can succeed (with the `leases_one_active_per_task` unique index as a backstop).

**3. Fencing is the last gate for duplicate execution.**
The scheduler can only guarantee "at least once" delivery, not exactly-once.
Any write from an old attempt (start-ack / progress / result) is rejected because `fencing_token < max(fencing_token)`,
so business tasks must still provide their own idempotency keys.

## Workflows and approvals (§7)

Templates (`workflow_templates`) are maintained by PCS; the scheduler is read-only. The phase sequence is fixed as
`EXECUTE → REVIEW → APPROVE → COMMIT → VERIFY`, with one task per phase and `parent_task_id` pointing at the previous phase.

- **Advancement and result share one transaction**: `submitResult` commits "task SUCCEEDED + create next-phase task" together,
  so there is no gap where a task succeeds but the next phase never enqueues; a late result from an old phase (where `run.current_task_id` does not match) does not advance the workflow.
- **APPROVE creates no task**: the workflow stops at `WAITING_APPROVAL`, inserts a `PENDING` row in `approval_requests`,
  and freezes the `subject_digest` of the previous phase's **artifact** (templates may require `artifact_required`, and a missing artifact is rejected outright).
- **Approvals only accept signed tokens**: the `approval_token` for `POST /v1/tasks/{id}/approve` must be an ES256 JWT issued by PCS,
  and `approval_request_id`, `operator_id`, `subject_digest` and `action_scope` must match the pending request field by field;
  `jti` is unique in the database and cannot be replayed. An "approved" message in chat is not accepted as input.
- **Failure ends the workflow**: a non-retryable failure → workflow `FAILED`; cancellation → `CANCELLED`; approval rejection → `FAILED`.
  No phase is ever skipped automatically, and no Agent ever guesses how to resolve a conflict.
- **No configuration, no approval**: without a PCS public key, the approval endpoint returns `503 APPROVAL_NOT_CONFIGURED` and does not fall back to a shared token.

## Differences from the spec

- **§3.3 sort direction**: `ORDER BY effective_priority ASC`. The aging formula
  `max(1, priority_class - floor(wait/600))` **decreases** the numeric value and caps at 1 (= P1),
  so only ascending order is consistent with "P0 > P1 > P2 > P3". The spec text says `DESC`; this has been corrected accordingly (§3.3, §3.4 pseudocode, §9 indexes).
- **`app_now()` instead of `now()`**: semantically identical; only for testability.
- **Added fields**: `tasks.next_attempt_at` (backoff window), `tasks.dead_letter`,
  `task_definitions.retryable_errors`, the `scheduler_config` table,
  `role_instances.agent_profile_version` / `api_profile_ids` (P4 uses only references).
  These are not listed in §9 of the spec but are required by the implementation.
- **Instance state**: `SUSPECT` does not participate in new claims, while in-flight leases continue (as in §5); it is not mixed with lease reclamation.
- **Authentication**: ES256 instance JWTs issued by PCS are implemented (`sub`/`role`/`host_id`/`scopes`);
  the token subject is strongly bound to the `instance_id` in the request, and scopes are checked per endpoint. The transport layer supports native TLS
  and optional mTLS (client certificates), but certificate CN is not mapped to instance identity; automatic token renewal is not implemented yet.
  `AUTH_TOKEN` is only a local-development fallback when no public key is configured.
- **Approval tokens**: v4 does not use the approval chain by default; the signature-verification code remains only for compatibility with old data, and the private key never enters the scheduler.
- **Artifact storage**: local directory + synchronous writes; production can switch to object storage + presigned URLs, and the
  server-side digest check on `complete` stays the same.
- **Paths and parameter placement**: the implementation uses `/v1/...` and still takes `instance_id` from the body for
  `register` / `heartbeat` / `claim`; the spec uses `/api/v1/instances/{instance_id}/...`. Protocol semantics match; path style remains to be unified.
- **config-sync only syncs references**: returns `config_version`, `allowed_task_types`, capabilities and scheduling policy,
  plus `agent {profile_id, version, args}` / `api_profiles[]` references; `resource_profile` is still empty.
  Profile implementations, `base_url` and key values are not in the scheduler.
- **Capability ceiling comes from the registration declaration**: there is no separate PCS configuration table, so `capability_ceiling` takes the declaration from the first registration and freezes it;
  expanding it requires changing configuration and re-registering.
- **Reclamation pace after drain timeout**: on drain timeout the instance is first marked `OFFLINE`, and in-flight leases are reclaimed at their normal expiry;
  release does not race the drain (which would avoid an instance still writing while the scheduler has already redispatched).
- **SSE polls the outbox directly**: no Redis / message queue; each connection checks `event_id > cursor` every 500ms.
  Concurrent transactions may commit in an order different from `event_id` order. The spec's handling: notifications may be lost,
  consumers deduplicate by `event_id`, order by `aggregate_version`, and query `GET /v1/events` when they detect a gap.

## Acceptance mapping

The 51 cases in `npm test` map to spec §13.

- Illegal state-machine transitions rejected; events immutable
- Concurrent claims neither duplicate nor drop (3 instances / 30 tasks / concurrent racing)
- Lease expiry reclamation, startup window timeout, reservation `RECLAIMED`
- Late results from old attempts blocked by `FENCING_STALE`
- Retry backoff, dead letter when retries are exhausted, non-retryable errors fail immediately
- 45s → SUSPECT stops claiming, 90s → OFFLINE, in-flight leases are not reclaimed by the heartbeat sweep
- Aging order, P0 does not age, host PROTECTING stops dispatch, insufficient memory keeps the task QUEUED
- Capabilities can only narrow; drain stops dispatch and heartbeat cannot undo it; drain timeout → OFFLINE; in-flight tasks block deregistration; config-sync 304; token validation
- Outbox written in the same transaction as the task, cursor resumption, append-only enforcement
- Full workflow phase advancement (including APPROVE wait); approval token verification, request binding, digest mismatch, jti replay; instance JWT signature/audience/scope/cross-instance impersonation; `complete` fails when the artifact digest is tampered with
- Non-retryable failure / cancellation terminates the workflow; unknown template 404; approval fails closed without a PCS public key
- Artifact download authorization: the owner can read; instances without a handoff get `403`; the handoff is withdrawn when the attempt ends; incomplete artifacts get `409`
- Workflow advancement accumulates verified upstream artifacts into the downstream task's `requirements.upstream_artifacts` (deduplicated, max 50); the approval phase writes `approval_id` / `approval_subject_digest` / `approved_action_scope`; these fields supplied by the creator are stripped, and handoffs can only be generated by the scheduler
- P4: the claim envelope contains only Agent/API Profile references, not implementations, addresses or keys; config-sync returns `agent` references and `api_profiles[]`; switching Agents only changes the references registered by the instance, with no change to task definitions or scheduling code

## P2 three-process acceptance

Beyond unit tests, [../scripts/e2e-p2.sh](../scripts/e2e-p2.sh) runs the full "scheduler + Host Runtime admission + two role instances" chain on a real machine, covering:

- Two instances claim concurrently and each task executes exactly once (an admission denial does not count as duplicate execution)
- Admission denial: the task returns to the queue, `attempt_count` is unchanged, and the instance backs off by the claim interval instead of hammering the same task
- `kill -9` a role instance → lease expiry reclamation → another instance reclaims (fencing+1) → the old result gets `409 FENCING_STALE`
- Scheduler restart during execution: the task completes normally, with one attempt and one dispatch
- No orphan reservations; a crashed instance releases leftover Host Runtime task grants after restart

The script uses `_clock` time travel to verify lease expiry (+602s each time), **test databases only**;
for a clean environment, stop the role instances first, then run `scheduler/scripts/reset.sh`.

## v4 build loop

v4 has a single workflow, `wft_build`: the scheduler dispatches `task.build` → the builder runs
`requirements.build.command` inside the container → uploads the log artifact → the workflow reaches `COMPLETED`.

```bash
# build
curl -X POST http://127.0.0.1:7801/v1/tasks -H 'content-type: application/json' \
  -d '{"task_type":"task.build","priority":2,
       "requirements":{"build":{"command":"make test","workdir":"."}}}'
# terminal (full shell inside the container)
curl -X POST http://127.0.0.1:7801/v1/tasks -H 'content-type: application/json' \
  -d '{"task_type":"task.console.builder","requirements":{"console":{"command":"uname -a"}}}'
```

A failed `task.build` keeps the log artifact and reports `BUILD_FAILED` / `BUILD_TIMEOUT`; `task.console.*`
uses `max_attempts=1` and is never retried blindly.

## P4 Agent/API acceptance

[../scripts/e2e-p4.sh](../scripts/e2e-p4.sh) verifies the P4 acceptance gates on a real machine:

- **Switching Agents within a role requires no code changes**: PCS rebinds `builder-ubuntu22-a` from `agp_builder_alpha` to `agp_builder_beta`,
  updating only the instance configuration and rolling restarts; the two artifact markers are `alpha` / `beta` respectively, and the scheduler only updates the profile reference
- **The envelope carries only references**: task records and attempt results contain no `entrypoint`, `base_url` or plaintext keys
- **Unauthorized tool calls are rejected**: `demo.forbidden` is not in the profile allowlist → `TOOL_NOT_ALLOWED`, and audit records DENY
- **Egress is denied by default**: an API profile pointing at `169.254.169.254` is blocked by `EGRESS_IP_BLOCKED`,
  even if that address is in the egress allowlist
- **APIs must go through the local proxy**: the upstream only accepts the Bearer injected by the adapter; a direct connection from the Agent gets 401
- **Quota**: with profile `rpm=2`, the third call through the local proxy returns 429
- **Secret instance isolation**: builder A's JWT cannot resolve builder B's `secret_ref` (`SECRET_NOT_ALLOWED`);
  revoking an instance immediately yields `INSTANCE_REVOKED`
- **Agent crash**: after the adapter exits, role-agent stays `ONLINE` and the task fails with `AGENT_CRASHED` (retryable)

The script resets the demo database and starts PCS/Secret Store/mock upstream along with it; after it finishes, `builder-ubuntu22-a`
keeps the beta binding, so to return to purely deterministic builds, unbind the profile first or clear `profiles_file` in `runtime.config.json`.
