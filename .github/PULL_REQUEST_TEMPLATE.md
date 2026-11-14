## What changed

<!-- One paragraph. Link the issue this closes. -->

Closes #

## Why

<!-- The problem this solves and the trade-off you chose. -->

## Verification

- [ ] `npm run typecheck` and `npm test` pass for every affected backend package
- [ ] `npm run lint && npm test && npm run build` passes in `admin-app` when the UI changes
- [ ] `node scripts/build-app-payload.mjs` was run and `deploy/*/app` has no unintended diff
- [ ] New behavior has tests; UI changes include a screenshot or GIF
- [ ] English and `.zh-CN.md` documentation are both updated when behavior changes

## Risk

- [ ] No wire-protocol, database-schema, auth or trust-model change
- [ ] Security and compatibility impact is described below

<!-- Note any migration, rollout or rollback requirement. -->
