# pcs-issuer · Platform Control Plane (PCS)

> English · [简体中文](README.zh-CN.md)

PCS is the platform control plane: host registry, deployment plans, signed commands, Agent/API profiles, Secret Store integration and audit.
It does not operate Docker directly; every container action is delivered as a signed command to host-runtime on the target host.

See [../docs/federation.md](../docs/federation.md) and [../docs/architecture.md](../docs/architecture.md).

## Boundaries

- Private keys live only here (`keys/private.pem`, `keys/command-private.pem`, 0600) and
  **never enter the scheduler, Host Runtime, role containers or logs**.
- Host Runtime only receives `command-public.pem` to verify deployment intents; the scheduler only receives `public.pem` to verify JWTs.
- No user login, no OIDC, no approval-center UI; the admin app uses `PCS_ADMIN_TOKEN` to reach the admin side.
- No JWKS endpoint or key rotation; public keys are distributed as files.
- Single control plane, not HA; PostgreSQL listens on localhost only and is not exposed to the WAN.
- Native TLS and optional mTLS (client certificates) are supported; Bearer `host_token` / admin JWT are still validated on every request —
  transport identity does not replace token identity.
- Automatic issuance and 90-day rotation of host certificates are not implemented yet: client certificates are currently provisioned by `scripts/pki.sh`,
  and enrollment only issues a `host_token`, not a certificate; production needs certificate lifecycle management or an enterprise CA.

## Preparation

```bash
npm install
npm run keygen     # generate ES256 JWT keys + Ed25519 command-signing keys (kept if present; --force overwrites)
npm run migrate    # create the database (if missing) and apply sql/001_init.sql + sql/002_profiles.sql
```

The database defaults to `postgres://postgres:sched_dev_pw@127.0.0.1:5432/platform_control`;
override it with `PCS_DATABASE_URL`. The admin and scheduler test databases are separate and do not affect each other.

## Issuance (scheduler-side tokens)

```bash
# instance token (24h)
npm run issue -- instance --id builder-a --role builder --host host-a \
  --out ../host-runtime/run/tokens/builder-a.jwt

# approval token (10 minutes, bound to request + subject digest + action scope)
npm run issue -- approval --request aprq_xxx --operator alice \
  --digest sha256:... --scope svn.commit --out /tmp/approval.jwt

# admin token (8h, only for the admin CLI below)
npm run issue -- admin --operator alice --out /tmp/admin.jwt
```

An instance's scope determines which endpoints it can call: `instance:register`, `instance:claim`, `task:report`,
`config:read`, `artifact:write`, `artifact:read`. Approval tokens always carry `approval:decide`.
The approval token claims map one-to-one to the scheduler's binding checks: `approval_request_id`, `operator_id`,
`subject_digest`, `action_scope`; `jti` is unique in the database and cannot be replayed.

Scheduler side:

```bash
PCS_PUBLIC_KEY_FILE=$PWD/../pcs-issuer/keys/public.pem npm start
```

## Admin side (Host Runtime)

Startup:

```bash
PCS_IMAGE_ALLOWLIST=docker.m.daocloud.io/library/ \
PCS_NETWORK_POLICIES=default \
npm start
```

Listens on `127.0.0.1:7901` by default; only Host Runtime should be able to reach it.

TLS / mTLS:

```bash
../scripts/pki.sh /secure/pki
PCS_TLS_CERT_FILE=/secure/pki/pcs.crt \
PCS_TLS_KEY_FILE=/secure/pki/pcs.key \
PCS_TLS_CA_FILE=/secure/pki/ca.crt \
PCS_MTLS=1 \
PCS_PUBLIC_URL=https://pcs.internal:7901 \
npm start
```

| Environment variable | Default | Description |
|---|---|---|
| `PCS_TLS_CERT_FILE` | unset | Server certificate; must be configured together with `PCS_TLS_KEY_FILE` |
| `PCS_TLS_KEY_FILE` | unset | Server private key |
| `PCS_TLS_CA_FILE` | unset | CA for client certificate verification; required when mTLS is enabled |
| `PCS_MTLS` | unset | Set to `1` to require client certificates |
| `PCS_PUBLIC_URL` | inferred from the request | Public base URL, used for the admin URL in the enroll response; must be set explicitly when behind a proxy |

Certificate SANs must include the address Host Runtime actually uses. Client certificates are shared transport credentials;
host identity still comes from the `host_token` obtained at enrollment, and revoking a host does not revoke its certificate.

### Multi-host onboarding

Local hosts and SSH hosts use the same deployment channel; the only difference is how the "bootstrap" step delivers host-runtime:

| Environment variable | Default | Description |
|---|---|---|
| `PCS_CREDENTIAL_KEY_FILE` | unset | 32-byte key file (0600) used to encrypt SSH private keys with AES-256-GCM; without it only local hosts can be added |
| `PCS_RUNTIME_SOURCE_DIR` | `../../host-runtime` | Source directory of host-runtime, bundled with esbuild during bootstrap |
| `PCS_RUNTIME_URL` | unset | Address remote hosts use to reach PCS, e.g. `http://pcs.example:7901`; local hosts always use `127.0.0.1` |
| `PCS_RUNTIME_NODE` | `node` | Path to the Node 22+ executable on remote hosts |
| `PCS_HOST` | `127.0.0.1` | Set to `0.0.0.0` when remote hosts need to enroll (or put it behind a reverse proxy) |
| `PCS_NETWORK_POLICY_MAP` | unset | JSON mapping from policy names to Docker network names, e.g. `{"default":"platform-net"}`; written when bootstrapping host-runtime; when a policy is not listed, `default` falls back to `bridge` |
| `PCS_SCHEDULER_IMAGE` | unset | Scheduler container image (digest-pinned); if unset, uses the selected Agent Profile's `artifact_image` |
| `PCS_SCHEDULER_DATABASE_URL` | unset | Database address for the scheduler container, injected by PCS into the deployment plan and never shown in the admin UI |
| `PCS_SCHEDULER_URL` | unset | Address builder containers use to reach the scheduler API, e.g. `http://platform-scheduler:8443`; PCS injects `SCHEDULER_URL`; when missing, builder deployment plan validation fails |
| `PCS_SCHEDULER_SYNC_URL` | same as `PCS_SCHEDULER_URL` | Address PCS itself uses to reach the scheduler (host perspective, e.g. `http://127.0.0.1:8443`); hosts push status and resources to the scheduler's `/v1/hosts` on report, and the scheduler uses that for dispatch admission |

```bash
umask 077 && openssl rand -out ~/.config/platform/pcs-credential.key 32

PCS_HOST=0.0.0.0 \
PCS_RUNTIME_URL=http://pcs.example:7901 \
PCS_CREDENTIAL_KEY_FILE=$HOME/.config/platform/pcs-credential.key \
PCS_IMAGE_ALLOWLIST=docker.m.daocloud.io/library/ \
npm start
```

- `POST /hosts/local` idempotently registers the machine running PCS; bootstrap runs locally using PCS's own node.
- `POST /hosts/ssh` accepts a PEM / OpenSSH private key, encrypts and stores it, then probes immediately; the endpoint only returns
  `key_fingerprint`, and there is no endpoint to read the private key back.
- Probing and bootstrapping use the system `ssh` client: the private key is written to a 0600 temporary file, with `BatchMode=yes`,
  `IdentitiesOnly=yes`, an isolated temporary `known_hosts`, and a 20-second timeout.
- `POST /hosts/:id/bootstrap` first fills in the remote environment, then writes to `$HOME/.platform/host-runtime/<host_id>/`
  and starts it, waiting up to 20 seconds for enrollment: returns 200 if online, otherwise 202 with the bootstrap log. Repeated calls only restart that directory.
- Environment setup: if Node 22 is missing, install it from npmmirror into `$HOME/opt` (no sudo needed); if Docker is missing, install it with
  `apt-get install docker.io` and run `usermod -aG docker`. For password-authenticated hosts, the same password is passed to
  `sudo -S` over stdin (never on the command line); with key-only access and sudo not passwordless, the endpoint returns
  `BOOTSTRAP_ENV_FAILED`, explaining whether Node or Docker is missing and why it could not be installed.
- Remote hosts still need to reach `PCS_RUNTIME_URL`; images must still be digest-pinned and fall within
  `PCS_IMAGE_ALLOWLIST` prefixes.

| Method | Path | Authentication | Description |
|---|---|---|---|
| POST | `/api/v1/platform/hosts` | admin `host:admin` | Create a host and return a one-time enrollment token (10 minutes, single use) |
| POST | `/api/v1/platform/hosts/local` | admin `host:admin` | Register and probe the local host running PCS (idempotent) |
| POST | `/api/v1/platform/hosts/ssh` | admin `host:admin` | Create a remote host from an SSH private key; the key is encrypted at rest, only the fingerprint is returned |
| POST | `/api/v1/platform/hosts/:id/probe` | admin `host:admin` | Probe OS / Docker / connectivity, read-only |
| POST | `/api/v1/platform/hosts/:id/bootstrap` | admin `host:admin` | Install and start host-runtime; 200 if already enrolled, otherwise 202 |
| GET | `/api/v1/platform/hosts/:id` | admin `host:read` | Host details: connection method, fingerprint, latest probe, deployments |
| POST | `/api/v1/platform/hosts/enroll` | enrollment token | Exchange for `host_id` + host JWT (24h) + command public key |
| GET | `/api/v1/platform/hosts` | admin `host:read` | Host list and latest reports |
| POST | `/api/v1/platform/hosts/:id/revoke` | admin `host:admin` | Revoke: deny authentication, deployments and further commands |
| POST | `/api/v1/platform/deployments` | admin `deployment:write` | Create a deployment intent (signed DEPLOY command) |
| GET | `/api/v1/platform/deployments` | admin `deployment:read` | Deployments with desired/actual state |
| POST | `/api/v1/platform/deployments/:id/{start,stop,restart,remove}` | admin `deployment:write` | Send an action command |
| POST | `/api/v1/platform/runtime/heartbeat` | host JWT | Heartbeat and host status |
| GET | `/api/v1/platform/runtime/commands?wait=30` | host JWT | Long-poll for commands (204 when there are none) |
| POST | `/api/v1/platform/runtime/commands/:id/ack` | host JWT | Idempotently acknowledge the execution result |
| POST | `/api/v1/platform/runtime/report` | host JWT | Report runtime/resource/container actual state |
| POST | `/api/v1/platform/runtime/token/renew` | host JWT | Renew the host JWT |

Command security properties:

- **Ed25519 signature** covers canonical JSON (sorted keys, no whitespace); Host Runtime rejects any command that fails verification.
- **Pinned digest**: images must have the form `repo@sha256:<64 hex>` and fall within a `PCS_IMAGE_ALLOWLIST` prefix.
- **Monotonic generation**: every change to the same instance increments it by 1; old commands are discarded by Host Runtime with `STALE_GENERATION`.
- **Idempotent command_id**: retries after a timeout are deduplicated by Host Runtime and not executed twice.
- **No blind retries on failure**: exceeding `PCS_COMMAND_MAX_ATTEMPTS` marks the command FAILED and requires a new deployment intent.
- **No credentials in commands**: env keys matching `secret/token/password/credential/private_key` are rejected outright;
  volumes must be named volumes, and mount points must live under `/opt/platform/`.
- **Immediate revocation**: a REVOKED host cannot authenticate, create deployments or receive actions; containers already running are not killed by PCS.

### Admin CLI

```bash
export PCS_ADMIN_TOKEN=$(npm run --silent issue -- admin --operator alice)
export PCS_URL=http://127.0.0.1:7901

npm run pcs -- host-add --name ubuntu22
npm run pcs -- host-list
npm run pcs -- deploy --host hst_xxx --role builder \
  --image registry.example/builder@sha256:... \
  --cpu 0.5 --memory-mib 512 --command sleep,3600 \
  --env ROLE_ID=builder --volume workspace:/opt/platform/workspace
npm run pcs -- deployments --host hst_xxx
npm run pcs -- action --deployment dep_xxx --action stop
npm run pcs -- host-revoke --host hst_xxx
```

Enrollment tokens are printed only once; pass them directly to Host Runtime's `PCS_ENROLLMENT_TOKEN`, and do not write them to config files or logs.

## Agent / API profiles (P4)

PCS stores Agent and API **configuration and references**: the tables contain only `secret_ref`, **never any key values**.
Host Runtime obtains the runtime view (adapter, entrypoint, base_url, secret_ref) via `resolve`;
key values can only be exchanged by an instance using its own JWT against the Secret Store.

### Endpoints

| Method | Path | Authentication | Description |
|---|---|---|---|
| POST | `/api/v1/platform/agent-profiles` | admin `profile:write` | Create an Agent Profile (role/adapter matrix, image digest, tool and task-type allowlists) |
| GET | `/api/v1/platform/agent-profiles` | admin `profile:read` | List |
| PATCH | `/api/v1/platform/agent-profiles/:id` | admin `profile:write` | Modify or enable/disable; the role cannot be changed |
| DELETE | `/api/v1/platform/agent-profiles/:id` | admin `profile:write` | Delete; `409 PROFILE_IN_USE` while still bound to an instance |
| POST | `/api/v1/platform/api-profiles` | admin `profile:write` | Create an API Profile (https-only, `secret://` references, quota, egress, fallback) |
| GET | `/api/v1/platform/api-profiles` | admin `profile:read` | List |
| PATCH | `/api/v1/platform/api-profiles/:id` | admin `profile:write` | Modify or enable/disable; the type cannot be changed |
| DELETE | `/api/v1/platform/api-profiles/:id` | admin `profile:write` | Delete; `409 PROFILE_IN_USE` when referenced by an instance, Agent or fallback |
| PUT | `/api/v1/platform/api-profiles/:id/secret` | admin `profile:write` | Write the API key for this Profile: forwarded to the Secret Store; PCS does not persist or echo it; `503` when no Secret Store is configured |
| GET | `/api/v1/platform/bindings` | admin `profile:read` | Agent / API bindings for all instances |
| POST | `/api/v1/platform/instances/:id/bind-agent` | admin `profile:write` | Bind an Agent; body `{agent_profile_id, role_id}`; cross-role binding is rejected |
| POST | `/api/v1/platform/instances/:id/bind-api` | admin `profile:write` | Bind an API |
| DELETE | `/api/v1/platform/instances/:id/bind-api/:api` | admin `profile:write` | Unbind an API |
| GET | `/api/v1/platform/instances/:id/resolve` | admin `profile:read` | Runtime view; `404 BINDING_NOT_FOUND` when unbound; **contains no key values** |
| GET | `/api/v1/platform/audit-logs?limit=` | admin `profile:read` | Profile create, bind and unbind audit |

Admin scopes gain `profile:read` / `profile:write`.

### CLI

```bash
export PCS_ADMIN_TOKEN=$(npm run --silent pcs -- admin-token --operator alice)

npm run pcs -- agent-profile-add --role builder --name demo-alpha --version 1.0.0 \
  --image registry.example/agents/demo@sha256:... \
  --allowed-tools demo.echo,api.call --task-types task.agent.probe \
  --entrypoint /usr/bin/node,/opt/agents/demo.mjs,--marker=alpha
npm run pcs -- agent-profiles

npm run pcs -- api-profile-add --name mock --kind tool \
  --base-url http://127.0.0.1:18090 --secret-ref secret://apis/mock \
  --quota '{"rpm":2}' --egress egress-mock --scopes probe.read
npm run pcs -- api-profiles

npm run pcs -- bind-agent --instance builder-a --agent agp_xxx --role builder
npm run pcs -- bind-api --instance builder-a --api api_xxx
npm run pcs -- resolve --instance builder-a
npm run pcs -- audit --limit 20
```

`api.egress` is only a policy **name**; the actual allowlist lives in Host Runtime's `runtime.config.json`
(`egress_policies`), and PCS does not store the network policy itself.

Development environments must explicitly opt in to API profiles on loopback `http://127.0.0.1`:

```bash
PCS_ALLOW_INSECURE_API_URLS=1 npm start
```

In production, do not set this variable; profiles only accept `https`. Secret references must have the form `secret://<path>`;
putting a plaintext key in `secret_ref`, `base_url` or env is rejected outright.

Entering an API key directly in the console requires a Secret Store:

```bash
PCS_SECRET_STORE_URL=http://127.0.0.1:7902 \
PCS_SECRET_STORE_ADMIN_TOKEN=<the Secret Store's SECRET_STORE_ADMIN_TOKEN> \
npm start
```

`PUT /api-profiles/:id/secret` only forwards the value to the Secret Store (`PUT /v1/secrets`);
PCS's database, logs and responses contain only `secret_ref`. When it is not configured, the endpoint returns
`503 SECRET_STORE_NOT_CONFIGURED`, and the UI can still take just a reference.

## Tests

```bash
npm test        # automatically migrates platform_control_test, then runs
```

Covers: one-time/expiring enrollment tokens, admin scopes, signature and image/grant validation, long polling and idempotent acknowledgement,
reports driving HEALTHY/MISSING, revocation, per-host isolation; plus P4's Agent role/adapter matrix,
digest-pinned images, `secret_ref`-only storage, API profile https-only,
cross-role binding rejection, `resolve` without key values, and profile audit (11 cases).
