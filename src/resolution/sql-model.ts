/**
 * The model of a SQL schema every Postgres pass and SQL surface shares: the
 * order migrations apply in, what a DROP or a trigger switch ends, and which
 * TypeScript / JavaScript imports make a database client.
 *
 * Migrations apply in path order, statements in line order. A migration
 * series is a file's path up to its first numbered segment; a file outside
 * any series has no order with the others.
 *
 * Two readings of the DDL a migration runs exist (`DDL_READINGS`): the
 * resolver's, and the query-time surfaces', which key a routine's DROP by its
 * argument types. Where they differ, each field says how.
 */

import type { Node } from '../types';
import { foldObjectName, qualify, splitIdentifierPath } from '../extraction/languages/postgres-names';
import type { ResolutionContext } from './types';
import { makeLineAt } from './synth-utils';

export const SQL_FILE = /\.(?:sql|psql|pgsql)$/i;

// =============================================================================
// Apply order
// =============================================================================

/** Where a statement sits in the order migrations apply. */
export interface SqlPosition {
  file: string;
  line: number;
}

export const comparePaths = new Intl.Collator('en', { numeric: true }).compare;

export function comparePositions(a: SqlPosition, b: SqlPosition): number {
  return a.file === b.file ? a.line - b.line : comparePaths(a.file, b.file);
}

export const nodePosition = (node: Node): SqlPosition => ({ file: node.filePath, line: node.startLine });

/** Two definitions in apply order: the later one is the live one. */
export const compareNodes = (a: Node, b: Node): number => comparePositions(nodePosition(a), nodePosition(b));

/**
 * The migration series a file belongs to: its path up to the first directory
 * or file name that starts with a sequence number (`supabase/migrations` for
 * `supabase/migrations/20240101_init.sql`, `prisma/migrations` for
 * `prisma/migrations/20240101_init/migration.sql`), or its directory when a
 * `migrations` folder holds it. A file that is no migration has no series:
 * null, or with `outside`, the file itself (`'file'`) or its directory
 * (`'directory'`, which groups a folder of unnumbered scripts as one series).
 */
export function migrationSeries(filePath: string): string | null;
export function migrationSeries(filePath: string, outside: 'file' | 'directory'): string;
export function migrationSeries(filePath: string, outside?: 'file' | 'directory'): string | null {
  const parts = filePath.split('/');
  const numbered = parts.findIndex((p) => /^\d+(?:[_\-.]|$)/.test(p));
  if (numbered >= 0) return parts.slice(0, numbered).join('/');
  const dir = parts.slice(0, -1);
  if (outside === 'directory' || dir.some((p) => /^migrations?$/i.test(p))) return dir.join('/');
  return outside === 'file' ? filePath : null;
}

// =============================================================================
// SQL text
// =============================================================================

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

/** `a, (b, c), 'd,e'` → its top-level items. */
function splitTopLevel(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      items.push(text.slice(from, i));
      from = i + 1;
    }
  }
  items.push(text.slice(from));
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

/** The text between the parentheses that open at `text[open]`. */
function parenthesized(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

// =============================================================================
// Routine signatures
// =============================================================================

const TYPE_ALIASES: Readonly<Record<string, string>> = {
  int: 'int4', integer: 'int4', int4: 'int4',
  bigint: 'int8', int8: 'int8',
  smallint: 'int2', int2: 'int2',
  real: 'float4', float4: 'float4',
  'double precision': 'float8', float: 'float8', float8: 'float8',
  boolean: 'bool', bool: 'bool',
  'character varying': 'varchar', varchar: 'varchar',
  character: 'bpchar', char: 'bpchar', bpchar: 'bpchar',
  decimal: 'numeric', numeric: 'numeric',
  'timestamp without time zone': 'timestamp', timestamp: 'timestamp',
  'timestamp with time zone': 'timestamptz', timestamptz: 'timestamptz',
  'time without time zone': 'time', time: 'time',
  'time with time zone': 'timetz', timetz: 'timetz',
  'bit varying': 'varbit', varbit: 'varbit',
};
/** Words a type name of several words starts with, so they are no parameter name. */
const TYPE_START_WORDS: ReadonlySet<string> = new Set(['double', 'character', 'char', 'bit', 'national', 'time', 'timestamp', 'interval']);
const ARG_MODES: ReadonlySet<string> = new Set(['in', 'out', 'inout', 'variadic']);

/** One argument's type as Postgres identifies it, or null for an OUT argument, which is no part of the signature. */
function argType(arg: string): string | null {
  // A typmod (`numeric(10, 2)`, `timestamp(3) with time zone`) names no other type.
  const words = arg.replace(/\s+default\s[\s\S]*$/i, '').replace(/\s*=[\s\S]*$/, '')
    .replace(/\s*\([^)]*\)/g, '').trim().split(/\s+/);
  const mode = words[0]!.toLowerCase();
  if (ARG_MODES.has(mode) && words.length > 1) {
    if (mode === 'out') return null;
    words.shift();
  }
  if (words.length > 1 && !TYPE_START_WORDS.has(words[0]!.toLowerCase()) && !/^\[/.test(words[1]!)) words.shift();
  const type = words.join(' ').toLowerCase().replace(/"/g, '')
    .replace(/\s*\[\s*\d*\s*\]/g, '[]')
    .replace(/^pg_catalog\./, '');
  const arrays = /(\[\])*$/.exec(type)![0];
  const base = type.slice(0, type.length - arrays.length).trim();
  return (TYPE_ALIASES[base] ?? base) + arrays;
}

/** `p_id bigint, p_name text DEFAULT ''` → `(int8,text)`. */
function argSignature(list: string): string {
  return `(${splitTopLevel(list).map(argType).filter((t): t is string => t !== null).join(',')})`;
}

const SQL_LANGUAGES: ReadonlySet<string> = new Set(['postgres', 'plpgsql']);
const signatureMemo = new Map<string, string | null>();
const SIGNATURE_MEMO_LIMIT = 50_000;

/** A function's or procedure's argument types, `(int8,text)`: with its name, what Postgres knows it by. */
export function routineSignature(node: Node): string | null {
  if (!SQL_LANGUAGES.has(node.language) || !node.signature) return null;
  const known = signatureMemo.get(node.signature);
  if (known !== undefined) return known;
  const head = /^(?:function|procedure): .*?\b(?:function|procedure)\b/i.exec(node.signature);
  const open = head ? node.signature.indexOf('(', head[0].length) : -1;
  const signature = open < 0 ? null : argSignature(parenthesized(node.signature, open));
  if (signatureMemo.size >= SIGNATURE_MEMO_LIMIT) signatureMemo.clear();
  signatureMemo.set(node.signature, signature);
  return signature;
}

// =============================================================================
// What a migration ends
// =============================================================================

/**
 * A DROP of an object, or an `ALTER TABLE ... DISABLE / ENABLE TRIGGER`.
 * `ENABLE REPLICA` leaves a trigger firing only on a replica, so it reads as a disable.
 */
export interface SqlDdlEvent {
  at: SqlPosition;
  kind: 'drop' | 'disable' | 'enable';
}

/**
 * DDL events keyed `relation:`, `routine:` or `type:` and a qualified name
 * (`routine:public::f(int4)` when read with signatures),
 * `trigger:<table>::<trigger>`, or `triggers:<table>` for `ALL` / `USER`.
 */
export type SqlDdl = Map<string, SqlDdlEvent[]>;

type ObjectClass = 'relation' | 'routine' | 'type';

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

/** How DDL is read; the resolver and the query-time surfaces each have one (`DDL_READINGS`). */
interface DdlReading {
  /**
   * A DROP counts only where a statement starts, at the top level or in a
   * PL/pgSQL block, so `ALTER EXTENSION x DROP FUNCTION f` ends nothing;
   * otherwise any DROP keyword outside a routine body counts.
   */
  statementStart: boolean;
  /** The object types a DROP is read for. */
  objects: string;
  /**
   * A routine's DROP is keyed by its argument types too when it gives them, and
   * the list, CASCADE removed first, splits at top-level commas, quotes kept
   * whole; otherwise every parenthesized list is removed and the rest split at
   * each comma.
   */
  routineSignatures: boolean;
  /** `ALTER TABLE ... DISABLE / ENABLE TRIGGER` is read as well. */
  triggerSwitches: boolean;
}

export const DDL_READINGS = {
  resolver: {
    statementStart: true,
    objects: String.raw`table|view|materialized\s+view|function|procedure|routine|type|domain|trigger`,
    routineSignatures: false,
    triggerSwitches: true,
  },
  surface: {
    statementStart: false,
    objects: String.raw`trigger|table|view|materialized\s+view|function|procedure|routine`,
    routineSignatures: true,
    triggerSwitches: false,
  },
} as const satisfies Record<string, DdlReading>;

/** Where a statement can start: a file's top level, or a PL/pgSQL block. */
const STATEMENT_START = String.raw`(?:^|;|\b(?:begin|then|else|loop)\b)\s*`;
const DROP_WORD = /\bdrop\s/i;
const MAY_END = /\b(?:drop|disable|enable)\s/i;
const DROPPED_TRIGGER = new RegExp(String.raw`^(${IDENT})\s+ON\s+(${QUALIFIED})`, 'i');
const ALTER_TABLE = new RegExp(
  STATEMENT_START + String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUALIFIED})\s*\*?\s+([^;]*)`,
  'gi'
);
const TRIGGER_SWITCH = new RegExp(String.raw`\b(disable|enable)(?:\s+(replica|always))?\s+trigger\s+(${IDENT})`, 'gi');
const dropStatements = new Map<DdlReading, RegExp>();

function dropStatement(reading: DdlReading): RegExp {
  let re = dropStatements.get(reading);
  if (!re) {
    const start = reading.statementStart ? STATEMENT_START : String.raw`\b`;
    re = new RegExp(start + String.raw`drop\s+(${reading.objects})\s+(?:if\s+exists\s+)?([^;]*)`, 'gi');
    dropStatements.set(reading, re);
  }
  return re;
}

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

const withoutCascade = (list: string): string => list.replace(/\b(?:cascade|restrict)\s*$/i, '').trim();

/** `a.f(int, text), "B"` → `a::f(int4,text)` and `public::B`: each name with its argument types when it gives them. */
function droppedSignatures(list: string, routine: boolean): string[] {
  const out: string[] = [];
  for (const item of splitTopLevel(list)) {
    const open = item.indexOf('(');
    const name = foldObjectName(open < 0 ? item : item.slice(0, open));
    if (!name) continue;
    out.push(qualify(name) + (routine && open >= 0 ? argSignature(parenthesized(item, open)) : ''));
  }
  return out;
}

/** Every DROP (and, if the reading takes them, trigger switch) one SQL file runs as it applies, added to `into`. */
export function readSqlDdl(file: string, text: string, reading: DdlReading, into: SqlDdl): void {
  if (!(reading.triggerSwitches ? MAY_END : DROP_WORD).test(text)) return;
  const add = (key: string, event: SqlDdlEvent): void => {
    const events = into.get(key);
    if (events) events.push(event);
    else into.set(key, [event]);
  };
  const code = codeOnly(text, true);
  const lineAt = makeLineAt(code, 1);
  const at = (m: RegExpMatchArray): SqlPosition => ({ file, line: lineAt(m.index! + m[0].search(/drop|alter/i)) });
  for (const m of code.matchAll(dropStatement(reading))) {
    const objectType = m[1]!.toLowerCase().replace(/\s+/, ' ');
    const list = reading.routineSignatures ? withoutCascade(m[2]!) : m[2]!;
    if (objectType === 'trigger') {
      const t = DROPPED_TRIGGER.exec(list);
      const name = t && splitIdentifierPath(t[1]!)[0];
      const table = t && foldObjectName(t[2]!);
      if (name && table) add(`trigger:${qualify(table, name)}`, { at: at(m), kind: 'drop' });
      continue;
    }
    const objectClass = CLASS_OF_DROP[objectType]!;
    const names = reading.routineSignatures ? droppedSignatures(list, objectClass === 'routine') : droppedNames(list);
    for (const name of names) add(`${objectClass}:${name}`, { at: at(m), kind: 'drop' });
  }
  if (!reading.triggerSwitches) return;
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

/**
 * The DDL read for one generation of the resolver's caches: the file-node
 * list is rebuilt whenever they are cleared, as after a sync.
 */
const ddlIndexes = new WeakMap<ResolutionContext, { source: readonly Node[]; events: SqlDdl }>();

/** Every DROP and trigger switch the project's SQL files run, by the resolver's reading. */
export function sqlDdlEvents(context: ResolutionContext): SqlDdl {
  const source = context.getNodesByKind('file');
  let entry = ddlIndexes.get(context);
  if (!entry || entry.source !== source) {
    const events: SqlDdl = new Map();
    for (const file of context.getAllFiles()) {
      if (!SQL_FILE.test(file)) continue;
      const text = context.readFile(file);
      if (text) readSqlDdl(file, text, DDL_READINGS.resolver, events);
    }
    entry = { source, events };
    ddlIndexes.set(context, entry);
  }
  return entry.events;
}

/** The keys a routine's DROP is read under: its name, and with a signature, its name and argument types. */
export function routineDropKeys(qualifiedName: string, signature: string | null): string[] {
  return [`routine:${qualifiedName}`, ...(signature ? [`routine:${qualifiedName}${signature}`] : [])];
}

/** A trigger ends with its own DROP, its table's, or its function's. */
export function triggerDropKeys(triggerName: string, tableName: string, routineKeys: readonly string[]): string[] {
  return [`trigger:${triggerName}`, `relation:${tableName}`, ...routineKeys];
}

/**
 * The events of any of `keys` that run after `from` in `from`'s own series
 * (by `seriesOf`), up to `until` when given, in apply order.
 */
export function ddlAfter(
  ddl: SqlDdl,
  keys: readonly string[],
  from: SqlPosition,
  seriesOf: (file: string) => string,
  until: SqlPosition | null = null,
): SqlDdlEvent[] {
  const series = seriesOf(from.file);
  return keys
    .flatMap((key) => ddl.get(key) ?? [])
    .filter((e) => seriesOf(e.at.file) === series && comparePositions(e.at, from) > 0 && (!until || comparePositions(e.at, until) <= 0))
    .sort((a, b) => comparePositions(a.at, b.at));
}

// =============================================================================
// Database clients in TypeScript / JavaScript
// =============================================================================

/** The clients that name their tables in query-builder calls (`.from('t')`). */
export type QueryBuilderClient = 'supabase' | 'knex' | 'kysely';
/** The clients that run SQL text. */
export type SqlTextClient = 'slonik' | 'drizzle' | 'kysely' | 'postgres' | 'pg' | 'knex';
type SqlClient = QueryBuilderClient | SqlTextClient;

/**
 * An import that makes a database client. `make`: `tag`, the import itself is
 * the client's template tag; `call` / `new`, the import is a factory whose
 * result is the client. `builder`: the client names its tables in
 * query-builder calls (`.from('t')`). `tagged` / `methods`: the client runs
 * SQL text as a template tag, or through these methods, SQL their first argument.
 */
export interface SqlClientImport {
  client: SqlClient;
  packages: Readonly<Record<string, readonly string[]>>;
  make: 'tag' | 'call' | 'new';
  builder: boolean;
  tagged: boolean;
  methods: readonly string[];
}

const SQL_CLIENT_IMPORTS: readonly SqlClientImport[] = [
  {
    client: 'supabase',
    packages: { '@supabase/supabase-js': ['createClient'], '@supabase/ssr': ['createServerClient', 'createBrowserClient'] },
    make: 'call', builder: true, tagged: false, methods: [],
  },
  { client: 'knex', packages: { knex: ['default', 'knex', 'Knex'] }, make: 'call', builder: true, tagged: false, methods: ['raw'] },
  { client: 'kysely', packages: { kysely: ['Kysely'] }, make: 'new', builder: true, tagged: false, methods: [] },
  { client: 'slonik', packages: { slonik: ['sql'] }, make: 'tag', builder: false, tagged: true, methods: [] },
  { client: 'drizzle', packages: { 'drizzle-orm': ['sql'] }, make: 'tag', builder: false, tagged: true, methods: [] },
  { client: 'kysely', packages: { kysely: ['sql'] }, make: 'tag', builder: false, tagged: true, methods: [] },
  { client: 'postgres', packages: { postgres: ['default'] }, make: 'call', builder: false, tagged: true, methods: ['unsafe'] },
  { client: 'pg', packages: { pg: ['Pool', 'Client', 'default'] }, make: 'new', builder: false, tagged: false, methods: ['query'] },
];

/**
 * The clients that name tables in query-builder calls, or that run SQL text,
 * by client: each such client is made by one import row.
 */
export function sqlClients(use: 'builder'): ReadonlyMap<QueryBuilderClient, SqlClientImport>;
export function sqlClients(use: 'text'): ReadonlyMap<SqlTextClient, SqlClientImport>;
export function sqlClients(use: 'builder' | 'text'): ReadonlyMap<SqlClient, SqlClientImport> {
  const rows = SQL_CLIENT_IMPORTS.filter((c) => (use === 'builder' ? c.builder : c.tagged || c.methods.length > 0));
  return new Map(rows.map((c) => [c.client, c]));
}

/** The type of a client instance, by the package that exports it: a parameter annotated with one is a client. */
export const SQL_CLIENT_TYPES: Readonly<Record<string, Readonly<Record<string, QueryBuilderClient>>>> = {
  '@supabase/supabase-js': { SupabaseClient: 'supabase' },
  knex: { Knex: 'knex' },
  kysely: { Kysely: 'kysely' },
};
