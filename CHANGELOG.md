# Changelog

> English · [简体中文](CHANGELOG.zh-CN.md)

All notable changes to OSACP are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Static GitHub Pages landing pages under `docs/` (English and Chinese) with links to the interactive architecture diagrams; README links point at the Pages URLs.
- Admin app tests for the live client, sync mapping, action payloads, task creation, sideloads, host task scoping and UI primitives (100 tests).

### Changed

- Admin app coverage thresholds raised from 5%/2% to 21% statements, 20% branches, 18% functions and 22% lines, with stricter per-file floors for the live client, sync, host tree/task scoping and shared UI primitives.

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

[Unreleased]: https://github.com/UnmetDecade/OSACP/compare/v4.5.1...HEAD
[4.5.1]: https://github.com/UnmetDecade/OSACP/compare/v4.5.0...v4.5.1
[4.5.0]: https://github.com/UnmetDecade/OSACP/compare/v4.4.0...v4.5.0
[4.4.0]: https://github.com/UnmetDecade/OSACP/compare/v4.3.1...v4.4.0
[4.3.1]: https://github.com/UnmetDecade/OSACP/compare/v4.3.0...v4.3.1
[4.3.0]: https://github.com/UnmetDecade/OSACP/releases/tag/v4.3.0
