# Changelog

> English · [简体中文](CHANGELOG.zh-CN.md)

All notable changes to OSACP are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [4.7.0] - 2026-11-16

### Added

- Bare-metal builders attach themselves: a host switched to the bare-metal builder role keeps that role while no scheduler is reachable, then starts and registers with the first reachable scheduler — including a root scheduler on another host — on the next heartbeat.
- `scripts/deploy.sh` starts the Secret Store; API keys entered in the admin app are kept outside the PCS database, and containers resolve `secret://` references with an instance identity token.
- API Profiles of kind `llm` can carry an Agent's model traffic through the in-container API adapter: the adapter injects the Secret Store credential at egress, the Agent sees only a placeholder key, and LLM profiles get a ten-minute upstream timeout floor. The deployment dialogs pre-select the Agent's model API.
- Hosts merged into another host contribute their bare-metal builders to the studio, and a builder-only host names the scheduler that dispatches to it instead of asking for a local one.
- Documentation for routing model traffic through an API Profile and for the Secret Store requirements of a deployment.

### Changed

- Deleting a host's last bare-metal builder returns the host to a container host, so the studio no longer shows a "waiting for a scheduler" card for an instance the operator removed.
- The admin app subscribes to live updates on deep links (files, logs), labels runtime and Docker versions separately, and falls back to the latest task attempt for the assigned builder and start/finish times.
- `scripts/deploy.sh` derives a container-visible host address (LAN IP on Linux, Docker bridge gateway on macOS), prepares the host cache and starts every control-plane component in one pass.

### Fixed

- Bare-metal builders can join a scheduler on another host when created, re-attached and displayed; the control plane records the remote scheduler deployment id instead of showing "unassigned", and a removed builder is no longer re-created on every heartbeat.
- A failed deployment is shown as failed even while the scheduler still reports the stale instance as starting.
- Native builders no longer offer a copyable SSH command, and their terminal entry explains that they run directly on the host.
- Re-saving a bare-metal builder host reports it as already running, and the delete confirmation describes the role change instead of promising volume deletion.
- Profile editing reflects whether the Secret Store is available before anything is saved.

## [4.6.0] - 2026-11-15

### Added

- One-command demo (`scripts/demo.sh`) with the example-project storyline, rebuild/stop flags and documented stop commands.
- Deployment capability toggles (SSH/terminal and chat) that survive redeploys and can be edited from the instance detail page.
- Account login and registration: the first account becomes the administrator, later registrations await approval; role presets and custom scopes; session + CSRF protection; per-account audit history; password complexity policy.
- Explicit human-attention stages on tasks (`answer`, `review`, `blocked`, `waiting`) with list filtering and detail callouts.
- Versioned admission policy and immutable per-task mandates covering admin and sideload intake, with policy and mandate views.
- Threads: tasks and messages grouped into a conversation; posting a message creates a continuation task that inherits the target, profile and autonomy, plus per-thread outbox subscriptions with a cursor.
- Outbox effects: named pull consumers with a durable cursor, optional event-type filter, ack/nack retry accounting, pause/resume and lag statistics.
- Dedicated `策略` (Policy) page in the admin app; policy and authorization records moved out of Accounts.

### Changed

- The single deployment path (PCS + admin UI) is the only supported deployment, and the scripts deploy it end to end.
- Node and Docker are installed automatically on Debian/Ubuntu, Fedora and macOS; the README documents automatic versus manual installation.
- macOS hosts are supported: containers use the Docker bridge gateway, available memory comes from `vm_stat`, and Linux agents are installed for containers.
- Admin app layout: fixed-height builder, task and log pages; task detail tabs (`overview / thread / events`); clearer segmented controls; no page-level scrolling.
- README: demo mode restored with stop commands, plus a warning not to expose the admin app publicly and to use sideload tokens instead.

## [4.5.1] - 2026-11-14

### Added

- Bilingual interactive architecture diagrams: the platform overview, the sideload access model, and a concrete scheduler + N development machines example.
- README sections that show the example project architecture and the kinds of projects it supports.
- Bilingual documentation: every Markdown document now has an English default and a `.zh-CN.md` counterpart, with language switchers and language-aware links.
- Contributor Covenant, contribution guide, changelog, issue forms and pull request templates.
- Admin app unit tests (Vitest + Testing Library), coverage reporting, and a strict TypeScript configuration.
- CI: production dependency audit, CodeQL analysis, Dependabot updates, generated-payload drift check, and a release job that only runs after every check passes.
- Documented the recommended `main` branch protection: required checks are `scheduler`, `pcs-issuer`, `host-runtime`, `secret-store`, `admin-app` and `payload`, with force pushes and deletions disabled.

### Changed

- The admin UI now follows the browser language on first visit: Chinese browsers use Chinese, every other language uses English. A saved choice still wins.
- Source comments are written in English throughout the repository.

### Fixed

- Scheduler and PCS database test suites run one file at a time, preventing cross-file `TRUNCATE` deadlocks.

## [4.5.0] - 2026-11-13

### Added

- Sideload tokens and files, host controls, and agent control assets.
- Task parking and resume, autonomy levels, typed outcomes, and failure classes.

## [4.4.0] - 2026-11-13

### Added

- Dynamic scheduling: live capability and demand, grant generations, durable claim backoff, and scheduling algorithm documentation.

## [4.3.1] - 2026-11-12

### Changed

- Bilingual documentation and English code comments. No runtime behavior changes.

## [4.3.0] - 2026-11-12

### Added

- First public release: PCS control plane, host runtime, recursive schedulers, federation, relay, builders, agent adapters, admin app, Compose deployment and acceptance tooling.

[4.6.0]: https://github.com/UnmetDecade/OSACP/compare/v4.5.1...v4.6.0
[4.5.1]: https://github.com/UnmetDecade/OSACP/compare/v4.5.0...v4.5.1
[4.5.0]: https://github.com/UnmetDecade/OSACP/compare/v4.4.0...v4.5.0
[4.4.0]: https://github.com/UnmetDecade/OSACP/compare/v4.3.1...v4.4.0
[4.3.1]: https://github.com/UnmetDecade/OSACP/compare/v4.3.0...v4.3.1
[4.3.0]: https://github.com/UnmetDecade/OSACP/releases/tag/v4.3.0
