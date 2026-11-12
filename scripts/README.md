# Acceptance and Operations Scripts

> English · [简体中文](README.zh-CN.md)

These scripts are for **test environments only**: they create databases, reset demo data, and start or stop local processes,
and some actions depend on the Docker container `pg-sched`. Do not run them directly against a control plane that carries
real business workloads, and read the header notes in each script before running it.

## Acceptance Scripts

| Script | Phase | Coverage |
|---|---|---|
| `e2e-p2.sh` | P2 | Registration, claim, leases, fencing, reclaim, retry, and queue stats (two builder instances) |
| `e2e-p4.sh` | P4 | Agent Profile, API Profile, Secret references, Tool Policy Guard, egress denial |

The four-role loop, approval, and TLS/backup/load acceptance scripts from the v3 era were retired along with the deleted roles and no longer apply.

## Supporting Scripts

| Script | Purpose |
|---|---|
| `build-app-payload.mjs` | Build the deployment payloads for the scheduler and builder into `deploy/{scheduler,builder}/app/` (esbuild bundle + SQL + entry script); the image stays official ubuntu |
| `pki.sh OUTDIR [extra DNS/IP...]` | Generate an internal CA, PCS/scheduler/Secret Store server certificates, and a shared client certificate; outputs 0600 private keys and can be re-run |
| `backup-restore.sh backup OUTDIR` | `pg_dump -Fc` both databases, package artifacts, and write a row-count manifest and SHA256SUMS; directory 0700 |
| `backup-restore.sh restore BACKUP_DIR [suffix]` | Restore into a separately suffixed database (default `_restore`), compare key table row counts, without overwriting the source |
| `backup-restore.sh verify BACKUP_DIR` | Verify backup file digests and compare the current database against the backup manifest |
| `load-test.mjs` | Submit N `task.build` tasks to the scheduler, report p50/p95/max and throughput, and sample `/proc/meminfo`, `VmRSS`, and `oom_kill` |
| `p4-mock-upstream.mjs` | Local API upstream for P4 acceptance, with authentication and quota behavior |
| `seed-cli-agents.mjs` | Register the Claude Code / Codex CLI Agent Profiles with PCS; `--dry-run` only prints, and `--bind <instance>:<provider>` binds after creation. The image must be pinned by digest and be in the PCS allowlist |
| `../agents/test-cli-agent.mjs` | Protocol-level tests for the CLI Agent adapter (stub CLI, no real model or credentials needed) |

### load-test Environment Variables

```bash
SCHEDULER_URL=http://127.0.0.1:7801 \
COUNT=100 \
TASK_TYPE=task.build \
TIMEOUT_SECONDS=300 \
MONITOR_PIDS=12345,12346 \
node scripts/load-test.mjs
```

Only task status and `/proc` counters are read; it does not touch secrets or audit bodies. It exits with a non-zero code
if tasks do not all complete or if the `oom_kill` delta is greater than 0.

## Backup Script Defaults

| Variable | Default | Description |
|---|---|---|
| `PG_MODE` | `docker` | `docker` uses the `pg-sched` container; `local` uses the local `psql`/`pg_dump` |
| `PG_CONTAINER` | `pg-sched` | Docker container name |
| `SCHED_DB` / `PCS_DB` | `scheduler` / `platform_control` | Source databases |
| `ARTIFACT_DIR` | `$HOME/scheduler/data/artifacts` | Optional artifact directory to package |
| `PG_USER` / `PGPASSWORD` | `postgres` / `sched_dev_pw` | Test-environment defaults only |

Backups include audit and business data but **do not include** JWTs, command private keys, or Secret Store secret values;
confirm the target database suffix before restoring—the script never overwrites the source database.

## CLI Agent Profile

```bash
ADMIN_TOKEN=... \
AGENT_IMAGE=registry.example/agents/claude@sha256:<64hex> \
PLATFORM_DIR=/opt/platform \
AGENT_NODE=node \
AGENT_PASS_ENV=ANTHROPIC_API_KEY \
node scripts/seed-cli-agents.mjs --bind builder-ubuntu22-a:claude
```

- Tokens are read from environment variables only, and are never written into scripts, URLs, or output.
- `AGENT_PASS_ENV` lists variable names only; when it is unset, provider defaults apply: Claude Code passes through
  `ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL`, and Codex passes through `DEEPSEEK_API_KEY,CODEX_HOME`.
- There is another pass-through layer from the container environment to the Agent adapter: `PLATFORM_AGENT_PASS_ENV` (see `deploy/README.md`).
- External CLIs do not inherit the host environment by default, preventing unrelated credentials from being read by the Agent.
- The target host must already have the corresponding CLI installed; if it is missing, the task fails with `AGENT_NOT_READY` and does not silently fall back to the deterministic executor.
- The Profile's `version` defaults to the local `<cli> --version` (e.g. `2.1.322` / `0.167.1`), so that the UI's
  "Claude Code · builder · v2.1.322" matches the CLI in the image; when the seeding upstream machine has no CLI installed,
  specify it explicitly with `AGENT_CLAUDE_VERSION` / `AGENT_CODEX_VERSION`.
- Registration only changes the PCS control plane; Host Runtime requires a rolling restart of instances to load the new Agent.
- The execution path is independent of the `.claude`/`.codex` user directories: the Adapter points `HOME` at the one-off task workspace.
