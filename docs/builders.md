# Builders

> English · [简体中文](builders.zh-CN.md)

> Version: v4.3 · 2026-11-12
> The builder is the only work role: an SSH-accessible Ubuntu container, or an entire bare-metal host.

---

## 1. OS Versions

| `builder_os` | Base image | Suitable for |
|---|---|---|
| `ubuntu20.04` | Official `ubuntu:20.04` | Legacy projects, older glibc, older kernel headers |
| `ubuntu22.04` | Official `ubuntu:22.04` | Compatibility first |
| `ubuntu24.04` | Official `ubuntu:24.04` | Default recommendation |
| `ubuntu26.04` | Official `ubuntu:26.04` | Early adoption and forward-looking validation (subject to the official release) |

Rules:

- Images are pinned by digest and must be in PCS's `PCS_IMAGE_ALLOWLIST`; the admin app shows the digest, not just the tag.
- The image is **plain official Ubuntu**, with no platform runtime baked in. Node, Agent CLI, and openssh debs are mounted
  read-only from the host cache (`~/.platform/cache`); the instance runtime is written to `/opt/platform/app` at deployment time.
- One builder instance = one container = one OS version; a single task never spans OSes.
- Multiple instances of the same version are allowed; the display name is entered by the user (Chinese is allowed), and the instance ID is derived by the control plane.
- A bare-metal host with `role_mode=builder` needs no container: the entire host registers directly as one builder.

---

## 2. Directories Inside the Container

```
/opt/platform/
├── app/                       # instance runtime (written at deployment, read-only)
│   ├── agent-runtime.mjs
│   └── sshd_config
├── agents/                    # CLI Agent adapters (written at deployment)
│   ├── cli-agent.mjs          # Agent Profile entrypoint
│   └── task-envelope.mjs      # imported by the adapter, so it ships in the same directory
├── cache/                     # host cache (read-only mount)
│   ├── node/                  # Node 22+
│   ├── agents/                # claude / codex
│   └── openssh/*.deb          # same-version ssh/sshd as the image
├── tokens/                    # instance JWT (0600, written at deployment)
├── keys/                      # authorized public keys (read-only)
├── workspace/                 # workspace (volume)
├── artifacts/                 # artifact staging (volume)
├── state/                     # installed package list (per-instance isolated volume)
├── apt-cache/                 # host-shared deb cache (volume)
├── logs/                      # local log buffer
└── audit/                     # local audit
```

Required system packages are installed offline from the cached debs (`openssh-server`, `bash`, `git`, `curl`,
`ca-certificates`, `jq`). Build toolchains (`build-essential`, `cmake`, `python3`, `nodejs`, etc.) are not
preinstalled; each task installs what it needs inside the container, and `/opt/platform/state` records the package list
so the environment can be restored after a rebuild.

`docker-cli` is only for the "build images inside the container" scenario; the Docker socket is not mounted by default.

---

## 3. Full SSH Access

v4 deliberately provides **full-permission SSH**, for R&D troubleshooting and manual builds.

| Item | Default |
|---|---|
| User | `root` |
| Authentication | **Key-only**; the host login public key is written into the container's `authorized_keys` at deployment time |
| Port | Container `22` → a unique port allocated by the host, delivered with the deployment plan |
| Permissions | Full shell, can install software, can access the network |
| Session | Interactive PTY, standard ssh client |
| Audit | Optional: `sshd` logs, shell history, `script` recording |

The admin app shows:

```
ssh root@<host> -p <port>
```

and provides "Copy command" and "Open web terminal" actions. When the host has no usable public key, the container can
still be entered through PCS's web terminal; `sshd` does not accept password logins.

> Public keys come from the host's own `authorized_keys` and `~/.platform/keys/*.pub`.
> Neither the scheduler nor PCS stores builder SSH private keys; SSH does not go through the scheduler.

---

## 4. Builder Agent

### 4.0 Names and Instance IDs

What is entered in the UI is the **display name** (`display_name`), which may be Chinese and up to 32 characters; cards, lists, and detail pages all show it.
The instance ID (`instance_id`) is derived from the display name by the control plane and is used only for container names, volume names, the scheduler's `node_id`, and the child-node database name; it must be ASCII:

- `a-z` / `0-9` are kept as-is, and spaces and `. _ / -` are converted to `-`;
- All other characters (including Chinese) are converted to `-<Unicode code point>-`, e.g. "测试构建机" → `27979-35797-26500-24314-26426`;
- Consecutive `-` are collapsed and leading/trailing `-` are removed; names longer than 48 characters are truncated with the first 8 characters of the name hash appended;
- An `instance_id` that is already a valid ASCII id is used as-is and is not derived again.

Instance IDs are unique within a host; different hosts may use the same name. Schedulers follow the same rules, with `SCHEDULER_NODE_ID` set to `<host_id>:<instance_id>`.

### 4.1 Startup Parameters

| Environment variable | Required | Description |
|---|---|---|
| `SCHEDULER_URL` | Yes | Owning scheduler address |
| `INSTANCE_ID` | Yes | Instance ID, e.g. `builder-ubuntu22-a` |
| `INSTANCE_TOKEN_DIR` | Yes | Directory containing the instance JWT, default `/opt/platform/tokens` |
| `ROLE_ID` | Yes | Fixed to `builder` |
| `BUILDER_OS` | Yes | `ubuntu20.04` / `ubuntu22.04` / `ubuntu24.04` / `ubuntu26.04` |
| `WORKSPACE_DIR` | No | Default `/opt/platform/workspace` |
| `AGENT_PROFILE_ID` | No | Bound Agent (Claude Code / Codex / DeepSeek / custom); if empty, only the deterministic Shell runs |
| `PLATFORM_AGENT_PASS_ENV` | No | Comma-separated names of container environment variables passed through to the Agent adapter |
| `MAX_CONCURRENCY` | No | Default 1 |

### 4.2 Lifecycle

```
STARTING → REGISTERING → ONLINE ⇄ SUSPECT → OFFLINE
                              └── DRAINING
```

- `ONLINE`: heartbeat is healthy and tasks can be claimed.
- `SUSPECT`: no heartbeat for 45s, dispatch paused; in-flight tasks continue.
- `DRAINING`: no longer claims tasks, waiting for in-flight tasks to finish.
- `OFFLINE`: manually stopped or heartbeat timed out.

### 4.3 Execution Loop

1. `claim` a task (long poll 25s).
2. Validate the fencing token and the lease.
3. Create the workspace `workspace/<task_id>/<attempt_id>`.
4. Select an executor:
   - Agent bound → Agent Adapter (stdio JSON-RPC / HTTP; DeepSeek uses the OpenAI-compatible HTTP API).
   - Not bound → deterministic Shell executor (runs the commands in the payload directly).
5. Continuously report `progress`.
6. Upload artifacts to `artifacts` and report a summary via `result`.
7. Clean up the workspace (retention is configurable).

---

## 5. Resources and Limits

| Item | Default | Description |
|---|---|---|
| CPU | 2 cores | Configurable per instance |
| Memory | 4 GiB | Raise it when compiling large projects |
| Disk | 20 GiB | Workspace + artifacts; constrained by host quotas and volumes |
| PIDs | 512 / 1024 | 512 below 4 GiB, 1024 above |
| Timeout | 1 hour | Task-level `deadline_at` |
| Network | Outbound allowed | Needed for R&D; can be tightened via `network_policy` |

Limits are written by host-runtime when creating the container and cannot be relaxed from inside.

---

## 6. Volumes

| Volume | Mount point | Description |
|---|---|---|
| `state` (per-instance isolated) | `/opt/platform/state` | Installed package list; environment restored after a rebuild |
| `shared-apt-cache` (host-shared) | `/opt/platform/apt-cache` | Reuses downloaded debs without sharing the installed environment |
| `workspace` | `/opt/platform/workspace` | Retained across tasks for reproducibility |
| `artifacts` | `/opt/platform/artifacts` | Artifact staging |
| `keys` (read-only) | `/opt/platform/keys` | Authorized public keys |

---

## 7. Health Checks

| Check | Command | Failure handling |
|---|---|---|
| Instance heartbeat | Scheduler receives nothing for 45s | Mark SUSPECT and pause dispatch |
| sshd | `nc -z localhost 22` | host-runtime restarts the container |
| Disk | Instance reports workspace free space | Scheduler pauses dispatch |
| Container exit | host-runtime reconciliation | Recreate according to desired state |

---

## 8. Security Notes (Explicit Trade-offs)

- Default root + full SSH is **deliberate**, not an oversight.
- Use only on a trusted internal network; public exposure requires a firewall/VPN.
- Containers accept key-only logins; host login public keys are injected at deployment time.
- Builder tokens and SSH private keys are separate: the token is used for scheduling, and the private key is only for users.
- Do not put business secrets in the image; inject them through environment variables or the Secret Store when needed.
- If you need to tighten this in the future: change `root` to a `builder` user + sudo, or enable `AllowUsers`/`ForceCommand`.
- host-runtime keeps three rails on the host itself: an operation journal that rolls back interrupted
  deployment commands, a root-owned host policy file that can veto deployments (kill switch), and a
  hash-chained audit log that blocks new deployments when it has been tampered with. See
  [agent-control.md](agent-control.md#5-host-side-rails-host-runtime).

---

## 9. Reference Compose Snippet

Single-machine Compose is a reference deployment; control plane deployments go through PCS deployment plans.

```yaml
services:
  builder-ubuntu22:
    image: ubuntu:22.04@sha256:<digest>
    hostname: builder-ubuntu22
    environment:
      SCHEDULER_URL: http://scheduler:8443
      INSTANCE_ID: builder-ubuntu22-a
      ROLE_ID: builder
      BUILDER_OS: ubuntu22.04
    ports:
      - "2222:22"
    volumes:
      - builder22-state:/opt/platform/state
      - shared-apt-cache:/opt/platform/apt-cache
      - ./keys:/opt/platform/keys:ro
      - builder22-app:/opt/platform/app:ro
    cpus: 2
    mem_limit: 4g
    pids_limit: 1024
    networks: [platform-net]
```
