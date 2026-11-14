# Contributing to OSACP

> English · [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for taking the time to improve OSACP. This project is a self-hosted compute and scheduling platform for AI coding agents. Small, focused changes with tests are the easiest to review and merge.

Before you start, read [docs/architecture.md](docs/architecture.md) and [SECURITY.md](SECURITY.md). The security model is deliberate: builders run as root, the platform assumes a trusted network, and PCS never executes Docker commands.

## Prerequisites

- Node.js 22
- PostgreSQL 16 for the scheduler and PCS test suites
- Docker (for images, Compose and the acceptance scripts)
- A Unix-like shell; the scripts use `bash`

## Set up a development checkout

```bash
git clone https://github.com/UnmetDecade/OSACP.git
cd OSACP

cd scheduler    && npm ci
cd ../pcs-issuer  && npm ci
cd ../host-runtime && npm ci
cd ../secret-store && npm ci
cd ../admin-app   && npm ci
```

Start PostgreSQL locally (or use the Compose database), then create the test databases:

```sql
CREATE DATABASE scheduler_test;
CREATE DATABASE platform_control_test;
```

`npm test` in `scheduler/` and `pcs-issuer/` defaults to `postgres://postgres:sched_dev_pw@127.0.0.1:5432/...`. Override with `DATABASE_URL_TEST` / `PCS_DATABASE_URL_TEST`.

## Checks before you open a pull request

Run the same commands CI runs:

```bash
cd scheduler    && npm run typecheck && npm test
cd pcs-issuer   && npm run typecheck && npm test
cd host-runtime && npm run typecheck && npm test
cd secret-store && npm run typecheck && npm test
cd admin-app    && npm run lint && npm test && npm run build
```

The database test suites truncate their database, so they refuse to run against a database whose name does not end in `_test`. Never point them at a real deployment.

`scripts/e2e-p2.sh` and `scripts/e2e-p4.sh` are full-machine acceptance tests. They require a prepared environment (registered schedulers, host runtime, issued instance tokens). See [scripts/README.md](scripts/README.md). They reset databases and are not part of pull-request CI; run them on a disposable test host.

## Code style

- TypeScript is strict. Avoid adding explicit `any`; use a row type or `unknown` plus narrowing.
- Code comments are written in English.
- Keep modules focused. If a file is already large, extracting a cohesive unit is welcome; do not mix unrelated refactors into a bug fix.
- `pcs-issuer/src/service.ts` is the largest backend module, and its sections reference each other (hosts ↔ deployments ↔ sideloads), so inheritance-based splits are unsafe. Extract cohesive query/mapping helpers with composition instead.
- The admin app uses its own `oxlint` configuration. Fix new warnings you introduce.
- Do not edit `deploy/scheduler/app/` or `deploy/builder/app/` by hand. They are generated:

  ```bash
  node scripts/build-app-payload.mjs
  ```

  CI rebuilds them and fails if the committed payload differs from the source.

## Documentation

Every Markdown document has an English default and a `.zh-CN.md` translation:

- English: `NAME.md`
- Chinese: `NAME.zh-CN.md`

Add the language switcher below the H1 and keep cross-document links pointing at the reader's language. If you change a behavior, update both versions (or add the Chinese file in the same pull request).

## Commits and pull requests

- Write commit subjects in English, imperative mood, under ~72 characters.
- Keep a pull request focused on one concern. Include tests for behavior changes and screenshots/GIFs for UI changes.
- Reference the issue it closes (`Closes #123`).
- Recommended protection for `main`: require CI (`scheduler`, `pcs-issuer`, `host-runtime`, `secret-store`, `admin-app`, `payload`) to pass, require linear history, and block force pushes and deletions. Enable it in repository settings or through the branch-protection API; until the rule exists, these checks protect nothing on a direct push.
- Do not commit credentials, private keys, real host addresses, model API keys or production data.

## Releases

Releases are cut from `main` only after CI is green:

```bash
git switch main && git pull
git tag -a v4.5.1 -m "v4.5.1 — short summary"
git push origin v4.5.1
```

The tag triggers CI again. When every job succeeds, the `release` job creates the GitHub release automatically. Never move or delete a published tag; ship a new patch version instead.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md) and use GitHub Security Advisories.

## License

By contributing, you agree that your contribution is licensed under the project's [MIT License](LICENSE).
