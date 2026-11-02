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
 * The DROPs and trigger switches this module reads (`sqlDdlEvents`) are the
 * one model of what a migration ends; the trigger pass reads them too.
 */

import type { Language, Node, NodeKind } from '../../types';
import { splitOpReferenceName } from '../../extraction/languages/postgres-bodies';
import { foldObjectName, qualify, splitIdentifierPath } from '../../extraction/languages/postgres-names';
import { POSTGRES_BUILTIN_FUNCTIONS } from '../postgres-builtins';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { makeLineAt } from '../synth-utils';

const SQL_LANGUAGES: readonly Language[] = ['postgres', 'plpgsql'];
const SQL_FILE = /\.(?:sql|psql|pgsql)$/i;
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

const CLASS_OF_DROP: Record<string, ObjectClass> = {
  table: 'relation',
  view: 'relation',
  'materialized view': 'relation',
  function: 'routine',
  procedure: 'routine',
  routine: 'routine',
  type: 'type',
  domain: 'type',
};

/** Where a statement sits in the order migrations apply. */
export interface SqlPosition {
  file: string;
  line: number;
}

/** A definition (`node`) or a DROP (`node: null`) of one name. */
interface SqlEvent {
  at: SqlPosition;
  node: Node | null;
}

const naturalOrder = new Intl.Collator('en', { numeric: true }).compare;

export function comparePositions(a: SqlPosition, b: SqlPosition): number {
  return a.file === b.file ? a.line - b.line : naturalOrder(a.file, b.file);
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
 * The migration series a file belongs to: its path up to the first directory
 * or file name that starts with a sequence number (`supabase/migrations` for
 * `supabase/migrations/20240101_init.sql`, `prisma/migrations` for
 * `prisma/migrations/20240101_init/migration.sql`), or null for a file that
 * is no migration.
 */
export function migrationSeries(filePath: string): string | null {
  const parts = filePath.split('/');
  const numbered = parts.findIndex((p) => /^\d+(?:[_\-.]|$)/.test(p));
  if (numbered >= 0) return parts.slice(0, numbered).join('/');
  const dir = parts.slice(0, -1);
  return dir.some((p) => /^migrations?$/i.test(p)) ? dir.join('/') : null;
}

/** Where a statement's order counts: its migration series, or its own file when that is no migration. */
export const ddlScope = (file: string): string => migrationSeries(file) ?? file;

export const IDENT = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)`;
export const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;

/**
 * `text` with comments and single-quoted strings blanked, offsets and
 * newlines kept. With `dollarBodies`, routine bodies are blanked too, but a
 * DO block's body stays, since it runs as the migration applies; without,
 * the first dollar quote ends the text, as it ends the body a statement
 * inside a routine is read from.
 */
export function codeOnly(text: string, dollarBodies: boolean): string {
  let out = '';
  let copied = 0;
  let i = 0;
  let doClose: string | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    let end = -1;
    if (ch === '-' && text[i + 1] === '-') {
      end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
    } else if (ch === '/' && text[i + 1] === '*') {
      end = text.indexOf('*/', i + 2);
      end = end < 0 ? text.length : end + 2;
    } else if (ch === "'") {
      end = i + 1;
      while (end < text.length && !(text[end] === "'" && text[end + 1] !== "'")) end += text[end] === "'" ? 2 : 1;
      end = Math.min(end + 1, text.length);
    } else if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64))?.[0];
      if (tag && !dollarBodies) return out + text.slice(copied, i);
      if (tag && (tag === doClose || (!doClose && /\bdo\s*$/i.test(text.slice(Math.max(0, i - 16), i))))) {
        doClose = tag === doClose ? null : tag;
        i += tag.length;
        continue;
      }
      if (tag) {
        const close = text.indexOf(tag, i + tag.length);
        end = close < 0 ? text.length : close + tag.length;
      }
    }
    if (end > i) {
      out += text.slice(copied, i) + text.slice(i, end).replace(/[^\n]/g, ' ');
      copied = i = end;
    } else {
      i++;
    }
  }
  return out + text.slice(copied);
}

/** Where a statement can start: a file's top level, or a PL/pgSQL block. */
const STATEMENT_START = String.raw`(?:^|;|\b(?:begin|then|else|loop)\b)\s*`;
const MAY_END = /\b(?:drop|disable|enable)\s/i;
const DROP_STATEMENT = new RegExp(
  STATEMENT_START + String.raw`drop\s+(table|view|materialized\s+view|function|procedure|routine|type|domain|trigger)\s+(?:if\s+exists\s+)?([^;]*)`,
  'gi'
);
const DROPPED_TRIGGER = new RegExp(String.raw`^(${IDENT})\s+ON\s+(${QUALIFIED})`, 'i');
const ALTER_TABLE = new RegExp(
  STATEMENT_START + String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUALIFIED})\s*\*?\s+([^;]*)`,
  'gi'
);
const TRIGGER_SWITCH = new RegExp(String.raw`\b(disable|enable)(?:\s+(replica|always))?\s+trigger\s+(${IDENT})`, 'gi');

/** `a.f(int, text), "B"` → its object names, argument lists and CASCADE dropped. */
function droppedNames(list: string): string[] {
  let names = list.replace(/\b(?:cascade|restrict)\s*$/i, '');
  for (let prev = ''; prev !== names; ) {
    prev = names;
    names = names.replace(/\([^()]*\)/g, '');
  }
  return names
    .split(',')
    .map((n) => foldObjectName(n.trim()))
    .filter((n): n is NonNullable<typeof n> => n !== null && n.name !== '')
    .map((n) => qualify(n));
}

/**
 * A DROP of an object, or an `ALTER TABLE ... DISABLE / ENABLE TRIGGER`.
 * `ENABLE REPLICA` leaves a trigger firing only on a replica, so it reads as a disable.
 */
export interface SqlDdlEvent {
  at: SqlPosition;
  kind: 'drop' | 'disable' | 'enable';
}

/**
 * Every DROP and trigger switch the project's SQL files run as they apply,
 * keyed `relation:`, `routine:` or `type:` and a qualified name,
 * `trigger:<table>::<trigger>`, or `triggers:<table>` for `ALL` / `USER`.
 */
function readDdl(context: ResolutionContext): Map<string, SqlDdlEvent[]> {
  const events = new Map<string, SqlDdlEvent[]>();
  const add = (key: string, event: SqlDdlEvent): void => {
    const list = events.get(key) ?? [];
    list.push(event);
    events.set(key, list);
  };
  for (const file of context.getAllFiles()) {
    if (!SQL_FILE.test(file)) continue;
    const text = context.readFile(file);
    if (!text || !MAY_END.test(text)) continue;
    const code = codeOnly(text, true);
    const lineAt = makeLineAt(code, 1);
    const at = (m: RegExpMatchArray): SqlPosition => ({ file, line: lineAt(m.index! + m[0].search(/drop|alter/i)) });
    for (const m of code.matchAll(DROP_STATEMENT)) {
      const objectType = m[1]!.toLowerCase().replace(/\s+/, ' ');
      if (objectType === 'trigger') {
        const t = DROPPED_TRIGGER.exec(m[2]!);
        const name = t && splitIdentifierPath(t[1]!)[0];
        const table = t && foldObjectName(t[2]!);
        if (name && table) add(`trigger:${qualify(table, name)}`, { at: at(m), kind: 'drop' });
        continue;
      }
      for (const name of droppedNames(m[2]!)) add(`${CLASS_OF_DROP[objectType]}:${name}`, { at: at(m), kind: 'drop' });
    }
    for (const m of code.matchAll(ALTER_TABLE)) {
      const table = foldObjectName(m[1]!);
      if (!table) continue;
      for (const s of m[2]!.matchAll(TRIGGER_SWITCH)) {
        const raw = s[3]!;
        const kind = s[1]!.toLowerCase() === 'disable' || s[2]?.toLowerCase() === 'replica' ? 'disable' : 'enable';
        const all = /^(?:all|user)$/i.test(raw);
        const name = splitIdentifierPath(raw)[0];
        if (all) add(`triggers:${qualify(table)}`, { at: at(m), kind });
        else if (name) add(`trigger:${qualify(table, name)}`, { at: at(m), kind });
      }
    }
  }
  return events;
}

/**
 * The DDL read for one generation of the resolver's caches: the file-node
 * list is rebuilt whenever they are cleared, as after a sync.
 */
const ddlIndexes = new WeakMap<ResolutionContext, { source: readonly Node[]; events: Map<string, SqlDdlEvent[]> }>();

export function sqlDdlEvents(context: ResolutionContext): Map<string, SqlDdlEvent[]> {
  const source = context.getNodesByKind('file');
  let entry = ddlIndexes.get(context);
  if (!entry || entry.source !== source) {
    entry = { source, events: readDdl(context) };
    ddlIndexes.set(context, entry);
  }
  return entry.events;
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
  const events: SqlEvent[] = pool.map((node) => ({ at: { file: node.filePath, line: node.startLine }, node }));
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
