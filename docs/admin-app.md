# Admin App Specification

> English · [简体中文](admin-app.zh-CN.md)

> Version: v4.3 · 2026-11-12
> A small, handy R&D console: board, hosts, containers, tasks, SSH, chat, logs.

---

## 1. Positioning

- **Users**: a 1–10 person R&D team, for internal use only.
- **Assumption**: the user is the administrator; no approvals, no role switching.
- **Goals**: from opening the page to running a build in ≤ 30 seconds; from spotting an anomaly to SSHing in in ≤ 10 seconds.

The tech stack stays Refine + React + Vite; no new UI framework is introduced. All graphics are hand-drawn SVG and work offline.

---

## 2. Information Architecture (8 Pages)

| Page | Path | Purpose |
|---|---|---|
| Overview | `/` | AI Agent studio, status numbers, getting-started steps, recent activity |
| Builders | `/builders` | Container list, creation, start/stop, SSH info |
| Scheduler | `/scheduler` | Scheduler container status, queue, throughput, config summary |
| Profiles | `/profiles` | Maintain and enable/disable Agent Profiles and API Profiles |
| Tasks | `/tasks` | Task list, submission, details, event timeline |
| Terminal | `/terminal` | Select a builder for full SSH / Shell |
| Chat | `/chat` | Chat with the scheduler robot / builder robots |
| Logs | `/logs` | Operation records for the scheduler and control plane |

Removed pages: approval center, five-role office, host management, workflow configuration, scheduling dev console, audit permissions page.

---

## 3. Robot Mascots

Two **cute robots** replace the original cartoon characters. Hand-drawn SVG, no external images.

### 3.1 Builder Robot "Tamp"

- Build: rounded square head, short legs, orange work overalls, a wrench antenna on top of its head.
- Colors: primary `#e08a2e`, dark `#a45a12`, screen face `#1f2430`, cyan LED `#5fe0c0`.
- States:
  - `working`: the eye scan line moves left and right, the arm wrench swings up and down, and code particles pop out nearby.
  - `idle`: slow blinks, antenna glows faintly.
  - `rest`: the screen shows `z z`, breathing slows.
  - `alert`: the red light on top flashes, eyes turn red.
  - `offline`: overall desaturated, screen dims.

### 3.2 Scheduler Robot "Relay"

- Build: a slimmer rounded body, a clock face on the chest, a small halo floating above the head.
- Colors: primary `#2f8f83`, dark `#1c5f57`, screen face `#16202a`, gold LED `#f0c75e`.
- State animations match the builder robot, but the clock hands speed up or stop with the state.

### 3.3 General Rules

- Mascots only express state; no decorative random animation.
- Character sizes on a page come in three tiers: board 96–128, card 44, list 28–32.
- All animation uses CSS and respects `prefers-reduced-motion`.

---

## 4. Page Details

### 4.1 Overview

- All content is filtered by the current host.
- Top: online builders / running tasks / queued tasks / failures pending, the four combined into one status bar.
- Main area, the "AI Agent Studio":
  - The scheduler card is pinned at the top: robot, status, instance ID, resources, capability tags, and deploy or view scheduler console.
  - Below the connector line are builder cards: robot, instance name, OS and resources, current task or idle.
  - A dashed card is pinned at the end, for creating a builder directly.
  - Above the root scheduler is the sideload strip, connected to it by animated lines: the dashed "Attach
    sideload" card issues a curl token to a LAN device; existing sideloads show a host cartoon, online/offline
    state, the token's last four characters and permission tags, and open to details and deletion.
  - Only the current host's sideloads appear here; sideloads of folded child hosts do not.
  - When the host is already a bare-metal builder, the empty scheduler card is not shown at all: the host can
    hold only one role, and that card would only lead to an action the control plane rejects. The builder
    cards stay, centered.
- Right column:
  - Getting started: deploy scheduler → deploy builder → submit the first task, showing completed / next step based on actual state.
  - Recent activity: control plane audit records, at most 5.
- No approvals, no permission hints, no role switching.

### 4.2 Builders

- Table: name, OS version, status, CPU/memory, current task, SSH, actions.
- Top filters: OS version, status.
- "New Builder" opens a side form:
  1. Choose an Ubuntu version (four cards: 20.04 / 22.04 / 24.04 / 26.04).
  2. Resource tier: light / standard / heavy, or "Custom" to fill in CPU (0.5–16 cores), memory (512–65536 MiB), and disk (8–1024 GiB).
  3. Quantity (1–4); Agent and API each get one row, both drop-downs (adapters are not shown).
  4. Confirm: shows the image digest, SSH port, and resource totals.
- Details page:
  - Basic info, SSH connection block (command + copy + download private key).
  - Resource curves (simplified to three progress bars).
  - Volumes and workspace.
  - Actions: start, stop, restart, drain, delete (with confirmation).

### 4.3 Scheduler

- Card: uptime, version, queue length, throughput (tasks/minute), failure rate.
- Queue view: grouped by priority, showing the 10 tasks that have waited longest.
- Config summary: concurrency limit, lease duration, retry count, aging time (read-only; change via environment variables/config file).
- Actions: restart scheduler (with confirmation).
- Deploy scheduler: select only Agent and API; the image and database are supplied by control plane configuration (`PCS_SCHEDULER_IMAGE` / `PCS_SCHEDULER_DATABASE_URL`) or by the selected Agent Profile's `artifact_image`, not through the UI.
- "Configure" on the scheduler card can change the Agent and add/remove API Profiles; the builder details page also has "Configure". Bindings are written to the control plane and take effect after the instance restarts.

### 4.3.1 Profiles

- Two sections: Agent Profile / API Profile, each with its own table; click a row to edit, and create in the top right.
- Agent Profile: name, role (cannot be changed after creation), Agent type (Claude Code / Codex / Custom); the version is taken automatically from the versions registered for that Agent.
  Known types automatically come with an adapter, entry point, and parameters; only "Custom" shows the adapter, entry point, parameters, image, and capabilities.
- Responsibilities and prompt: description (used only for panel identification) and system prompt; the latter is assembled into the prompt by the adapter, and platform safety constraints are always appended at the end.
- Permissions: comma-separated tool_ids; empty means all permissions. The maximum number of rounds and the timeout are enforced by the runtime.
- API Profile: name, provider (DeepSeek / Anthropic / OpenAI / Custom), Base URL, API Key, timeout, enabled.
  Preset providers pre-fill the address, authentication method, and `secret://` reference; only "Custom" shows type, authentication, egress, and reference.
- The API Key is submitted only once, at save time: the control plane forwards it to the Secret Store, and PCS never persists or echoes it; lists, logs, and audits contain only the reference.
  Leaving it empty while editing means no change; when the Secret Store is not configured the control plane returns 503, and you can fill in only a `secret://` reference.
- The delete button to the right of "Enabled" in a list row opens a confirmation dialog first; if the profile is still referenced by a live instance or Agent, the control plane rejects the deletion—unbind it in "Configure Agent" on the builder / scheduler detail page (choose "No Agent", or remove the API chip). Bindings left behind by removed deployments or deleted hosts are pruned automatically on the next deletion attempt.
- Which API an instance uses is chosen via "Configure" on the builder / scheduler, and is not specified again in the Agent Profile.
- The database stores only `secret://` references and image digests; secret values exist only in Secret Store files (0600).

### 4.4 Tasks

- List: title, type, target builder, status, duration, creation time.
- Filters: status, builder, time range.
- Submit task drawer:
  - Task description, target builder, priority.
  - Tasks are executed only by an Agent: the target builder must be online, have an Agent bound, and declare support for `task.build`; otherwise submission is disabled.
  - Shell commands and working directories are no longer entered; the natural-language description is sent as `requirements.build.instruction`, and the deterministic Shell executor fails immediately when it encounters it (`AGENT_REQUIRED`) rather than mistaking it for a command.
- Details:
  - Status timeline (QUEUED → ASSIGNED → RUNNING → SUCCEEDED, plus the `NEEDS_INPUT` and `WAITING_CHILDREN` parks).
  - Live logs (SSE / polling).
  - Artifact list and download.
  - Cancel / retry.
- Agent control:
  - A task waiting for a decision shows the agent's question and an answer box; submitting the
    answer resumes the task, and "Abandon task" cancels it instead.
  - The execution card shows the autonomy level (`ask` / `edits` / `auto` / `full`) and the typed
    outcome (`completed`, `error`, `input_expired`, `interrupted_after_outward`, …).
  - A fan-out parent lists its children with state and outcome; a child links back to its parent.
  - A failed attempt shows its failure class (deterministic / after an outward action / rate limit /
    resource busy / transient), how many times the same normalized failure has been seen fleet-wide,
    and the failure signature, so the same fault on several builders reads as one problem.

### 4.5 Terminal (Full SSH Access)

- Left: builder list (robot avatar + OS version + status).
- Right:
  - Top connection block: `ssh root@<host> -p <port>`, copy button, "Download private key".
  - Web terminal: full interactive command input, no allowlist; supports history and `Ctrl+C`.
  - Banner: "This is the full shell inside the builder, equivalent to an SSH login. Be careful with destructive commands."
- No more "controlled" or "audited" wording from the old UI; you are responsible for auditing real SSH yourself.

### 4.6 Chat

- Left: scheduler robot / each builder robot.
- Right: conversation stream + input box.
- Quick prompts: what are you doing, recent failures, give me a build command, check disk.
- Reply source tags: Agent / deterministic.
- Conversations are not approval evidence; they are purely R&D communication.

### 4.7 Logs

- A single table: time, action, object, result, details; in live mode the data comes from the control plane audit log.
- There is no separate "Settings" page: connection targets are determined by the page's own origin (`/api/scheduler`, `/api/pcs`), and the UI does not take an address;
  the bottom-left only shows "not connected / live / connection failed": with no host onboarded it is "not connected", which is not counted as a failure; "connection failed" appears only after onboarding when synchronization errors occur. Clicking re-syncs immediately. The host is selected in the bottom-left host menu, and Agent / API Profiles are maintained by the control plane.
- After an added host passes probing, its runtime (host-runtime) starts automatically, and components can be deployed as soon as the host is onboarded; if startup fails, the reason is shown in a dialog, and you can click "Start runtime" on the host row to retry.
- Every host on the Hosts page has "Settings": change the display name, SSH address / port / user, or replace the private key (leave empty to keep the current key); saving re-probes immediately. The private key here is the key of the **connecting party** (the admin machine or PCS); the remote host only stores the corresponding public key in `~/.ssh/authorized_keys`.

---

## 5. Interaction Conventions

- Every write operation gives immediate feedback (button loading, toast).
- Destructive operations (deleting a builder, restarting the scheduler) require confirmation; the confirmation text is the instance name.
- Empty states suggest the next action instead of just showing "No data".
- Connection mode: opening the page connects to same-origin PCS and scheduler; there is no demo data; all pages refresh based on the selected host, and the bottom-left shows connection status.
- Responsive: ≥ 1280 three-column board; ≥ 960 two columns; single column on mobile.

---

## 6. Visual Specification

- Background: light `#f6f4ef` / dark `#14181f`; cards white/dark gray, 1px border, 14px radius.
- Primary colors: builder orange `#e08a2e`; scheduler teal `#2f8f83`.
- Status colors: success `#2f9e6f`, warning `#c8912f`, danger `#c23b3b`, offline gray.
- Font: system UI; code `ui-monospace`.
- Robots do not compete with the information hierarchy: information comes first in cards, and the mascot occupies 44–56px on the left.

---

## 7. Removals (Relative to v3.2)

- Removed the role-switching dropdown and the `AppRole` type.
- Removed the approval center page, approval tokens, and approval status.
- Removed the five-role filter in the "office".
- Removed the controlled terminal allowlist wording and the "audited" promise; replaced with full SSH.
- Removed the workflow configuration page and approval-stage display.
- Removed the host registration/revocation page (hosts are managed at `/hosts` via the bottom-left host menu).

---

## 8. Acceptance Checklist

- [ ] Navigation has only 8 pages, with no approval/permission entries.
- [ ] The overview shows the scheduler, all builders, and running tasks at a glance.
- [ ] New builders can select Ubuntu 20.04/22.04/24.04/26.04.
- [ ] Builder details show the SSH command and allow copying it.
- [ ] The terminal can run any command (through the full shell inside the container).
- [ ] All operations are available by default, with no "current identity has no permission" prompts.
- [ ] Reconnecting does not refresh the page.
- [ ] Dark/light themes are complete.
