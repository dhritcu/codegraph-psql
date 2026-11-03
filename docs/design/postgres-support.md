# PostgreSQL support

This page explains what the codegraph-psql fork indexes from PostgreSQL code, how it links TypeScript and JavaScript to it, what an agent sees, and where it stops. It ends with the validation run on three real repositories. Setup is in [FORK.md](../../FORK.md).

## What is indexed

The fork reads `.sql`, `.psql`, and `.pgsql` files with the PostgreSQL grammar. The body of a `LANGUAGE plpgsql` function, procedure, or `DO` block is parsed again with the PL/pgSQL grammar. A file written for MySQL or SQLite still indexes the statements PostgreSQL also reads, without a parse warning.

Each schema object becomes a node of an existing kind. The object type goes in the signature (`table: CREATE TABLE "Booking"`), so no new node kind exists and every viewer and filter works unchanged.

| SQL object | Node kind | Where it lives |
|---|---|---|
| schema | `namespace` | top level |
| extension | `module` | top level |
| table, view, materialized view | `class` | top level |
| column | `field` | in its table |
| function, procedure | `function` | top level, language in the signature |
| trigger | `method` | in its table |
| enum, and each enum value | `enum`, `enum_member` | top level |
| composite type | `struct` | top level |
| domain | `type_alias` | top level |
| sequence | `variable` | top level |
| index, policy, constraint | `property` | in its table |

An object that a table owns nests under the table when the same file declares the table. A trigger, index, policy, constraint, or column that a later migration adds stands alone, with the qualified name `schema::table::name` and a `references` edge to its table. Queries list it as a member of the table anyway.

Static references become edges at the line that names them: a column's type, a foreign key's target table, a view's tables, and a trigger's table and function.

## Names and migrations

Postgres folds an unquoted identifier to lower case and keeps a quoted one as written. The fork does the same: `Orders` and `orders` name one table, `"Orders"` names another. A name written without a schema lands in `public`. Qualified names join the folded parts with `::`, as in `public::orders` and `storage::objects`.

Most projects define their schema as a series of migrations, so one object has many definitions. The fork reads them in the order they apply:

- Migrations apply in path order, and statements in line order. A series is a file's path up to its first numbered segment, which fits timestamp-prefixed names from Supabase, Prisma, and Drizzle.
- The latest `CREATE` of a name wins. `CREATE OR REPLACE FUNCTION` in three migrations resolves to the third.
- A `DROP` ends the object from that point. A reference written while a definition was in force still resolves to it, and the output marks the object as dropped.
- A `DROP` counts where a migration runs it, at the top level or in a `DO` block. A `DROP` inside a function body does not count, since it runs only when the function is called.
- Files outside any series, such as one `schema.sql` and unrelated scripts, have no order. A name that several of them define resolves only within the reference's own file.

Calls to functions every database has (`now()`, `count(*)`) and names in the system schemas resolve to nothing, so they make no edge.

## Function bodies

The fork reads what a SQL or PL/pgSQL body, or a `DO` block, does. Each table the body reads or writes gets an edge that carries the operation (`select`, `insert`, `update`, `delete`, `merge`), and each function it calls gets a `calls` edge. An `INSERT ... ON CONFLICT DO UPDATE` counts as an update too. A body written as a single-quoted string with `''` escapes reads like a dollar-quoted one. A PL/pgSQL variable with the same name as a table does not hide the table.

## Triggers

A write to a table runs its triggers, though no line of the writer names them. For every edge that writes a table, from SQL or from application code, the fork adds a `calls` edge from the writer to each function a live trigger runs for that write.

- A trigger fires when its events name the write's event. `BEFORE`, `AFTER`, and `INSTEAD OF` all count, at row and at statement level.
- An `UPDATE OF a, b` trigger fires only for an update known to set `a` or `b`. An update whose columns are unknown fires only triggers without a column list.
- A trigger's `WHEN` condition is not evaluated. It is recorded on the edge.
- Triggers follow migration order. A later `DROP` of the trigger, its table, or its function ends it. `ALTER TABLE ... DISABLE TRIGGER` stops it until an `ENABLE`.
- A write that a migration runs itself, in a `DO` block, fires the triggers in force at that point. Every other write runs after all migrations, so it fires the triggers in force at the end.

## TypeScript and JavaScript links

Application code names its tables in strings the graph cannot otherwise follow. Two passes read those strings and link the enclosing function to the SQL node.

Query builders:

- Supabase: `.from('t')` with the operation of the first `.select`, `.insert`, `.update`, `.upsert`, or `.delete` chained on it, and `.rpc('f')`. A `.schema('x')` before either, or `db: { schema: 'x' }` in the client options, picks the schema.
- Knex: `db('t')`, `db.from('t')`, `db.table('t')`, and `db.into('t')`. With no write chained, a Knex builder runs a select.
- Kysely: `selectFrom`, `insertInto`, `updateTable`, and `deleteFrom`.
- Drizzle: `pgTable('t', ...)` and `pgSchema('x').table('t', ...)` link the declaring constant to its table, with no operation.

SQL in strings:

- `sql` templates from postgres.js, Slonik, Drizzle, and Kysely.
- `.query()` on a node-postgres `Pool` or `Client`, and `.raw()` on a Knex instance.
- Prisma's `$queryRaw` and `$executeRaw`, tagged or given a `Prisma.sql` template, and their `Unsafe` forms.

The fork parses each literal with the PostgreSQL grammar. Each `${...}` hole becomes a parameter, so positions in the statement stay positions in the file. A literal that does not parse clean makes nothing.

A call counts only on a receiver with evidence. The receiver must come from the client's own factory or package, from a function in the file whose body calls that factory, or from a parameter typed as the client. Evidence can come from one project import away, no further. Any other `.from('orders')` makes no edge.

A client call links to a schema in another package only when its own package depends on that package, or when the schema sits in a workspace database package such as `packages/db`. Sibling example apps in one repository therefore do not link to each other's tables.

## What an agent sees

`codegraph_explore` takes the symbol names the agent asks about and leads with the path among them. SQL adds three things to that output:

- Each SQL hop names its operation (`insert into error`) or its trigger, with timing, event, and the line that declares it: `dynamic: trigger update_objects_updated_at BEFORE UPDATE ON objects @.../0011-...sql:10`. A hop through an object that a later migration dropped or redefined is marked, and a path that still runs is preferred.
- A table that the query names gets a block. The block lists the live triggers and the function each one runs, and states that the list is complete as of the last migration. It lists writers by operation and the triggers each writer fires, then the policies, the indexes, and the dropped triggers with their drop sites.
- The source section leads with the live trigger functions and the functions that fire them. Bodies that a later migration dropped or redefined are listed by declaration and drop site instead of printed.

`codegraph node`, `codegraph callers`, and `codegraph impact` name what each function does to a table (`[insert]`). They show only the live definition of a view or function that migrations redefine. A table's trail lists the tables its foreign keys point at under **Calls** and the code that reads or writes it under **Called by**.

## Grammar

The grammars come from [gmr/tree-sitter-postgres](https://github.com/gmr/tree-sitter-postgres) at tag `v1.2.4`, with a patch that backports three upstream fixes and adds three PL/pgSQL fixes of its own. [docs/grammars/tree-sitter-postgres.md](../grammars/tree-sitter-postgres.md) records the pin, the patch, and the rebuild steps. Both wasm files are vendored in `src/extraction/wasm/`.

## Known gaps

These are open issues on [dhritcu/codegraph-psql](https://github.com/dhritcu/codegraph-psql/issues). Each one either loses an edge or shows a wrong fact.

- Dynamic SQL: `EXECUTE` and `EXECUTE format(...)`, and SQL built by string concatenation, make no edge.
- ORMs other than the ones listed: Prisma's model API (`prisma.booking.create`), TypeORM, Sequelize, and MikroORM make no edge.
- Project-defined query wrappers are not followed, for example `this.query(db, { text })` in supabase/storage ([#30](https://github.com/dhritcu/codegraph-psql/issues/30)).
- Tables created inside `DO` blocks are not extracted ([#11](https://github.com/dhritcu/codegraph-psql/issues/11)), and neither are triggers created there or through `EXECUTE` ([#28](https://github.com/dhritcu/codegraph-psql/issues/28)).
- A foreign key that a later migration adds to an existing table does not link the two tables, so the table's trail misses it ([#29](https://github.com/dhritcu/codegraph-psql/issues/29)). The table block does not list incoming foreign keys and their `ON DELETE` actions ([#23](https://github.com/dhritcu/codegraph-psql/issues/23)).
- A top-level `UPDATE` or `DELETE` in a migration records no write ([#22](https://github.com/dhritcu/codegraph-psql/issues/22)).
- `ALTER TABLE ... RENAME TO` is not modeled ([#10](https://github.com/dhritcu/codegraph-psql/issues/10)).
- A migration marked `-- postgres-migrations ignore` is treated as applied ([#31](https://github.com/dhritcu/codegraph-psql/issues/31)).
- A sync whose only change is a `DROP` leaves stale SQL edges ([#9](https://github.com/dhritcu/codegraph-psql/issues/9)).
- The explore blast radius lists dropped SQL objects ([#24](https://github.com/dhritcu/codegraph-psql/issues/24)), and `ALTER EXTENSION ... DROP FUNCTION` counts as a drop ([#27](https://github.com/dhritcu/codegraph-psql/issues/27)).
- Prisma raw-SQL detection trusts any receiver in a file that imports a module with "prisma" in its name ([#25](https://github.com/dhritcu/codegraph-psql/issues/25)).
- Non-Postgres dialects: dialect detection misfires on some Postgres files ([#19](https://github.com/dhritcu/codegraph-psql/issues/19)), MySQL backslash escapes confuse the statement splitter ([#20](https://github.com/dhritcu/codegraph-psql/issues/20)), and psql variables inside array brackets are no longer blanked ([#18](https://github.com/dhritcu/codegraph-psql/issues/18)).
- Files over 1 MiB, such as a large `structure.sql`, are skipped and named in `codegraph status`.
- `devEngines` allows Node versions whose SQLite lacks FTS5 ([#12](https://github.com/dhritcu/codegraph-psql/issues/12)).

## Validation

The fork was validated on 2026-11-03 at `3248632b` plus this change, against upstream `main` at `f72c9d2e` for the control. The per-run transcripts are not checked in.

### Setup

- Repositories, at the SHAs pinned in `.claude/skills/agent-eval/corpus.json`: supabase/storage (small, 808 files indexed, 114 `.sql`), calcom/cal.com (medium, 5,752 files), and supabase/supabase (large, 9,557 files, 111 `.sql`). The control is excalidraw (738 files).
- Three flow prompts per repository, also in `corpus.json`. Each prompt was first run through `scripts/agent-eval/probe-explore.mjs` to confirm that the graph holds the answer.
- `scripts/agent-eval/run-all.sh`, headless, `--model sonnet --effort high`, with a pre-warmed codegraph daemon for each codegraph run. Two runs per arm per prompt, in the order with, without, without, with.
- The control ran the excalidraw corpus question with codegraph on in both arms: this build against the upstream build, each on an index it built, in the order head, base, base, head.
- Counted per run: `Read`, `Grep` (including `Glob`), Bash commands that read source (`rg`, `grep`, `cat`, `sed`, `head`, `tail`, `find`, `ls`, `awk`, `wc`), codegraph tool calls, wall time, and cost. A separate reviewer graded each answer against the source as correct, partial, or wrong.
- Contamination: every one of the 40 runs shows 0 codegraph CLI calls that returned output, so no run is void.

### Results per run

| Prompt | Arm | Run | Read | Grep | Bash reads | codegraph calls | Time (s) | Cost (USD) | Correct |
|---|---|---|---|---|---|---|---|---|---|
| calcom-1 | with | 1 | 0 | 0 | 1 | 1 | 9 | 0.293 | correct |
| calcom-1 | with | 2 | 0 | 0 | 1 | 1 | 7 | 0.077 | correct |
| calcom-1 | without | 1 | 1 | 0 | 2 | 0 | 11 | 0.255 | correct |
| calcom-1 | without | 2 | 1 | 0 | 3 | 0 | 11 | 0.053 | correct |
| calcom-2 | with | 1 | 0 | 0 | 4 | 0 | 21 | 0.305 | correct |
| calcom-2 | with | 2 | 0 | 0 | 3 | 0 | 18 | 0.079 | correct |
| calcom-2 | without | 1 | 2 | 0 | 5 | 0 | 21 | 0.360 | correct |
| calcom-2 | without | 2 | 0 | 0 | 3 | 0 | 14 | 0.063 | correct |
| calcom-3 | with | 1 | 0 | 0 | 7 | 0 | 45 | 0.375 | correct |
| calcom-3 | with | 2 | 0 | 0 | 4 | 0 | 30 | 0.111 | partial |
| calcom-3 | without | 1 | 0 | 0 | 7 | 0 | 25 | 0.319 | partial |
| calcom-3 | without | 2 | 0 | 0 | 8 | 0 | 40 | 0.151 | correct |
| excalidraw | head | 1 | 0 | 0 | 0 | 2 | 20 | 0.190 | correct |
| excalidraw | head | 2 | 0 | 0 | 0 | 2 | 16 | 0.117 | correct |
| excalidraw | base | 1 | 0 | 0 | 0 | 2 | 19 | 0.192 | correct |
| excalidraw | base | 2 | 0 | 0 | 0 | 2 | 18 | 0.118 | correct |
| storage-1 | with | 1 | 0 | 0 | 4 | 1 | 25 | 0.258 | correct |
| storage-1 | with | 2 | 0 | 0 | 3 | 1 | 20 | 0.114 | correct |
| storage-1 | without | 1 | 0 | 0 | 8 | 0 | 30 | 0.209 | correct |
| storage-1 | without | 2 | 0 | 0 | 6 | 0 | 24 | 0.108 | correct |
| storage-2 | with | 1 | 0 | 0 | 5 | 0 | 30 | 0.171 | correct |
| storage-2 | with | 2 | 0 | 0 | 9 | 0 | 43 | 0.186 | correct |
| storage-2 | without | 1 | 0 | 0 | 6 | 0 | 29 | 0.191 | correct |
| storage-2 | without | 2 | 6 | 0 | 8 | 0 | 39 | 0.208 | correct |
| storage-3 | with | 1 | 0 | 0 | 8 | 1 | 59 | 0.320 | correct |
| storage-3 | with | 2 | 0 | 0 | 5 | 1 | 36 | 0.168 | correct |
| storage-3 | without | 1 | 0 | 0 | 18 | 0 | 65 | 0.354 | correct |
| storage-3 | without | 2 | 1 | 0 | 14 | 0 | 70 | 0.282 | correct |
| supabase-1 | with | 1 | 0 | 0 | 2 | 1 | 21 | 0.166 | correct |
| supabase-1 | with | 2 | 0 | 0 | 2 | 1 | 16 | 0.083 | partial |
| supabase-1 | without | 1 | 2 | 0 | 6 | 0 | 23 | 0.173 | correct |
| supabase-1 | without | 2 | 0 | 0 | 5 | 0 | 19 | 0.061 | partial |
| supabase-2 | with | 1 | 0 | 0 | 3 | 1 | 20 | 0.170 | correct |
| supabase-2 | with | 2 | 0 | 0 | 2 | 1 | 22 | 0.082 | correct |
| supabase-2 | without | 1 | 0 | 0 | 4 | 0 | 19 | 0.137 | correct |
| supabase-2 | without | 2 | 2 | 0 | 5 | 0 | 29 | 0.099 | correct |
| supabase-3 | with | 1 | 0 | 0 | 4 | 0 | 20 | 0.150 | correct |
| supabase-3 | with | 2 | 0 | 0 | 4 | 0 | 19 | 0.080 | correct |
| supabase-3 | without | 1 | 0 | 0 | 3 | 0 | 19 | 0.131 | correct |
| supabase-3 | without | 2 | 0 | 0 | 4 | 0 | 18 | 0.077 | correct |

### Results per lane

The plan's pass bar for a lane is 0 `Read` and 0 `Grep` in the codegraph arm, and a faster codegraph arm. Two runs per arm cannot separate a few seconds from run-to-run noise, so "faster" below means faster in both runs, and anything else is "not shown".

| Lane | Prompt | Read and Grep in the codegraph arm | Faster | Bash reads, with vs without | Verdict |
|---|---|---|---|---|---|
| 2 | storage-1 | 0 and 0 | yes, 25 and 20 s vs 30 and 24 s | 4, 3 vs 8, 6 | pass |
| 3 | storage-2 | 0 and 0 | no, 30 and 43 s vs 29 and 39 s | 5, 9 vs 6, 8 | fail: codegraph never called |
| 4 | storage-3 | 0 and 0 | yes, 59 and 36 s vs 65 and 70 s | 8, 5 vs 18, 14 | pass |
| 5 | calcom-1 | 0 and 0 | yes, 9 and 7 s vs 11 and 11 s | 1, 1 vs 2, 3 | pass |
| 6 | calcom-2 | 0 and 0 | no, 21 and 18 s vs 21 and 14 s | 4, 3 vs 5, 3 | fail: codegraph never called |
| 6 | calcom-3 | 0 and 0 | no, 45 and 30 s vs 25 and 40 s | 7, 4 vs 7, 8 | fail: codegraph never called |
| 7 | supabase-1 | 0 and 0 | yes, 21 and 16 s vs 23 and 19 s | 2, 2 vs 6, 5 | pass |
| 8 | supabase-2 | 0 and 0 | not shown, 20 and 22 s vs 19 and 29 s | 3, 2 vs 4, 5 | pass on reads, time not shown |
| 8 | supabase-3 | 0 and 0 | no, 20 and 19 s vs 19 and 18 s | 4, 4 vs 3, 4 | fail: codegraph never called |
| 1 | excalidraw control | 0 and 0 in both arms | head 20 and 16 s vs upstream 19 and 18 s | 0 vs 0 | pass: no slower, no more reads |
| 9 | contamination | 0 in all 40 runs | | | pass |

What the numbers say:

- When the agent called `codegraph_explore`, one call was enough. Every such run made exactly one call and used no `Read` or `Grep`. Its prompt needed fewer Bash reads than in the without arm, about half at the median. The answer was as correct as the without arm's in every prompt.
- In 8 of the 18 codegraph-arm runs, the agent never called codegraph. Those runs are storage-2, calcom-2, calcom-3, and supabase-3, both runs each. The MCP server was connected in every one of them. The agent went to `rg` and `sed` on the migrations first. The prompts it skipped codegraph on ask about "every trigger still live after the last migration", "foreign keys across the Prisma migrations", or "policies in the example's migration". Prompts that named a code symbol, such as `listWithTeamHandler`, `uploadErrorCodes`, or `syncDiscussionUpdates`, got an explore call every time. This is the tool-choice limit that AGENTS.md describes, and it is not something the fork's output can change.
- `Read` stays 0 across the codegraph arm, but the agent still reads files through Bash, 1 to 9 times per run. The plan's bar counts only `Read` and `Grep`, so it is met on paper in every lane. The Bash reads show that the agent still checks the migrations after an explore. It checks most often for completeness, for example that no later migration adds another trigger.
- Correctness does not separate the arms. Each arm has one partial answer on calcom-3, from listing dropped tables as live, and both arms have one partial answer on supabase-1, from a summary line that contradicts the body.

### Performance

Index time is a fresh `codegraph init`, end to end. Explore latency is one `codegraph_explore` call on a warm, in-process handler. The two builds alternate in every round. The excalidraw rows come from a second pass of 5 index rounds and of 6 explore rounds of 15 calls each, run at a load average of 5 to 7. The first pass ran at a load average of 9 to 17 with 3 calls per round, and showed this fork slower: index 8.12 s vs 7.94 s, explore 78.9 ms vs 64.8 ms. The second pass shows no difference, and both builds return byte-identical explore output, so the first pass most likely measured the load rather than the change.

| Repository | Index, this fork | Index, upstream | Explore, this fork | Explore, upstream | Budget |
|---|---|---|---|---|---|
| excalidraw | 5.62 s (5.41 to 6.29) | 5.62 s (5.56 to 5.73) | 59.8 ms (59.0 to 60.3) | 59.1 ms (58.8 to 60.5) | at most 5% slower: met, no measurable difference |
| supabase/storage | 4.76 s (4.58 to 5.50) | 4.48 s (4.23 to 4.88) | 40.2 ms (38.7 to 42.8) | not comparable | explore under 3 s: met |
| calcom/cal.com | 12.83 s (12.24 to 14.82) | 12.26 s (11.69 to 14.18) | 106.2 ms (103.3 to 108.2) | not comparable | explore under 3 s: met |
| supabase/supabase | 30.20 s (29.24 to 34.61) | 28.34 s (27.47 to 36.00) | 178.7 ms (175.5 to 181.2) | not comparable | index under 2 min and explore under 3 s: met |

Values are medians of 5 runs with the range. On excalidraw both builds produce the same graph, 14,369 nodes and 62,078 edges, and the same explore output byte for byte. On the SQL repositories upstream skips the `.sql` files, so its index is smaller and its explore answers a different graph. Its latency there is not a baseline. The fork's extra index time on those repositories, about 5 to 7 percent, is the cost of the SQL files and the passes that link them.
