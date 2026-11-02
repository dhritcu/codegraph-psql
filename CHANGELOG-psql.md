# codegraph-psql changelog

Changes in the codegraph-psql fork. Upstream's changes are in `CHANGELOG.md`.

## [Unreleased]

### New Features

- The fork installs from a source checkout with `npm link`, and `FORK.md` explains setup, updating, and syncing with upstream.
- Every pull request now runs the build and the full test suite on macOS and Linux.

### Fixes

- Telemetry is now off by default, so the fork sends no usage data unless you turn it on with `codegraph telemetry on`.
- `codegraph install` and `codegraph upgrade` no longer offer the CodeGraph Pro waitlist.
- `codegraph upgrade` now refuses outside a source checkout instead of replacing the fork with upstream CodeGraph, and prints how to update the fork.
- `npm publish` now refuses, so the fork can never be published under the upstream package name.
