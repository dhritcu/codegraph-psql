# codegraph-psql changelog

Changes in the codegraph-psql fork. Upstream's changes are in `CHANGELOG.md`.

## [Unreleased]

### New Features

- The fork installs from a source checkout with `npm link`, and `FORK.md` explains setup, updating, and syncing with upstream.
- Every pull request now runs the build and the full test suite on macOS and Linux.
- `codegraph_explore` follows a SQL write through the table it touches into the trigger it fires, and a flow can end at a table you name, with the operation (`insert into orders`) and the trigger's timing and event on each hop.
- `codegraph node`, `codegraph callers` and `codegraph impact` name what each function does to a table (`[insert]`), list columns and triggers that later migrations add as members of their table, and show only the live definition of a view or function that migrations redefine.
- The viewer colors SQL keywords and names a missing table without an internal operation prefix.
- When `codegraph_explore` shows a SQL table, its source section leads with the live trigger functions and the functions that fire them, and names bodies a later migration dropped or redefined instead of printing them.
- A SQL table's trigger list now says it is complete as of the last migration, so you don't have to check later migrations for more.
- TypeScript and JavaScript code that queries Postgres through Supabase (`.from`, `.rpc`), Knex, Kysely, or a Drizzle `pgTable` now links to the tables and functions it names in your migrations, so `codegraph_explore` follows an API handler into SQL and on to the triggers its writes fire.

### Fixes

- A `codegraph_explore` flow through SQL functions or triggers that a later migration dropped or redefined now marks each such hop, and prefers a path that still runs.
- A write a migration runs in a `DO` block now lists as `DO block in <file>:<line>` instead of as the bare file.
- Telemetry is now off by default, so the fork sends no usage data unless you turn it on with `codegraph telemetry on`.
- `codegraph install` and `codegraph upgrade` no longer offer the CodeGraph Pro waitlist.
- `codegraph upgrade` now refuses outside a source checkout instead of replacing the fork with upstream CodeGraph, and prints how to update the fork.
- `npm publish` now refuses, so the fork can never be published under the upstream package name.
- `codegraph install` no longer offers to install upstream CodeGraph with `npm install -g`, which replaced the fork on your `PATH`; it tells you to run `npm link` in the fork's checkout instead.
- The installer's usage-stats question now defaults to No, so pressing Enter keeps telemetry off.
- `codegraph upgrade` in a source checkout now prints the full update command, including `npm ci`.
- A `.sql` file written for MySQL or SQLite now indexes the statements PostgreSQL also reads, without a "could not be parsed" warning (#4).
- `codegraph index` and `codegraph status` now name the files skipped for being over 1 MiB, such as a large `structure.sql` (#6).
- A PL/pgSQL variable or parameter with the same name as a table no longer hides that table's reads and writes.
- An array slice such as `tags[lo:hi]` no longer drops its statement from a `.sql` file.
- Function bodies written as a single-quoted string, with `''` escapes, are now read like dollar-quoted ones.
- The word INTO inside a string or comment in a function body no longer hides the statement around it.
- Trigger edges now follow the order migrations apply: a DROP in a DO block ends an object for name resolution too, a write a migration runs fires only the triggers that exist at that point, and `ALTER TABLE ... DISABLE TRIGGER` stops a trigger until it is enabled again.
