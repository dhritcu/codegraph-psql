/**
 * TypeScript / JavaScript database clients → the SQL objects they touch.
 *
 * A query builder names its table or function in a string the graph cannot
 * follow: `supabase.from('orders').update({ status })` writes `public.orders`,
 * `supabase.rpc('create_order')` runs a function a migration defines. This pass
 * reads those strings and links the enclosing function to the SQL node, so a
 * flow runs from an API handler into the database.
 *
 * Four clients, one table of forms (`FORMS`):
 *
 *  - **supabase** — `.from('t')` with the op of the first `.select` / `.insert` /
 *    `.update` / `.upsert` / `.delete` chained on it, and `.rpc('f')`; a
 *    `.schema('x')` before either, or `db: { schema: 'x' }` in the client's
 *    options, picks the schema.
 *  - **knex** — `db('t')`, `db.from('t')`, `db.table('t')`, `db.into('t')`; with
 *    no write chained, a knex builder runs a select.
 *  - **kysely** — `db.selectFrom` / `insertInto` / `updateTable` / `deleteFrom`.
 *  - **drizzle** — `pgTable('t', …)` and `pgSchema('x').table('t', …)`: the
 *    declaring constant references its table, with no op.
 *
 * A receiver counts only with evidence. It is bound in the file from the
 * client's own factory, imported from the client's package (`createClient`
 * from `@supabase/supabase-js`, `createServerClient` / `createBrowserClient`
 * from `@supabase/ssr`, `knex` from `knex`, `new Kysely` from `kysely`), or
 * from a function of the file whose body calls that factory (`const s = await
 * createClient()`). Either may come from one project module away: an import
 * is followed one hop to the module that makes the client, no further. Any
 * other `.from('orders')` makes no edge.
 *
 * Edges: a table access is `references` with `metadata.op` (select / insert /
 * update / delete), an rpc is `calls`. One edge per function and table; when
 * a function performs several ops on one table the edge carries the first
 * write (else select) as `op` and all of them as `ops`. An upsert is
 * `op: 'insert'` with `upsert: true` and `ops: ['insert', 'update']`: it fires
 * the table's INSERT and UPDATE triggers. An update's or upsert's `columns`
 * are the keys of its literal payload object.
 *
 * Synthesized edges persist only after every pass has run, so the trigger
 * pass cannot see these writes. This pass runs it over its own writes, one
 * per op, and keeps the trigger hops of TypeScript writers.
 */

import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext, ImportMapping } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import { resolveImportPath } from './import-resolver';
import { isGeneratedFile } from '../extraction/generated-detection';
import { isTestPath } from '../search/query-utils';
import { enclosingFn, enclosingValue, makeLineAt } from './synth-utils';
import { postgresResolver } from './frameworks/postgres';
import { qualify, DEFAULT_SCHEMA } from '../extraction/languages/postgres-names';
import { pgTriggerEdges } from './pg-trigger-synthesizer';

type Client = 'supabase' | 'knex' | 'kysely' | 'drizzle';
type Op = 'select' | 'insert' | 'update' | 'delete';

const JS_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SQL_FILE = /\.(?:sql|psql|pgsql)$/i;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const escape = (name: string): string => name.replace(/\$/g, '\\$');

/** Where each client's factory is imported from, and how it is called. */
const FACTORIES: Readonly<Record<Exclude<Client, 'drizzle'>, { packages: Record<string, readonly string[]>; isNew: boolean }>> = {
  supabase: {
    packages: {
      '@supabase/supabase-js': ['createClient'],
      '@supabase/ssr': ['createServerClient', 'createBrowserClient'],
    },
    isNew: false,
  },
  knex: { packages: { knex: ['default', 'knex', 'Knex'] }, isNew: false },
  kysely: { packages: { kysely: ['Kysely'] }, isNew: true },
};

const DRIZZLE_PACKAGE = 'drizzle-orm/pg-core';

/** A client package, or a call shape one of the clients makes; a file with neither is not read. */
const USE_GATE = new RegExp([
  String.raw`@supabase\/(?:supabase-js|ssr)|['"](?:knex|kysely|drizzle-orm\/pg-core)['"]`,
  String.raw`\.\s*(?:from|rpc|table|into|selectFrom|insertInto|updateTable|deleteFrom)\s*(?:<[^()]*?>)?\s*\(\s*['"\`]`,
  String.raw`\b${IDENT}\s*\(\s*['"][\w.]+(?:\s+as\s+\w+)?['"]\s*\)\s*\.\s*(?:insert|update|del|delete|select|where|first|pluck|increment|decrement)\b`,
].join('|'));
const SQL_DEFINITION_GATE = /\b(?:create|drop)\s+(?:or\s+replace\s+)?(?:table|view|materialized\s+view|function)\b/i;

/** Whether a file can feed this pass: a client or its call, or a SQL definition a client call can name. */
export function hasSqlClientPattern(filePath: string, content: string): boolean {
  if (SQL_FILE.test(filePath)) return SQL_DEFINITION_GATE.test(content);
  return JS_FILE.test(filePath) && USE_GATE.test(content);
}

// =============================================================================
// Source reading
// =============================================================================

function skipString(s: string, i: number): number {
  const q = s[i];
  if (q === '`') {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === '`') return j;
      else if (s[j] === '$' && s[j + 1] === '{') j = closeBracket(s, j + 1);
    }
    return s.length;
  }
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === q || s[j] === '\n') return j;
  }
  return s.length;
}

/** Index of the bracket closing the one at `open`, skipping strings; s.length if unbalanced. */
function closeBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') i = skipString(s, i);
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (--depth === 0) return i;
    }
  }
  return s.length;
}

/** `text` split at depth-0 commas. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') i = skipString(text, i);
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * `s` with the text of every template literal blanked, offsets and newlines
 * kept: a template holds sample code (a docs page's `supabase.from('todos')`)
 * far more often than a query.
 */
function blankTemplates(s: string): string {
  let out = '';
  let copied = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '"' && ch !== "'" && ch !== '`') continue;
    const end = skipString(s, i);
    if (ch === '`') {
      out += s.slice(copied, i + 1) + s.slice(i + 1, end).replace(/[^\n]/g, ' ');
      copied = end;
    }
    i = end;
  }
  return out + s.slice(copied);
}

/** The value of a string literal with no interpolation that opens `text`, else null. */
function literal(text: string): string | null {
  const m = /^\s*(?:(['"])((?:(?!\1)[^\\\n])*)\1|`([^`\\$]*)`)/.exec(text);
  return m ? (m[2] ?? m[3]!) : null;
}

/** The keys of an object literal (`{ a: 1, 'b': 2, c }`); null when it is no literal or a key is computed or spread. */
function objectKeys(text: string): string[] | null {
  const t = text.trim();
  if (t[0] !== '{' || closeBracket(t, 0) !== t.length - 1) return null;
  const keys: string[] = [];
  for (const part of splitTopLevel(t.slice(1, -1))) {
    const m = /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*(?::|$)/.exec(part);
    if (!m) return null;
    keys.push(m[2] ?? m[3]!);
  }
  return keys;
}

/** The keys of a payload: an object literal, or an array of them. */
function payloadKeys(text: string | undefined): string[] | null {
  if (!text) return null;
  const t = text.trim();
  if (t[0] !== '[') return objectKeys(t);
  if (closeBracket(t, 0) !== t.length - 1) return null;
  const keys = new Set<string>();
  for (const el of splitTopLevel(t.slice(1, -1))) {
    const k = objectKeys(el);
    if (!k) return null;
    for (const key of k) keys.add(key);
  }
  return [...keys];
}

interface Link {
  method: string;
  args: string[];
}

/** The `.method(args)` calls chained after index `from` (just past a call's `)`). */
function chainAfter(s: string, from: number): Link[] {
  const links: Link[] = [];
  const step = new RegExp(String.raw`\s*\??\.\s*(${IDENT})\s*(?:<[^()<>]*>)?\s*\(`, 'y');
  let i = from;
  while (links.length < 16) {
    step.lastIndex = i;
    const m = step.exec(s);
    if (!m) break;
    const open = step.lastIndex - 1;
    const close = closeBracket(s, open);
    if (close >= s.length) break;
    links.push({ method: m[1]!, args: splitTopLevel(s.slice(open + 1, close)) });
    i = close + 1;
  }
  return links;
}

// =============================================================================
// Receiver evidence
// =============================================================================

interface Binding {
  client: Exclude<Client, 'drizzle'>;
  /** The schema the client's options name (`db: { schema: 'x' }`). */
  schema: string | null;
}

interface FileFacts {
  file: string;
  safe: string;
  /** Local names bound to a client instance. */
  instances: Map<string, Binding>;
  /** Local functions whose body makes a client and returns it. */
  factories: Map<string, Binding>;
  /** What `export default` is, when it is one of the above. */
  defaultExport: { name: string } | null;
  imports: ImportMapping[];
}

function importsOf(ctx: ResolutionContext, file: string, safe: string): ImportMapping[] {
  const lang = /\.[cm]?jsx?$/.test(file) ? 'javascript' : file.endsWith('x') ? 'tsx' : 'typescript';
  const mapped = ctx.getImportMappings(file, lang);
  // `const knex = require('knex')` reaches the mappings only in some extractors.
  const required: ImportMapping[] = [];
  for (const m of safe.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)`, 'g'))) {
    required.push({ localName: m[1]!, exportedName: 'default', source: m[3]!, isDefault: true, isNamespace: false });
  }
  for (const m of safe.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)`, 'g'))) {
    for (const part of m[1]!.split(',')) {
      const [exported, local] = part.split(':').map((p) => p.trim());
      if (exported) required.push({ localName: local || exported, exportedName: exported, source: m[3]!, isDefault: false, isNamespace: false });
    }
  }
  return [...mapped, ...required];
}

/** The package a specifier names: `npm:@supabase/supabase-js@2`, `jsr:…` and `https://esm.sh/…@2` as Deno imports them. */
function packageOf(source: string): string {
  const bare = source.replace(/^(?:npm:|jsr:|https:\/\/(?:esm\.sh|cdn\.skypack\.dev|cdn\.jsdelivr\.net\/npm)\/)/, '');
  const m = /^((?:@[^/@]+\/)?[^/@]+)(?:@[^/]*)?(\/.*)?$/.exec(bare);
  return m ? m[1]! + (m[2] ?? '') : source;
}

/** The client a local name is a factory of, by the package it is imported from. */
function factoryClient(imports: readonly ImportMapping[], local: string): Binding['client'] | null {
  for (const im of imports) {
    if (im.localName !== local) continue;
    const pkg = packageOf(im.source);
    for (const [client, f] of Object.entries(FACTORIES) as [Binding['client'], (typeof FACTORIES)[Binding['client']]][]) {
      const names = f.packages[pkg];
      if (names?.includes(im.isDefault ? 'default' : im.exportedName)) return client;
    }
  }
  return null;
}

function optionsSchema(s: string, open: number): string | null {
  const args = s.slice(open, closeBracket(s, open));
  return /\bdb\s*:\s*\{[^}]*\bschema\s*:\s*(['"])([^'"]+)\1/.exec(args)?.[2] ?? null;
}

/** Every call of a client factory in the file: where it is and which client it makes. */
function factoryCalls(safe: string, imports: readonly ImportMapping[]): { index: number; binding: Binding }[] {
  const calls: { index: number; binding: Binding }[] = [];
  const locals = new Set(imports.map((im) => im.localName));
  for (const m of safe.matchAll(new RegExp(String.raw`(?<![\w$.])(new\s+)?(${IDENT})\s*(?:<[^()]*?>)?\s*\(`, 'g'))) {
    if (!locals.has(m[2]!)) continue;
    const client = factoryClient(imports, m[2]!);
    if (!client || FACTORIES[client].isNew !== !!m[1]) continue;
    const open = m.index! + m[0].length - 1;
    calls.push({ index: m.index!, binding: { client, schema: client === 'supabase' ? optionsSchema(safe, open) : null } });
  }
  return calls;
}

function readFacts(ctx: ResolutionContext, file: string): FileFacts | null {
  const content = ctx.readFile(file);
  if (!content) return null;
  const safe = blankTemplates(stripCommentsForRegex(content, 'typescript'));
  const imports = importsOf(ctx, file, safe).filter((im) => safe.includes(`'${im.source}'`) || safe.includes(`"${im.source}"`));
  const instances = new Map<string, Binding>();
  const factories = new Map<string, Binding>();
  const calls = factoryCalls(safe, imports);
  if (calls.length > 0) {
    const lineOf = makeLineAt(safe, 1);
    const lineStarts = [0];
    for (let i = safe.indexOf('\n'); i !== -1; i = safe.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    const nodes = ctx.getNodesInFile(file);
    const bound = new RegExp(String.raw`(?:\b(?:const|let|var)\s+)?(?<![\w$.])(${IDENT})\s*(?::[^=;]*?)?=\s*(?:await\s+)?$`);
    const returned = /(?:\breturn|=>)\s*(?:await\s+)?$/;
    for (const call of calls) {
      const before = safe.slice(Math.max(0, call.index - 200), call.index);
      const name = bound.exec(before)?.[1];
      if (name) instances.set(name, call.binding);
      const fn = enclosingFn(nodes, lineOf(call.index));
      if (!fn) continue;
      const body = safe.slice(lineStarts[fn.startLine - 1] ?? 0, lineStarts[fn.endLine] ?? safe.length);
      if (returned.test(before) || (name && new RegExp(String.raw`\breturn\s+${escape(name)}\b`).test(body))) {
        factories.set(fn.name, call.binding);
      }
    }
  }
  const def = new RegExp(String.raw`\bexport\s+default\s+(${IDENT})\s*;?\s*$`, 'm').exec(safe);
  return { file, safe, instances, factories, defaultExport: def ? { name: def[1]! } : null, imports };
}

type FactsCache = Map<string, FileFacts | null>;

function factsOf(ctx: ResolutionContext, file: string, cache: FactsCache): FileFacts | null {
  let facts = cache.get(file);
  if (facts === undefined) {
    facts = readFacts(ctx, file);
    cache.set(file, facts);
  }
  return facts;
}

/**
 * The receivers a file can query through, as regex sources: the client
 * instances and factory calls (`supabaseAdmin()`) of its own, and of the
 * module it imports them from.
 */
function receivers(ctx: ResolutionContext, facts: FileFacts, cache: FactsCache): Map<string, Binding> {
  const instances = new Map(facts.instances);
  const factories = new Map(facts.factories);
  const lang = facts.file.endsWith('x') ? 'tsx' : 'typescript';
  for (const im of facts.imports) {
    if (im.isNamespace || instances.has(im.localName) || factories.has(im.localName)) continue;
    if (!im.source.startsWith('.') && !im.resolvedPath && !/^[@~#]\//.test(im.source)) continue;
    const resolved = im.resolvedPath ?? resolveImportPath(im.source, facts.file, lang, ctx);
    if (!resolved || !JS_FILE.test(resolved)) continue;
    const there = factsOf(ctx, resolved, cache);
    if (!there) continue;
    const exported = im.isDefault ? there.defaultExport?.name : im.exportedName;
    if (!exported) continue;
    const instance = there.instances.get(exported);
    const factory = there.factories.get(exported);
    if (instance) instances.set(im.localName, instance);
    else if (factory) factories.set(im.localName, factory);
  }
  // `const supabase = await createClient()` — an instance made by a factory.
  if (factories.size > 0) {
    const call = new RegExp(String.raw`\b(?:const|let|var)\s+(${IDENT})\s*(?::[^=;]*?)?=\s*(?:await\s+)?(${IDENT})\s*\(`, 'g');
    for (const m of facts.safe.matchAll(call)) {
      const binding = factories.get(m[2]!);
      if (binding && !instances.has(m[1]!)) instances.set(m[1]!, binding);
    }
  }
  return new Map([
    ...[...instances].map(([name, b]) => [escape(name), b] as const),
    ...[...factories].map(([name, b]) => [String.raw`${escape(name)}\s*\(\s*\)`, b] as const),
  ]);
}

// =============================================================================
// Call sites
// =============================================================================

interface SqlTarget {
  kind: 'table' | 'function';
  schema: string;
  name: string;
}

interface Site {
  client: Client;
  /** Index of the call in the file's text. */
  index: number;
  /** How the call reads: "`.from('orders').update`". */
  call: string;
  target: SqlTarget;
  ops: Op[];
  columns: string[] | null;
  upsert: boolean;
  /** Drizzle's declaration is a value, not a call inside a function. */
  declaration: boolean;
}

/** `app.orders as o` → app / orders. */
function tableName(text: string, schema: string | null): { schema: string; name: string } | null {
  const bare = text.trim().replace(/\s+as\s+\S+$/i, '');
  const parts = bare.split('.');
  if (parts.length > 2 || parts.some((p) => !/^[A-Za-z_][\w$]*$/.test(p))) return null;
  return parts.length === 2 ? { schema: parts[0]!, name: parts[1]! } : { schema: schema ?? DEFAULT_SCHEMA, name: parts[0]! };
}

const SUPABASE_OPS: Readonly<Record<string, Op>> = { select: 'select', insert: 'insert', update: 'update', upsert: 'insert', delete: 'delete' };

function supabaseSites(safe: string, receiver: string, binding: Binding, out: Site[]): void {
  const re = new RegExp(
    String.raw`(?<![\w$.])${receiver}\s*(?:\??\.\s*schema\s*\(\s*(['"\`])([A-Za-z_][\w$]*)\1\s*\)\s*)?\??\.\s*(from|rpc)\s*(?:<[^()]*?>)?\s*\(`,
    'g'
  );
  for (const m of safe.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const close = closeBracket(safe, open);
    const value = literal(safe.slice(open + 1, close));
    if (!value) continue;
    const schema = m[2] ?? binding.schema ?? DEFAULT_SCHEMA;
    const index = m.index! + m[0].lastIndexOf(m[3]!);
    const via = m[2] ? `.schema('${m[2]}')` : '';
    if (m[3] === 'rpc') {
      if (!/^[A-Za-z_][\w$]*$/.test(value)) continue;
      out.push({ client: 'supabase', index, call: `${via}.rpc('${value}')`, target: { kind: 'function', schema, name: value },
        ops: [], columns: null, upsert: false, declaration: false });
      continue;
    }
    const table = tableName(value, schema);
    // PostgREST takes a bare table name; the schema comes from `.schema()` or the client.
    if (!table || /[\s.]/.test(value)) continue;
    const link = chainAfter(safe, close + 1).find((l) => SUPABASE_OPS[l.method]);
    if (!link) continue;
    const upsert = link.method === 'upsert';
    const columns = link.method === 'update' || upsert ? payloadKeys(link.args[0]) : null;
    out.push({ client: 'supabase', index, call: `${via}.from('${value}').${link.method}`, target: { kind: 'table', ...table },
      ops: upsert ? ['insert', 'update'] : [SUPABASE_OPS[link.method]!], columns, upsert, declaration: false });
  }
}

const KNEX_OPS: Readonly<Record<string, Op>> = {
  insert: 'insert', update: 'update', del: 'delete', delete: 'delete', increment: 'update', decrement: 'update',
};

function knexSites(safe: string, receiver: string, out: Site[]): void {
  const re = new RegExp(String.raw`(?<![\w$.])${receiver}\s*(?:\.\s*(from|table|into)\s*)?(?:<[^()]*?>)?\s*\(`, 'g');
  for (const m of safe.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const close = closeBracket(safe, open);
    const value = literal(safe.slice(open + 1, close));
    const table = value ? tableName(value, null) : null;
    if (!value || !table) continue;
    const chain = chainAfter(safe, close + 1);
    const write = chain.find((l) => KNEX_OPS[l.method]);
    const merge = chain.some((l) => l.method === 'merge') && chain.some((l) => l.method === 'onConflict');
    const ops: Op[] = write ? [KNEX_OPS[write.method]!] : ['select'];
    if (merge && ops[0] === 'insert') ops.push('update');
    const columns = write?.method === 'update' ? payloadKeys(write.args[0]) : merge ? payloadKeys(write?.args[0]) : null;
    out.push({ client: 'knex', index: m[1] ? m.index! + m[0].lastIndexOf(m[1]) : m.index!, call: `${m[1] ? `.${m[1]}` : ''}('${value}')${write ? `.${write.method}` : ''}`,
      target: { kind: 'table', ...table }, ops, columns, upsert: merge, declaration: false });
  }
}

const KYSELY_OPS: Readonly<Record<string, Op>> = { selectFrom: 'select', insertInto: 'insert', updateTable: 'update', deleteFrom: 'delete' };

function kyselySites(safe: string, receiver: string, out: Site[]): void {
  const re = new RegExp(String.raw`(?<![\w$.])${receiver}\s*\.\s*(selectFrom|insertInto|updateTable|deleteFrom)\s*\(`, 'g');
  for (const m of safe.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const close = closeBracket(safe, open);
    const value = literal(safe.slice(open + 1, close));
    const table = value ? tableName(value, null) : null;
    if (!value || !table) continue;
    const method = m[1]!;
    const chain = chainAfter(safe, close + 1);
    const ops: Op[] = [KYSELY_OPS[method]!];
    let columns: string[] | null = null;
    let upsert = false;
    if (method === 'updateTable') {
      columns = payloadKeys(chain.find((l) => l.method === 'set')?.args[0]);
    } else if (method === 'insertInto') {
      // `.onConflict((oc) => oc.column('id').doUpdateSet({ ... }))`
      const conflict = chain.find((l) => l.method === 'onConflict')?.args.join(',') ?? '';
      const update = /\.\s*doUpdateSet\s*\(/.exec(conflict);
      if (update) {
        upsert = true;
        ops.push('update');
        const open2 = update.index + update[0].length - 1;
        columns = payloadKeys(conflict.slice(open2 + 1, closeBracket(conflict, open2)));
      }
    }
    out.push({ client: 'kysely', index: m.index! + m[0].lastIndexOf(method), call: `.${method}('${value}')`, target: { kind: 'table', ...table },
      ops, columns, upsert, declaration: false });
  }
}

function drizzleSites(facts: FileFacts, out: Site[]): void {
  const fromDrizzle = (exported: string): string[] =>
    facts.imports.filter((im) => packageOf(im.source) === DRIZZLE_PACKAGE && im.exportedName === exported).map((im) => im.localName);
  const schemas = new Map<string, string>();
  for (const local of fromDrizzle('pgSchema')) {
    const re = new RegExp(String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*${escape(local)}\s*\(\s*(['"])([^'"]+)\2\s*\)`, 'g');
    for (const m of facts.safe.matchAll(re)) schemas.set(m[1]!, m[3]!);
  }
  const callees = [
    ...fromDrizzle('pgTable').map((local) => ({ callee: escape(local), schema: DEFAULT_SCHEMA })),
    ...[...schemas].map(([local, schema]) => ({ callee: String.raw`${escape(local)}\s*\.\s*table`, schema })),
  ];
  for (const { callee, schema } of callees) {
    const re = new RegExp(String.raw`(?<![\w$.])${callee}\s*\(\s*(['"])([^'"]+)\1`, 'g');
    for (const m of facts.safe.matchAll(re)) {
      if (!/^[A-Za-z_][\w$]*$/.test(m[2]!)) continue;
      out.push({ client: 'drizzle', index: m.index!, call: `pgTable('${m[2]}')`, target: { kind: 'table', schema, name: m[2]! },
        ops: [], columns: null, upsert: false, declaration: true });
    }
  }
}

function sitesIn(ctx: ResolutionContext, facts: FileFacts, cache: FactsCache): Site[] {
  const sites: Site[] = [];
  for (const [receiver, binding] of receivers(ctx, facts, cache)) {
    if (binding.client === 'supabase') supabaseSites(facts.safe, receiver, binding, sites);
    else if (binding.client === 'knex') knexSites(facts.safe, receiver, sites);
    else kyselySites(facts.safe, receiver, sites);
  }
  if (facts.safe.includes(DRIZZLE_PACKAGE)) drizzleSites(facts, sites);
  return sites;
}

// =============================================================================
// Targets
// =============================================================================

const SQL_LANGUAGES: ReadonlySet<string> = new Set(['postgres', 'plpgsql']);
const TARGET_KIND: Readonly<Record<SqlTarget['kind'], string>> = { table: 'class', function: 'function' };

/** A migration series, by the rule the Postgres resolver applies; for a file that is no migration, the file. */
function seriesOf(filePath: string): string {
  const parts = filePath.split('/');
  const numbered = parts.findIndex((p) => /^\d+(?:[_\-.]|$)/.test(p));
  if (numbered >= 0) return parts.slice(0, numbered).join('/');
  const dir = parts.slice(0, -1);
  return dir.some((p) => /^migrations?$/i.test(p)) ? dir.join('/') : filePath;
}

/**
 * The directory of the project a migration series belongs to: the series path
 * up to its `supabase/`, `migrations/`, `db/` … directory (`examples/todo` for
 * `examples/todo/supabase/migrations`); a schema file's own directory.
 */
function projectRoot(series: string, isFile: boolean): string {
  const parts = series.split('/');
  if (isFile) parts.pop();
  const at = parts.findIndex((p) => /^(?:supabase|migrations?|db|database|sql|schema|prisma)$/i.test(p));
  return (at >= 0 ? parts.slice(0, at) : parts).join('/');
}

/**
 * The SQL object a client call names, as the database has it once every
 * migration ran. A repo may hold several schemas (an app per directory): a
 * definition counts only when its project directory contains the calling
 * file, the deepest such project wins, and two series or files of equal depth
 * make the name ambiguous and yield nothing. Within one series the
 * Postgres resolver picks the live definition, asked from a position after
 * the series' last migration.
 */
function resolveTarget(ctx: ResolutionContext, target: SqlTarget, fromFile: string): Node | null {
  const qualifiedName = qualify({ schema: target.schema, name: target.name });
  const defs = ctx.getNodesByQualifiedName(qualifiedName).filter((n) => SQL_LANGUAGES.has(n.language) && n.kind === TARGET_KIND[target.kind]);
  if (defs.length === 0) return null;
  let best = -1;
  let groups = new Set<string>();
  for (const d of defs) {
    const series = seriesOf(d.filePath);
    const root = projectRoot(series, series === d.filePath);
    if (root !== '' && !fromFile.startsWith(`${root}/`)) continue;
    const depth = root === '' ? 0 : root.split('/').length;
    if (depth > best) {
      best = depth;
      groups = new Set([series]);
    } else if (depth === best) groups.add(series);
  }
  // A migration series is the database; a schema file beside it is a snapshot of it.
  const migrations = [...groups].filter((g) => !defs.some((d) => d.filePath === g));
  if (groups.size > 1 && migrations.length === 1) groups = new Set(migrations);
  if (groups.size !== 1) return null;
  const [series] = groups as Set<string>;
  const isFile = defs.some((d) => d.filePath === series);
  const resolved = postgresResolver.resolve(
    {
      fromNodeId: '',
      referenceName: qualifiedName,
      referenceKind: target.kind === 'function' ? 'calls' : 'references',
      line: Number.MAX_SAFE_INTEGER,
      column: 0,
      filePath: isFile ? series! : `${series}/${'9'.repeat(20)}_end.sql`,
      language: 'postgres',
    },
    ctx
  );
  return resolved ? (ctx.getNodeById?.(resolved.targetNodeId) ?? defs.find((d) => d.id === resolved.targetNodeId) ?? null) : null;
}

// =============================================================================
// The pass
// =============================================================================

function hopEdge(from: Node, site: Site, target: Node, line: number, column: number): Edge {
  const write = site.ops.find((op) => op !== 'select');
  return {
    source: from.id,
    target: target.id,
    kind: site.target.kind === 'function' ? 'calls' : 'references',
    line,
    column,
    provenance: 'heuristic',
    metadata: {
      synthesizedBy: 'sql-client',
      channel: 'db',
      client: site.client,
      call: site.call,
      ...(site.ops.length > 0 ? { op: write ?? site.ops[0], ops: [...site.ops] } : {}),
      ...(site.upsert ? { upsert: true } : {}),
      ...(site.columns ? { columns: [...site.columns] } : {}),
      registeredAt: `${target.filePath}:${target.startLine}`,
    },
  };
}

/**
 * Fold a later site's ops and columns into the edge an earlier site on the
 * same pair made. The edge sits at its first write, where a trigger hop starts.
 */
function mergeSite(edge: Edge, site: Site, line: number, column: number): void {
  const m = edge.metadata as Record<string, unknown>;
  const ops = new Set([...((m.ops as Op[] | undefined) ?? []), ...site.ops]);
  if (ops.size === 0) return;
  m.ops = [...ops];
  const write = site.ops.find((op) => op !== 'select');
  if (write && (!m.op || m.op === 'select')) {
    m.op = write;
    m.call = site.call;
    edge.line = line;
    edge.column = column;
  }
  if (site.upsert) m.upsert = true;
  if (site.columns) m.columns = [...new Set([...((m.columns as string[] | undefined) ?? []), ...site.columns])];
}

/** The trigger hops the writes in `edges` fire, from the trigger pass run over them, one write per op. */
async function triggerHops(queries: QueryBuilder, ctx: ResolutionContext, edges: Edge[], onYield: MaybeYield): Promise<Edge[]> {
  const writes = new Map<string, Edge[]>();
  const writers = new Set<string>();
  for (const e of edges) {
    const m = e.metadata as Record<string, unknown>;
    if (e.kind !== 'references' || !Array.isArray(m.ops)) continue;
    for (const op of m.ops as Op[]) {
      if (op === 'select') continue;
      const list = writes.get(e.target) ?? [];
      list.push({ ...e, metadata: { ...m, op } });
      writes.set(e.target, list);
      writers.add(e.source);
    }
  }
  if (writes.size === 0) return [];
  const view = Object.create(queries) as QueryBuilder;
  view.getIncomingEdges = (id, kinds, limit) => {
    const stored = queries.getIncomingEdges(id, kinds, limit);
    return !kinds || kinds.includes('references') ? [...stored, ...(writes.get(id) ?? [])] : stored;
  };
  return (await pgTriggerEdges(view, ctx, onYield)).filter((e) => writers.has(e.source));
}

export async function sqlClientEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const cache: FactsCache = new Map();
  const edges: Edge[] = [];
  const byPair = new Map<string, Edge>();
  const targets = new Map<string, Node | null>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!JS_FILE.test(file) || isTestPath(file) || isGeneratedFile(file)) continue;
    if ((++scanned & 63) === 0) await onYield();
    const content = ctx.readFile(file);
    if (!content || !USE_GATE.test(content)) continue;
    const facts = factsOf(ctx, file, cache);
    if (!facts) continue;
    const sites = sitesIn(ctx, facts, cache);
    if (sites.length === 0) continue;
    const nodes = ctx.getNodesInFile(file);
    const lineOf = makeLineAt(facts.safe, 1);
    for (const site of sites.sort((a, b) => a.index - b.index)) {
      const line = lineOf(site.index);
      const from = site.declaration ? enclosingValue(nodes, line) : enclosingFn(nodes, line);
      if (!from) continue;
      const key = `${site.target.kind}:${site.target.schema}.${site.target.name}@${file}`;
      let target = targets.get(key);
      if (target === undefined) {
        target = resolveTarget(ctx, site.target, file);
        targets.set(key, target);
      }
      if (!target) continue;
      const pair = `${from.id}>${target.id}`;
      const seen = byPair.get(pair);
      const column = site.index - (facts.safe.lastIndexOf('\n', site.index - 1) + 1);
      if (seen) {
        mergeSite(seen, site, line, column);
        continue;
      }
      const edge = hopEdge(from, site, target, line, column);
      byPair.set(pair, edge);
      edges.push(edge);
    }
  }
  await onYield();
  return [...edges, ...(await triggerHops(queries, ctx, edges, onYield))];
}
