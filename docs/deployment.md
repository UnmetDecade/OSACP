# Deployment

> English · [简体中文](deployment.zh-CN.md)

> Version: v4.3 · 2026-11-12
> Two paths: single-machine Compose to get the loop running; PCS + host-runtime to manage multiple hosts.

---

## 1. Minimum Requirements

| Item | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores | 8 cores |
| Memory | 8 GB | 16–32 GB |
| Disk | 60 GB SSD | 200 GB SSD |
| OS | Ubuntu 22.04+ / Debian 12+ | Ubuntu 24.04 |
| Docker | 24+, with the compose plugin | Latest stable |
| Node | 22+ (PCS, host-runtime, admin app) | 22 LTS |

Single-machine Compose only needs Docker; the multi-host control plane needs Node runnable on PCS and on every host.

---

## 2. Path A: Single-Machine Compose

`deploy/compose.yaml` is the single source of truth; it brings up PostgreSQL + the scheduler + four
builders on Ubuntu 20/22/24/26. For the full preparation steps see [deploy/README.md](../deploy/README.md); the shortest path:

```bash
cd deploy
cp .env.example .env                 # set POSTGRES_PASSWORD; model credentials can stay empty
mkdir -p keys tokens data/postgres data/artifacts

# host login public keys: the sshd inside the container accepts keys only
ssh-keygen -t ed25519 -N "" -f keys/scheduler
ssh-keygen -t ed25519 -N "" -f keys/builder
for os in 20 22 24 26; do cp keys/builder.pub "keys/builder$os.pub"; done

docker compose -f compose.yaml --env-file .env up -d --build
```

After startup:

| Entry | Address |
|---|---|
| Scheduler API | `http://<host>:8443` |
| Scheduler SSH | `ssh root@<host> -p 2200` |
| Builder SSH | `ssh root@<host> -p 2222–2225` |

The scheduler migrates and seeds automatically. Builders register with `http://scheduler:8443`; instance JWTs are placed in
`deploy/tokens/<instance_id>.jwt` and read through the read-only volume `/opt/platform/tokens`.

---

## 3. Path B: PCS + host-runtime (Multiple Hosts)

The control plane separates **desired state** from **actual state**: PCS writes the deployment plan and issues signed
commands, host-runtime executes them on the host, and the admin app reads and writes only the PCS and scheduler APIs.

### 3.1 Start PCS

```bash
cd pcs-issuer
npm install
npm run keygen          # ES256 JWT key + Ed25519 command-signing key (kept if already present)
npm run migrate         # create the platform_control database

PCS_HOST=0.0.0.0 \
PCS_RUNTIME_URL=http://pcs.example:7901 \
PCS_CREDENTIAL_KEY_FILE=$HOME/.config/platform/pcs-credential.key \
PCS_IMAGE_ALLOWLIST=docker.io/library/ \
npm start
```

`PCS_CREDENTIAL_KEY_FILE` is a 32-byte key (0600) used for AES-256-GCM encryption of host SSH private keys;
if it is not configured, only the local host can be onboarded. Generate it once:

```bash
umask 077 && openssl rand -out ~/.config/platform/pcs-credential.key 32
```

Admin tokens are issued with `npm run pcs -- admin-token --operator <name>`, and the admin app uses one via
`PCS_ADMIN_TOKEN`.

### 3.2 Onboard a Host

1. **Local host**: the machine where PCS runs; probed directly, no SSH needed.
2. **SSH host**: fill in address, port, user, and private key; the key is encrypted into the database, and the API returns only the fingerprint.
3. **Start runtime**: PCS writes the host-runtime bundle to `$HOME/.platform/host-runtime/<host_id>/`
   and starts it with a one-time registration token; once the host is onboarded its status becomes ONLINE.
4. **Deploy scheduler / builders**: the deployment plan lands on the selected host, and containers are created by that host's host-runtime.

Remote host prerequisites: Docker Engine, Docker accessible to the current user, reachability of `PCS_RUNTIME_URL`, and Node 22+.

### 3.3 Deployment Payload and Host Cache

Neither the scheduler nor the builder builds an image: official ubuntu (pinned digest) + a runtime payload written at deployment time.

```bash
node scripts/build-app-payload.mjs
# output: deploy/scheduler/app/ and deploy/builder/app/, synced to PCS's
# PCS_SCHEDULER_APP_DIR / PCS_BUILDER_APP_DIR (default <pcs>/app/{scheduler,builder})
```

Node, Claude Code, and the openssh debs are placed in the host cache `~/.platform/cache/` and mounted read-only at
`/opt/platform/cache`. Prepare it once; see [deploy/README.md](../deploy/README.md#bare-os-images--host-cache-scheduler-and-builder).

### 3.4 Start the Admin App

```bash
cd admin-app
npm install
printf 'PCS_ADMIN_TOKEN=%s\n' '<admin-jwt>' > .env.local   # 0600, already gitignored
npm run dev
```

The dev proxy forwards `/api/pcs` to `http://127.0.0.1:7901` and `/api/scheduler` to
`http://127.0.0.1:8443`; override with `VITE_PCS_TARGET` / `VITE_SCHEDULER_TARGET`.
For a production build, run `npm run build` and have a reverse proxy serve the static files and forward the two API prefixes.

---

## 4. Ports and Network

| Port | Purpose | Recommendation |
|---|---|---|
| 7901 | PCS management plane | Reverse proxy + TLS; internal network only |
| 8443 | Scheduler API | Reverse proxy + TLS; internal network only |
| 2200 | Scheduler SSH | Internal network / VPN |
| 2222–2231 | Builder SSH | Internal network / VPN |
| 5432 | PostgreSQL | Not mapped |

If the admin app is accessed over the public internet, you must put Caddy/Nginx + HTTPS + basic auth/VPN in front of it.

---

## 5. Backup

Required:

- PostgreSQL: `pg_dump` once daily, retained for 7 days. Back up both the scheduler database and `platform_control`.
- Builder workspace volumes: optional (code can be rebuilt from the repository).
- `.env`, `keys/`, `~/.config/platform/pcs-credential.key`: store offline.

`scripts/backup-restore.sh backup OUTDIR` dumps both databases, compares row counts, and writes SHA256SUMS;
`restore` only restores into a separately suffixed database and never overwrites the source.

---

## 6. Upgrade

```bash
# single-machine Compose
docker compose pull
docker compose up -d scheduler
docker compose exec scheduler npm run migrate
docker compose restart builder-ubuntu22   # restart builders one by one

# control plane
cd pcs-issuer && npm run migrate && npm start
node scripts/build-app-payload.mjs        # rebuild the payload, then re-apply deployment plans
```

- Schedulers and builders can be upgraded independently.
- Database migrations are backward compatible; there is no automatic rollback.
- Back up PostgreSQL before upgrading.

---

## 7. Common Failures

| Symptom | Resolution |
|---|---|
| Builder stuck in STARTING | `docker logs`; check the instance JWT, `SCHEDULER_URL`, and connectivity to the scheduler |
| Task stuck in QUEUED | Check builder capability, OS requirements, concurrency limits, and leases |
| SSH won't connect | Confirm the host port mapping, `authorized_keys` permissions 600, and whether sshd is running |
| Host stuck OFFLINE | Check `PCS_RUNTIME_URL`, whether the registration token has expired, and host-runtime logs |
| Scheduler deployment reports `ROOT_SCHEDULER_EXISTS` | The host already has a root scheduler; add a child scheduler under that root instead |
| Disk full | Clean `/opt/platform/workspace` and artifacts; expand the volume |

---

## 8. Acceptance Checklist

- [ ] The four containers in single-machine Compose are healthy, or the host is ONLINE in PCS.
- [ ] The admin app can connect to PCS and the scheduler and see builders.
- [ ] A `task.build` can be submitted and reaches SUCCEEDED.
- [ ] You can SSH into any builder (key-only).
- [ ] After stopping a builder, the task is requeued.
- [ ] The backup script runs and can restore.
