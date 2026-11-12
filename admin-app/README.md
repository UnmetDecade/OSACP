# Platform Admin App (v4)

> English · [简体中文](README.zh-CN.md)

A single-page admin app for a small R&D platform: two roles (scheduler / builder) and two bots (Relay / Tamp),
with no administrators, reviewers, approvals or permission matrix. See [../docs/admin-app.md](../docs/admin-app.md) for the architecture.

All data comes from live connections: the page proxies same-origin requests to the scheduler and control plane (`/api/scheduler`, `/api/pcs`),
syncing on open and refreshing every 15 seconds thereafter. There is no demo mode and no built-in data.

## Running

```bash
npm install
npm run dev      # http://localhost:5173 (5178 in this repo's development setup)
npm run build    # type check + production build
node scripts/capture-ui.mjs            # full-route screenshots (scheduler and PCS must be reachable)
node scripts/capture-ui.mjs --dark     # dark mode
ADMIN_TOKEN=... node scripts/capture-ui.mjs  # screenshots with a token
node scripts/capture-readme.mjs --lang en    # generate README screenshots/animations into ../docs/assets
```

The dev server proxies `/api/pcs` to `http://127.0.0.1:7901` and `/api/scheduler` to
`http://127.0.0.1:8443` (see `vite.config.ts`; override with `VITE_PCS_TARGET` /
`VITE_SCHEDULER_TARGET`). The page has no connection-address field; the status button in the lower-left shows "Disconnected / Live / Connection failed"
and can be clicked to resync immediately.

The admin token is injected by the dev proxy, so the browser never holds it: write `PCS_ADMIN_TOKEN=...` into
`admin-app/.env.local` (covered by `.gitignore`'s `*.local`, mode 600), or set the same environment variable before starting
`npm run dev`. The proxy only adds the header when the request does not already carry `Authorization`,
so a token in `sessionStorage` still wins. The token never enters the frontend bundle, URLs or localStorage.

API prefixes include `/api`: `/scheduler` itself is a page route, so using it as a proxy prefix forwards
navigation requests to the scheduler on refresh, and you see `{"code":"ROUTE_NOT_FOUND"}`.

Connecting only checks scheduler reachability; an unreachable PCS does not prevent viewing tasks and builder status. Once connected, it syncs incrementally
every 15 seconds and refreshes when the window regains focus; writes refresh immediately after completing.

Live behavior:

- Creating a builder goes through a PCS deployment plan (`plan_id` / `plan_digest`); the host SSH port is delivered via
  `instance.ports` and written into `PortBindings` by Host Runtime.
- Task submission uses the single-phase `wft_build` workflow; task events come from `/v1/tasks/:id/events`.
- Agent / API profiles are maintained by the control plane; the UI only binds them.
  Binding changes only control-plane facts; the execution Agent switches after Host Runtime reloads.
- Chat and container terminals are ordinary scheduling tasks (`task.chat.*` / `task.console.*`) and keep leases and
  fencing; the terminal is a full shell with no command allowlist.
- The logs page shows only control-plane audit records and never fabricates data.

## Bots, chat and container terminals

Instance cards depict the scheduler as "Relay" and the builder as "Tamp": idle, working, alert and offline each have their own status
animation. Cards and detail pages let you change the Agent Profile directly; selectable roles are builder or scheduler.

- **Chat** (`/chat`): each message creates a `task.chat.<role>` via `POST /v1/tasks` and polls until a
  terminal state, then shows the reply. The deterministic executor returns `mode=deterministic`; an Agent Profile returns
  `mode=agent`, and the UI labels the source of each reply. Chats are kept only in the current tab and are cleared on refresh.
- **Terminal** (`/terminal`): commands are dispatched via `task.console.builder` or `task.console.scheduler`
  and run a full shell inside the container, equivalent to SSH; there is no command allowlist. For an interactive shell, use
  `ssh root@<host> -p <port>` directly.

## Hosts

A host is a machine running Docker; both schedulers and builders are containers on it. "Current host" at the bottom of the sidebar
determines what the other pages show — overview, builders, schedulers, tasks, terminal and chat all show only that host's components and
tasks; after switching, the page content in the upper-left switches with it. The hosts page (`/hosts`) is not in the top navigation; enter it via
"Manage hosts" in the host menu at the bottom of the sidebar. Each host has one root scheduler, optionally with additional node schedulers; "Deploy scheduler" on the page applies only to the current host.
Hosts fall into two categories by connection method:

- **Local host**: the machine running the admin page / PCS; no SSH needed. PCS probes and bootstraps it directly on the machine.
- **SSH host**: connected with address, port, user and private key; requires Docker installed and accessible to the current user.

When adding a host, PCS probes it immediately (OS, architecture, Docker version, whether the current user has Docker permission),
and shows the result on the host row; you can also probe manually later. Probing is read-only and does not modify the host.

Private key handling:

- The browser sends the private key to PCS only when the form is submitted, and clears it from component state immediately afterward.
- PCS encrypts it with AES-256-GCM before storing, using the key from `PCS_CREDENTIAL_KEY_FILE`; the API and page only echo
  a SHA-256 fingerprint, and the private key is never read back.
- During probing, the private key is written to a 0600 temporary file and deleted when the command ends; `BatchMode=yes`, `IdentitiesOnly=yes`
  and an isolated temporary `known_hosts` are used.

"Start runtime" installs host-runtime on the host:

1. PCS bundles `host-runtime` into self-contained `runtime.mjs` / `watchdog.mjs` with esbuild;
2. writes it to `$HOME/.platform/host-runtime/<host_id>/` over SSH (or executes directly on a local host);
3. starts it with a one-time enrollment token; the host connects out to PCS and pulls signed commands; once enrolled, its status becomes ONLINE / DEGRADED.

Bootstrap is repeatable: clicking "Rebootstrap runtime" again only stops the old process in that host's directory and restarts it. Remote hosts need
to reach `PCS_RUNTIME_URL` and have Node 22+. See
[../deploy/README.md](../deploy/README.md#multi-host-local-and-ssh-hosts) for detailed prerequisites.

"Deploy scheduler" places a scheduler container on the selected host (local or SSH): fill in the scheduler image, database address,
host port and resources; PCS generates a deployment plan and that host's host-runtime starts the container. Each host has only one root scheduler;
once a root exists, only node schedulers can be added. PCS rejects duplicate root deployments with `ROOT_SCHEDULER_EXISTS`.
The database address is delivered as env in the deployment intent; the form should only contain R&D database credentials.

Host rows link directly to "New builder" with the host preselected; clicking a host name makes it the current host.

## Creating a builder

- Host: choose a host in ONLINE / WARNING state; if no deployable host exists, add one on the hosts page first.
- OS: Ubuntu 20.04 / 22.04 / 24.04 / 26.04.
- Resource tier: light / standard / heavy, or "Custom" to enter CPU (0.5–16 cores), memory (512–65536 MiB),
  disk (8–1024 GiB).
- Agent: Claude Code / Codex / DeepSeek / custom.
- API access: select the API profiles this builder may access.
- SSH: the host port is allocated automatically; after creation it shows `ssh root@<host> -p <port>`.

## Choosing an Agent (Claude Code / Codex / DeepSeek)

Two integration modes:

- **stdio-jsonrpc**: `agents/cli-agent.mjs` hands the task and workspace prompt to the external CLI and maps stdout
  to `agent.result`. Before starting the CLI it strips `PLATFORM_TOOL_TOKEN` / `PLATFORM_API_PROXY` /
  `PLATFORM_API_PROFILES`, and kills the process group on cancellation.
- **http-local**: an OpenAI-compatible HTTP Agent; DeepSeek uses this mode. The model endpoint and key go in an
  `llm`-type API Profile, and the Agent Profile stores only a `model_api_profile_id` reference.

```bash
# register Claude Code / Codex profiles with PCS (images must still be digest-pinned)
ADMIN_TOKEN=... AGENT_IMAGE=registry.example/agents/claude@sha256:<64hex> \
  PLATFORM_DIR=/opt/platform AGENT_NODE=node \
  AGENT_PASS_ENV=ANTHROPIC_API_KEY \
  node scripts/seed-cli-agents.mjs --bind builder-ubuntu22-a:claude
```

`AGENT_PASS_ENV` lists variable names only (comma-separated); external CLIs do not inherit the host environment by default. Binding only writes the control plane:
the execution Agent actually switches after the instance restarts.

If the CLI is not installed, the task fails with `AGENT_NOT_READY / CLI_NOT_INSTALLED` and does not silently switch to another executor.

## Stack

- React 19 + TypeScript + Vite
- `react-router-dom` 7: routing
- Zero UI framework dependencies: built-in neutral light/dark design tokens, inline SVG icons and components

## Directory

```
src/
├── App.tsx                     # routes: / /hosts /builders /scheduler /profiles /tasks /terminal /chat /logs
├── api.ts                      # live request facade
├── store.ts                    # runtime data store (written during sync, read-only for pages)
├── host-context.tsx            # current host (sessionStorage, switched at the bottom of the sidebar)
├── host-tasks.ts               # task → host: dispatched tasks by instance, undispatched tasks to the host's scheduler
├── characters.ts               # Relay / Tamp SVG figures and states
├── types.ts                    # Host / Instance / Task / AgentProfile / ApiProfile
├── live/
│   ├── config.ts               # same-origin connection and optional sessionStorage token
│   ├── client.ts               # scheduler / PCS requests and error normalization
│   ├── sync.ts                 # server facts → page data model
│   ├── actions.ts              # deployment plans, instance actions, tasks, Agent bindings
│   └── context.tsx             # LiveProvider: 15s sync and global refresh
├── components/                 # Layout, UI atoms, Character, DeployScheduler
└── pages/
    ├── Dashboard.tsx           # R&D workbench
    ├── Hosts.tsx               # hosts: local / SSH connection, probing, host-runtime bootstrap
    ├── Builders.tsx            # builder list + create (host / OS / custom resources / Agent)
    ├── BuilderShow.tsx         # builder details, SSH, switch Agent
    ├── Scheduler.tsx           # scheduler, queue, scheduling Agent
    ├── Tasks.tsx               # task list / details / submit
    ├── Terminal.tsx            # full shell inside the container
    ├── Chat.tsx                # chat with Relay / Tamp
    └── Profiles.tsx            # Agent / API profiles and bindings
```

## Implemented domain constraints

- **Hosts are the deployment boundary**: a deployment plan must target an ONLINE / DEGRADED host; PCS only writes desired state and
  signed commands, containers are created by that host's host-runtime, and PCS never calls Docker directly.
- **One root scheduler per host**: PCS rejects duplicate root deployments with `ROOT_SCHEDULER_EXISTS`; node schedulers attach recursively under a parent scheduler.
- **Tasks belong to hosts**: an assigned task follows the host of its target instance; an unassigned task belongs to the current host's scheduler,
  and hosts without a scheduler do not show them.
- **Private keys are one-way**: SSH private keys go in and never come out; the API and UI only expose fingerprints; the encryption key is not in the database.
- **Deployment plan digest**: preview generates `plan_id` + `plan_digest`; applying recomputes it and returns
  `PLAN_CHANGED` on mismatch.
- **SSH ports are delivered with deployments**: builders have a fixed container port 22, and the host port is allocated incrementally by PCS;
  the UI reads `ports` from the deployment record and shows `ssh_host` / `ssh_port`.
- **Images must be digest-pinned**: when creating a builder, the digest of an existing builder with the same OS is reused; a tag-only image is an error.
- **No role permissions**: no administrators / reviewers / approvals; anyone connected can perform every operation.
- **No keys in the UI**: the API only shows `secret_ref` and rotation time; tokens live only in `sessionStorage`.
- **Append-only audit**: deployments, instance actions, tasks and Agent bindings all write to the control-plane audit log.

## Getting started

1. Overview → see Relay / Tamp and the queue summary.
2. Hosts → add a local host → probe → start runtime; then add an SSH host to see the connection form.
3. Builders → New → choose a host → choose Ubuntu 24.04 → resource tier "Custom" → choose DeepSeek Coder → create.
4. Scheduler → view the scheduling Agent (DeepSeek scheduling assistant) → "Ask Relay".
5. Tasks → submit a build → watch the event timeline and logs.
6. Terminal → run pipes, redirection and `apt` directly.
7. Logs → view operation records from the scheduler and control plane.

## Next steps

- Wrap in a Tauri 2 shell: move tokens and SSE to the Rust side and call the page through an IPC allowlist; finish Windows packaging and signing.
- Connect the logs page to real log collection (live mode currently states clearly that it is not connected and never fabricates data).
- Generate `packages/contracts` from OpenAPI so request/response types and documentation share one source.
- Move list pages to Refine resource definitions while keeping custom flow pages (see spec §3).
