# Deployment assets

> English · [简体中文](README.zh-CN.md)

In v4 both the scheduler and the builders are containers; this directory is a reference implementation you can build directly.

| File | Purpose |
|---|---|
| `compose.demo.yaml` | One-command demo: PostgreSQL + PCS + scheduler + one builder + the admin UI |
| `builder/Dockerfile` | Builder image used by the demo (control-plane deployments use bare ubuntu) |
| `builder/entrypoint.sh` | Demo image entrypoint |
| `builder/app-entrypoint.sh` | Bare-ubuntu builder entrypoint: pulls Node/CLI/ssh from the host cache, starts the instance runtime |
| `scheduler/Dockerfile` | Scheduler image used by the demo (control-plane deployments use bare ubuntu) |
| `scheduler/entrypoint.sh` | Demo image entrypoint |
| `scheduler/app-entrypoint.sh` | Bare-ubuntu scheduler entrypoint: pulls Node/CLI/ssh from the host cache, migrates and starts |
| `demo-initdb.sql` | Creates the scheduler database in the demo PostgreSQL volume |
| `pcs/Dockerfile`, `pcs/entrypoint.sh` | Demo control-plane image: generates keys, migrates, issues the demo admin token |
| `web/Dockerfile`, `web/nginx.conf` | Demo UI image: static admin app with same-origin PCS/scheduler proxies |

## Demo (one command)

```bash
scripts/demo.sh
```

Builds PostgreSQL + PCS + scheduler + the admin app and prints
`http://127.0.0.1:18080` (override with `DEMO_PORT`; the scheduler is published
on `127.0.0.1:18443` by default). Keys, the admin token and the database password
are generated automatically; only loopback ports are published. The first run
builds four images and takes several minutes.

The demo follows the example-project storyline: a development host with three
builders (UI / middle layer / driver), a folded kernel host with its own
scheduler instance and builder, and three sideload clients (development, test,
after-sales). The script submits a few Shell tasks so the studio has running,
finished and queued work.

Sign in with **admin / admin**. That password is seeded only in demo mode and
bypasses the normal length policy; it exists because the demo UI is bound to
loopback. In a real deployment the first registration becomes the administrator
and passwords must be at least 10 characters.

Stop with `scripts/demo.sh --down` (add `--volumes` to drop the data too).

The demo does not bundle host-runtime or mount the Docker socket, so host
onboarding is not available: adding a host is rejected immediately with a
“Demo mode does not support adding hosts” message. The scheduler and builders run
as static containers instead; use the full deployment to manage hosts.

## Deploy

There is one deployment path, at the repository root:

```bash
scripts/deploy.sh
```

It starts PostgreSQL, PCS and the admin app on one machine, builds the payload and host cache, and serves
the UI from PCS. This directory holds the assets that deployment consumes: the payload entrypoints, the demo
compose file and the demo UI image.

## Multi-host: local and SSH hosts

Additional hosts are added from the admin page:

1. **Add a local host** — the machine running PCS; probing is direct and needs no SSH.
2. **Add an SSH host** — fill in address, port, user and private key; the key is encrypted at rest and the UI only shows the fingerprint.
3. **Start the runtime** — PCS writes the host-runtime bundle to
   `$HOME/.platform/host-runtime/<host_id>/` and starts it with a one-time enrollment token; once the host enrolls, its status becomes ONLINE.
4. **Choose a host when creating a builder** — the deployment plan lands on the selected host, and the container is created by that host's host-runtime.
5. **Deploy a scheduler** — on the host card, fill in the scheduler image, database address, host port and resources. Each host has
   exactly one root scheduler (PCS rejects duplicates with `ROOT_SCHEDULER_EXISTS`), optionally with additional node schedulers; scheduler containers
   connect to PostgreSQL, and a database on the host is reachable at `172.17.0.1:5432`.

PCS needs these environment variables:

| Variable | Description |
|---|---|
| `PCS_CREDENTIAL_KEY_FILE` | 32-byte key file (0600) used to encrypt SSH private keys with AES-256-GCM; without it only local hosts can be added |
| `PCS_RUNTIME_SOURCE_DIR` | host-runtime source directory; PCS bundles it into a self-contained `.mjs` with esbuild during bootstrap; default `../host-runtime` |
| `PCS_RUNTIME_URL` | Address remote hosts use to reach PCS, e.g. `http://pcs.example:7901`; local hosts automatically use `127.0.0.1` |
| `PCS_RUNTIME_NODE` | node path on remote hosts, default `node`; requires Node 22+ |
| `PCS_SCHEDULER_IMAGE` | Scheduler image, digest-pinned; `docker.m.daocloud.io/library/ubuntu@sha256:…` is recommended |
| `PCS_SCHEDULER_APP_DIR` | Scheduler deployment payload directory, default `<pcs dir>/app/scheduler` (output of `scripts/build-app-payload.mjs`) |
| `PCS_BUILDER_IMAGES` | Builder image table, `ubuntu24.04=<image>,ubuntu22.04=<image>`; when configured, official ubuntu images are used directly per OS |
| `PCS_BUILDER_APP_DIR` | Builder deployment payload directory, default `<pcs dir>/app/builder` |
| `PCS_SCHEDULER_DATABASE_URLS` | Per-host override of the scheduler database, comma-separated `host_id=postgres://…`; use when each host has one scheduler and its own database; unconfigured hosts fall back to `PCS_SCHEDULER_DATABASE_URL` |
| `PCS_SCHEDULER_URLS` | Per-host scheduler that builders on that host register with, comma-separated `host_id=http://…`; unconfigured hosts fall back to `PCS_SCHEDULER_URL` |

## Bare OS images + host cache (scheduler and builder)

Neither role builds an image: they use official ubuntu directly (digest-pinned), with neither the application nor the runtime in the image.

1. `node scripts/build-app-payload.mjs` produces two payloads: `deploy/scheduler/app/` (about 600K:
   the scheduling service, in-container Agent runtime, SQL, entrypoint scripts, CLI adapter) and
   `deploy/builder/app/` (about 120K: instance runtime, CLI adapter, sshd/Codex configuration, entrypoint scripts);
2. sync them to the control plane's `PCS_SCHEDULER_APP_DIR` / `PCS_BUILDER_APP_DIR`
   (default `<pcs dir>/app/{scheduler,builder}`);
3. the deployment plan writes the payload as `files` into the container at `/opt/platform/app/`, with the fixed command
   `/bin/bash /opt/platform/app/entrypoint.sh`;
4. Node, Claude Code and the openssh deb live in the host cache `~/.platform/cache/`, mounted read-only at
   `/opt/platform/cache` during deployment — shared by every container on the same host. Changing code only replaces the payload (a few hundred KB),
   with no image rebuild or transfer.

Builder images are selected by OS from `PCS_BUILDER_IMAGES` (`ubuntu24.04=<ubuntu@sha256:…>,…`); when unset,
the official image digest shown alongside each OS in the UI is used. The openssh deb in the cache must match the image version (currently
24.04); on a version mismatch the entrypoint falls back to installing openssh with `apt-get`.

The host cache only needs to be prepared once:

```bash
mkdir -p ~/.platform/cache/{node,agents,openssh}
cp -a /path/to/node-v22.20.0-linux-x64/. ~/.platform/cache/node/
install -m 0755 /path/to/claude ~/.platform/cache/agents/claude
# ssh/sshd are not installed into the image: download only the debs in ubuntu:24.04, then offline dpkg -i on first start
docker run --rm -v ~/.platform/cache/openssh:/out ubuntu:24.04 bash -c \
  'apt-get update -qq && apt-get install -y -qq --download-only --no-install-recommends openssh-server \
   && cp /var/cache/apt/archives/*.deb /out/'
```

Toolchains (git, compilers, etc.) are not preserved: install them inside the container when needed, and reinstall after rebuilding the container.

Remote host prerequisites: Docker Engine, the current user can access Docker, and `PCS_RUNTIME_URL` is reachable.
PCS listens on `127.0.0.1` by default; to let remote hosts enroll, set `PCS_HOST=0.0.0.0` or expose the admin side through a reverse proxy.
Images must still be digest-pinned and within `PCS_IMAGE_ALLOWLIST` — remote hosts pull the image address from the command themselves.

Generate the credential key:

```bash
umask 077 && openssl rand -out ~/.config/platform/pcs-credential.key 32
```

Bootstrap is repeatable: clicking "Rebootstrap runtime" again only stops the old process in that host's directory and restarts it, leaving other directories alone.

## Model credentials and CLI Agents

The CLI is not in the image: place it in the host cache `~/.platform/cache/agents/` (`claude`, `codex`), and the container's
`PATH` already includes it; the legacy Compose images still build it in via the `CLAUDE_CODE_VERSION` / `CODEX_VERSION` build arguments.
**No image or cache contains keys**; credentials are injected only at run time:

```dotenv
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
PLATFORM_AGENT_PASS_ENV=ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL,DEEPSEEK_API_KEY,CODEX_HOME
```

Credentials must pass two explicit gates; missing either one only causes an Agent authentication failure, never a fallback to plaintext or another executor:

1. `PLATFORM_AGENT_PASS_ENV`: container environment → Agent adapter process (host-runtime does not pass through the `PLATFORM_` prefix);
2. the Agent Profile's `--pass-env`: adapter → external CLI (`agents/cli-agent.mjs` passes only a minimal environment by default).

Default endpoints: Claude Code uses `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`;
Codex uses the DeepSeek Responses API configured in `CODEX_HOME=/opt/platform/codex/config.toml`.
To switch back to the official Anthropic endpoint, override `ANTHROPIC_BASE_URL`.

### Routing model traffic through LiteLLM

Agent Profiles cannot reference API Profiles today (the deployment rejects them with `AGENT_REQUIRES_SECRET_STORE`),
so per-builder quotas and spend tracking have to live in front of the model endpoint. [LiteLLM](https://github.com/BerriAI/litellm)
does this without touching the platform: it exposes an Anthropic-compatible `/v1/messages`, which is exactly what
Claude Code already calls.

1. Run the proxy where builders can reach it (its own Compose service or host; give it an internal DNS name).
2. Put the upstream keys in the proxy, not on builder hosts. A minimal `config.yaml`:

   ```yaml
   model_list:
     - model_name: claude-sonnet-4-5
       litellm_params:
         model: anthropic/claude-sonnet-4-5
         api_key: os.environ/ANTHROPIC_UPSTREAM_KEY
     - model_name: claude-haiku-4-5
       litellm_params:
         model: deepseek/deepseek-chat
         api_key: os.environ/DEEPSEEK_API_KEY
   general_settings:
     master_key: os.environ/LITELLM_MASTER_KEY
   ```

3. Issue one virtual key per builder pool (or per Agent) and point the container at the proxy:

   ```dotenv
   ANTHROPIC_BASE_URL=http://litellm.internal:4000
   ANTHROPIC_API_KEY=sk-<virtual-key>
   # Pin the name the CLI sends, so it matches model_name in config.yaml.
   ANTHROPIC_MODEL=claude-sonnet-4-5
   PLATFORM_AGENT_PASS_ENV=ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL,ANTHROPIC_MODEL,DEEPSEEK_API_KEY,CODEX_HOME
   ```

The virtual key is the only model credential that reaches a builder; budgets and spend logs are set on it in LiteLLM.
Keep the proxy on the trusted network, and do not give builders the master key. Codex can go through LiteLLM's
OpenAI-compatible endpoint in the same way by changing `CODEX_HOME`'s `base_url` and `env_key`.

### Interaction latency

Every command in the terminal and chat is an independent task, and the wait is dominated by "task enqueued → instance claims it".
`CLAIM_INTERVAL_SECONDS` (default `0.5`; the fallback value in code is still `2`) controls how often an instance polls
the scheduler: use 0.5s for a small platform with a few machines, and raise it back to 1–2s when there are many machines to save database load.
The console frontend has its own adaptive polling (150ms steps for the first 5 seconds, then backing off to 1 second).

Profiles are mounted from the runtime view exported by PCS: write `agent_profiles` + `bindings` to a file,
mount it into the container, and set `PROFILES_FILE=/opt/platform/profiles.json` in `deploy/.env` (both the builder
and scheduler entrypoints write it into `runtime.config.json`).

## Instance tokens

When the scheduler enables instance JWTs, put the token issued by PCS at `tokens/<instance_id>.jwt`; containers read it through the read-only volume
`/opt/platform/tokens`:

```bash
npm --prefix ../pcs-issuer run issue -- instance \
  --id builder-ubuntu22-a --role builder --host docker-host-01 \
  --out deploy/tokens/builder-ubuntu22-a.jwt
```

When authentication is not enabled (`SCHEDULER_AUTH_TOKEN` empty and no PCS public key configured), it can be left empty.

## Notes

- The 26.04 image fails to build until official `ubuntu:26.04` is available; this is the expected "preview" state. Use
  `UBUNTU_VERSION=24.04` to validate the flow first.
- Builder SSH allows public keys only by default; for password login, modify `builder/sshd_config` and mount a password yourself.
- In production, restrict 8443 / 2222-2225 / 2200 to the internal network or VPN; never expose them directly to the public internet.
