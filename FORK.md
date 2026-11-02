# codegraph-psql

`dhritcu/codegraph-psql` is a public fork of [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) that adds PostgreSQL and PL/pgSQL support. It tracks upstream `main` and keeps its own changes small enough to merge upstream releases without rework.

The fork differs from upstream in four ways that keep it from touching upstream's channels:

- It is never published. `package.json` is `"private": true` and a `prepublishOnly` script fails, so `npm publish` refuses.
- It sends nothing. Telemetry is off unless you turn it on, and the installer never offers the CodeGraph Pro waitlist.
- `codegraph upgrade` refuses for every install except a source checkout, since every other channel would install upstream's release over the fork.
- The release workflow only runs in `colbymchenry/codegraph`, and the site deploy workflow is removed.

## Install

The only install channel is a source checkout linked onto your `PATH`. It needs Node 22.13 or newer.

```bash
git clone git@github.com:dhritcu/codegraph-psql.git
cd codegraph-psql
npm ci
npm run build
npm link
```

`npm link` puts `codegraph` in npm's global bin folder. An upstream `codegraph` that sits earlier on your `PATH` shadows it. That includes the `install.sh` bundle and an `npm i -g @colbymchenry/codegraph`. Check which one runs:

```bash
which -a codegraph
codegraph upgrade   # the fork prints "Running from a source checkout at <path>."
```

If the fork's link is not first, remove the upstream install or reorder `PATH`.

## Update

```bash
git pull
npm ci
npm run build
```

`npm link` points at the checkout, so the rebuilt `dist/` is live at once.

## Sync with upstream

Remote `origin` is upstream and is read-only. Merge it into the fork's `main` on a branch, then open a PR so CI runs:

```bash
git fetch origin
git switch -c sync/upstream-$(date +%Y%m%d) main
git merge origin/main
npm ci && npm run build && npm test
```

Resolve conflicts in the fork's favor only in the files listed under "What the fork changes". Elsewhere, take upstream's version.

## File-boundary rule

The fork keeps merges cheap by staying out of upstream's code.

- SQL and PL/pgSQL logic lives in new files that upstream does not have.
- Upstream's hot files get registration lines only, such as one import and one registry entry. These are `src/resolution/name-matcher.ts`, `src/resolution/index.ts`, `src/extraction/tree-sitter.ts` and `src/resolution/callback-synthesizer.ts`.
- Never edit `CHANGELOG.md`. It is upstream's release history. Fork notes go in `CHANGELOG-psql.md`.

## What the fork changes

These upstream files carry fork edits and are where sync conflicts appear:

- `package.json` holds `private` and the `prepublishOnly` guard.
- `src/telemetry/index.ts` holds the off-by-default consent rule.
- `src/installer/beta-signup.ts` holds the no-op waitlist offer.
- `src/upgrade/index.ts` holds the upgrade refusal.
- `.github/workflows/release.yml` holds the repository gate on each job.
- `__tests__/telemetry.test.ts`, `__tests__/upgrade.test.ts`, `__tests__/beta-signup.test.ts` and `__tests__/installer-targets.test.ts` cover the above.

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run build` and `npm test` on macOS and Linux for every pull request and every push to `main`.
