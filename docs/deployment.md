# Deployment

> English · [简体中文](deployment.zh-CN.md)

> Version: v4.3 · 2026-11-12
> One path: PCS + host-runtime. `scripts/deploy.sh` starts the control plane (PostgreSQL + PCS + UI) on one
> machine; additional hosts are added from the UI.

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

PCS, host-runtime and the admin app need Node; Docker is required for PostgreSQL and for the containers
host-runtime creates on each host.

---

## 2. Deploy

One path: PCS + host-runtime. Start the control plane on one machine with one script, then add hosts and deploy
schedulers/builders from the UI. `scripts/deploy.sh` is idempotent.

### 2.1 Start the control plane

```bash
scripts/deploy.sh
```

The script:

1. starts a local PostgreSQL container (unless `PCS_DATABASE_URL` is set);
2. generates the PCS signing keys and the SSH credential key (`~/.config/platform/pcs-credential.key`);
3. installs dependencies, builds the admin app and the deployment payload;
4. prepares the host cache (`~/.platform/cache`: Linux Node, openssh debs, optional CLIs);
5. migrates the database and starts PCS, which serves the admin app itself (`PCS_WEB_DIR`).

Open `http://127.0.0.1:7901`, register the first account (it becomes the administrator), add this machine as a
local host, start its runtime, then deploy a scheduler and builders.

For remote hosts, start with `PCS_HOST=0.0.0.0 PCS_RUNTIME_URL=http://<lan-ip>:7901` and add them over SSH.
PCS runs in the foreground; Ctrl+C stops it. Environment knobs: `PCS_PORT`, `PCS_DATABASE_URL`,
`PCS_SCHEDULER_DATABASE_URL`, `PCS_IMAGE_ALLOWLIST`, `PCS_REGISTRATION`, `PCS_SESSION_HOURS`.

Admin tokens are issued with `npm run pcs -- admin-token --operator <name>`; they remain available for automation.
The admin app itself signs in with accounts: the first registered account becomes the administrator, later
registrations wait for approval (`PCS_REGISTRATION=approval`, the default).

### 2.2 Onboard a Host

1. **Local host**: the machine where PCS runs; probed directly, no SSH needed.
2. **SSH host**: fill in address, port, user, and private key; the key is encrypted into the database, and the API returns only the fingerprint.
3. **Start runtime**: PCS writes the host-runtime bundle to `$HOME/.platform/host-runtime/<host_id>/`
   and starts it with a one-time registration token; once the host is onboarded its status becomes ONLINE.
4. **Deploy scheduler / builders**: the deployment plan lands on the selected host, and containers are created by that host's host-runtime.

Remote host prerequisites: Docker Engine, Docker accessible to the current user, reachability of `PCS_RUNTIME_URL`, and Node 22+.

### 2.3 Deployment Payload and Host Cache

Neither the scheduler nor the builder builds an image: official ubuntu (pinned digest) + a runtime payload written at deployment time.

```bash
node scripts/build-app-payload.mjs
# output: deploy/scheduler/app/ and deploy/builder/app/, synced to PCS's
# PCS_SCHEDULER_APP_DIR / PCS_BUILDER_APP_DIR (default <pcs>/app/{scheduler,builder})
```

Node, Claude Code, and the openssh debs are placed in the host cache `~/.platform/cache/` and mounted read-only at
`/opt/platform/cache`. Prepare it once; see [deploy/README.md](../deploy/README.md#bare-os-images--host-cache-scheduler-and-builder).

### 2.4 Admin app for development

The deployed control plane already serves the built app, so this is only for frontend work:

```bash
cd admin-app
npm install
npm run dev
```

The dev proxy forwards `/api/pcs` to `http://127.0.0.1:7901` and `/api/scheduler` to
`http://127.0.0.1:8443`; override with `VITE_PCS_TARGET` / `VITE_SCHEDULER_TARGET`. Sessions are HttpOnly
cookies with a CSRF token, so no shared token is written to `.env.local`.

---

## 4. Ports and Network

| Port | Purpose | Recommendation |
|---|---|---|
| 7901 | PCS management plane | Reverse proxy + TLS; internal network only |
| 8443 | Scheduler API | Reverse proxy + TLS; internal network only |
| 2200 | Scheduler SSH | Internal network / VPN |
| 2222–2231 | Builder SSH | Internal network / VPN |
| 55432 | PostgreSQL (`scripts/deploy.sh`) | Published so scheduler containers can reach it; internal network only |

The admin app is served by PCS on 7901. Never expose it to the public internet; for public access use sideload tokens.

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
