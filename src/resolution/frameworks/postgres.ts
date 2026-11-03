/**
 * PostgreSQL name resolution.
 *
 * The extractor writes every SQL reference as a folded qualified name,
 * `schema::name`, with `public` for a name written without a schema. This
 * resolver binds it to the object of that exact qualified name, and answers
 * every SQL reference alone: no name strategy guesses past it.
 *
 * A project usually defines its schema as a series of migrations, so one
 * object can have many definitions: `CREATE OR REPLACE FUNCTION` in three
 * migrations, a table dropped and created again. Migrations apply in path
 * order, and `history` reads the definitions and DROPs of a name in that
 * order: the latest CREATE wins; a name the last statement drops resolves
 * only for a reference written while a definition was in force. A DROP
 * counts where it runs as the migration applies: at the top level or in a DO
 * block, not in a routine body, which runs only when called. Files that
 * are not migrations (one `schema.sql`, unrelated scripts) have no order, so
 * a name several of them define resolves only within the reference's own file.
 *
 * Calls to the functions every database has (`now()`, `count(*)`) and names
 * in the system schemas resolve to nothing. The operation a body reference
 * performs on its table travels to the edge as `metadata.op`.
 *
 * The order migrations apply in and what a migration ends come from the
 * shared SQL model (`sql-model.ts`), which the trigger pass reads too.
 */

import type { Language, Node, NodeKind } from '../../types';
import { splitOpReferenceName } from '../../extraction/languages/postgres-bodies';
import { POSTGRES_BUILTIN_FUNCTIONS } from '../postgres-builtins';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { comparePositions, migrationSeries, nodePosition, SQL_FILE, sqlDdlEvents, type SqlPosition } from '../sql-model';

const SQL_LANGUAGES: readonly Language[] = ['postgres', 'plpgsql'];
const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);

/** The object kinds a reference of each kind can bind to. */
const TARGET_KINDS: Partial<Record<string, ReadonlySet<NodeKind>>> = {
  calls: new Set(['function']),
  references: new Set(['class']),
  extends: new Set(['class']),
  type_of: new Set(['enum', 'struct', 'type_alias', 'class']),
};

/** Relations, routines and types are separate namespaces: `DROP FUNCTION x` leaves table `x` alone. */
type ObjectClass = 'relation' | 'routine' | 'type';

const CLASS_OF_KIND: Partial<Record<NodeKind, ObjectClass>> = {
  class: 'relation',
  function: 'routine',
  enum: 'type',
  struct: 'type',
  type_alias: 'type',
};

/** A definition (`node`) or a DROP (`node: null`) of one name. */
interface SqlEvent {
  at: SqlPosition;
  node: Node | null;
}

/**
 * The definition a reference at `at` binds to, from every definition and
 * DROP of its name in apply order. The latest definition wins when nothing
 * drops it after; otherwise the one in force where the reference is written.
 */
function history(events: SqlEvent[], at: SqlPosition): Node | null {
  const ordered = [...events].sort((a, b) => comparePositions(a.at, b.at));
  const last = ordered[ordered.length - 1];
  if (!last) return null;
  if (last.node) return last.node;
  let live: Node | null = null;
  for (const event of ordered) {
    if (comparePositions(event.at, at) > 0) break;
    live = event.node;
  }
  return live;
}

/**
 * The definition a reference to `qualifiedName` at `at` binds to among
 * `defs`, every definition of that name. Definitions in the reference's own
 * migration series come first. Unordered files leave only the reference's own
 * file to choose from.
 */
function chooseDefinition(qualifiedName: string, defs: Node[], at: SqlPosition, context: ResolutionContext): Node | null {
  const refSeries = migrationSeries(at.file);
  const sameSeries = refSeries === null ? [] : defs.filter((d) => migrationSeries(d.filePath) === refSeries);
  let pool = sameSeries.length > 0 ? sameSeries : defs;
  if (pool.length > 1 && pool.some((d) => migrationSeries(d.filePath) === null)) {
    pool = pool.filter((d) => d.filePath === at.file);
    if (pool.length === 0) return null;
  }
  const events: SqlEvent[] = pool.map((node) => ({ at: nodePosition(node), node }));
  // A DROP counts in the definitions' own migration series, or in a
  // definition's own file when that is no migration.
  const series = new Set(pool.map((d) => migrationSeries(d.filePath)));
  const defFiles = new Set(pool.map((d) => d.filePath));
  const inScope = (file: string): boolean => {
    const s = migrationSeries(file);
    return s === null ? defFiles.has(file) : series.has(s);
  };
  const ddl = sqlDdlEvents(context);
  for (const objectClass of new Set(pool.map((d) => CLASS_OF_KIND[d.kind]))) {
    for (const drop of ddl.get(`${objectClass}:${qualifiedName}`) ?? []) {
      if (inScope(drop.at.file)) events.push({ at: drop.at, node: null });
    }
  }
  return history(events, at);
}

function isBuiltin(qualifiedName: string, kind: string): boolean {
  const sep = qualifiedName.indexOf('::');
  const schema = qualifiedName.slice(0, sep);
  if (SYSTEM_SCHEMAS.has(schema)) return true;
  return kind === 'calls' && schema === 'public' && POSTGRES_BUILTIN_FUNCTIONS.has(qualifiedName.slice(sep + 2));
}

const isSqlRef = (ref: UnresolvedRef): boolean => SQL_LANGUAGES.includes(ref.language);

export const postgresResolver: FrameworkResolver = {
  name: 'postgres',
  languages: [...SQL_LANGUAGES],

  detect(context: ResolutionContext): boolean {
    return context.getAllFiles().some((f) => SQL_FILE.test(f));
  },

  // Every SQL name is a folded qualified name; let each reach resolve(),
  // which is the only strategy that answers one.
  claimsReference: () => true,
  ownsReference: (ref) => isSqlRef(ref),

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (!isSqlRef(ref)) return null;
    const { op, qualifiedName } = splitOpReferenceName(ref.referenceName);
    if (!qualifiedName.includes('::') || isBuiltin(qualifiedName, ref.referenceKind)) return null;
    const kinds = TARGET_KINDS[ref.referenceKind];
    const defs = context
      .getNodesByQualifiedName(qualifiedName)
      .filter((n) => SQL_LANGUAGES.includes(n.language) && (kinds ? kinds.has(n.kind) : n.kind !== 'file'));
    if (defs.length === 0) return null;
    const target = chooseDefinition(qualifiedName, defs, { file: ref.filePath, line: ref.line }, context);
    if (!target) return null;
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.95,
      resolvedBy: 'framework',
      ...(op ? { metadata: { op } } : {}),
    };
  },
};
