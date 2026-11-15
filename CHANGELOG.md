# Changelog

> English · [简体中文](CHANGELOG.zh-CN.md)

All notable changes to OSACP are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

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
