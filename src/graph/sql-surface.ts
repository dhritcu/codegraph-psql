/**
 * How SQL objects read on the surfaces that list a symbol's neighbours: the
 * `codegraph_node` trail and members, `codegraph callers` / codegraph_callers,
 * and impact.
 *
 * Three facts about a migration-defined schema make the generic listing
 * misleading there. A function's edge to a table carries the operation it
 * performs (`metadata.op`), which is the one thing a reader wants from that
 * line. A column or trigger declared in a later migration than its table is a
 * top-level `schema::table::name` node that references the table, so it lists
 * as a caller of the table rather than as its member. And `CREATE OR REPLACE`
 * across migrations leaves one node per definition, of which only the latest
 * in apply order is live; the older copies are history, not callers. A
 * function is known by its argument types as well as its name, so an overload
 * a later migration adds lives beside the first, until a DROP of its signature.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type CodeGraph from '../index';
import type { Edge, Node } from '../types';
import { foldObjectName, qualify, splitIdentifierPath } from '../extraction/languages/postgres-names';
import { codeOnly, IDENT } from '../resolution/frameworks/postgres';

const SQL_LANGUAGES: ReadonlySet<string> = new Set(['postgres', 'plpgsql']);
const SQL_OPS: ReadonlySet<string> = new Set(['select', 'insert', 'update', 'delete', 'merge']);
const OP_PREFIX = /^(?:select|insert|update|delete|merge):(?!:)/;

export function isSqlNode(node: Node): boolean {
  return SQL_LANGUAGES.has(node.language);
}

/** The operation an edge into a table performs (`insert`), or null for any other edge. */
export function sqlEdgeOp(edge: Edge | null | undefined): string | null {
  const op = (edge?.metadata as { op?: unknown } | undefined)?.op;
  return edge?.kind === 'references' && typeof op === 'string' && SQL_OPS.has(op) ? op : null;
}

/**
 * Every operation an edge into a table performs. A client edge folds all of a
 * function's accesses to one table into `metadata.ops`; `op` is only the one
 * its trigger hop starts from.
 */
export function sqlEdgeOpList(edge: Edge | null | undefined): string[] {
  const op = sqlEdgeOp(edge);
  if (!op) return [];
  const ops = (edge!.metadata as { ops?: unknown }).ops;
  const listed = Array.isArray(ops) ? ops.filter((o): o is string => typeof o === 'string' && SQL_OPS.has(o)) : [];
  return listed.length > 0 ? [...new Set(listed)] : [op];
}

/** The distinct operations a set of edges performs, in first-seen order. */
export function sqlEdgeOps(edges: readonly Edge[]): string[] {
  return [...new Set(edges.flatMap(sqlEdgeOpList))];
}

/** For each node among `edges` that accesses a table, the ` [insert, select]` tag its line carries. */
export function sqlOpTags(edges: Iterable<Edge>): Map<string, string> {
  const ops = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const op of sqlEdgeOpList(edge)) ops.set(edge.source, (ops.get(edge.source) ?? new Set()).add(op));
  }
  return new Map([...ops].map(([id, set]) => [id, ` [${[...set].join(', ')}]`]));
}

/** `insert:public::orders` → `public::orders`, the name a reader knows a SQL table by. */
export function referenceDisplayName(name: string, language: string | undefined): string {
  return language && SQL_LANGUAGES.has(language) ? name.replace(OP_PREFIX, '') : name;
}

/** A SQL object declared under `container` in a file other than the one that creates it. */
export function isCrossFileSqlMember(member: Node, container: Node): boolean {
  return (
    isSqlNode(member) &&
    isSqlNode(container) &&
    member.filePath !== container.filePath &&
    !!container.qualifiedName &&
    member.qualifiedName.startsWith(`${container.qualifiedName}::`)
  );
}

/**
 * The columns, constraints and triggers later migrations declare on a table,
 * in apply order. Each references the table it nests under.
 */
export function crossFileSqlMembers(cg: CodeGraph, container: Node, incoming?: readonly Edge[]): Node[] {
  if (!isSqlNode(container)) return [];
  const ids = (incoming ?? cg.getIncomingEdges(container.id)).filter((e) => e.kind === 'references').map((e) => e.source);
  return [...cg.getNodesByIds([...new Set(ids)]).values()]
    .filter((member) => isCrossFileSqlMember(member, container))
    .sort(applyOrder);
}

const naturalOrder = new Intl.Collator('en', { numeric: true }).compare;

/** Migrations apply in path order, statements in line order: the later definition is the live one. */
function applyOrder(a: Node, b: Node): number {
  return a.filePath === b.filePath ? a.startLine - b.startLine : naturalOrder(a.filePath, b.filePath);
}

/** The migration series a file applies in: its path up to the first numbered segment. */
function migrationSeries(filePath: string): string {
  const parts = filePath.split('/');
  const numbered = parts.findIndex((p) => /^\d+(?:[_\-.]|$)/.test(p));
  return (numbered >= 0 ? parts.slice(0, numbered) : parts.slice(0, -1)).join('/');
}

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

/** The text between the parentheses that open at `text[open]`. */
function parenthesized(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

const signatureMemo = new Map<string, string | null>();
const SIGNATURE_MEMO_LIMIT = 50_000;

/** A function's or procedure's argument types, `(int8,text)`: with its name, what Postgres knows it by. */
export function routineSignature(node: Node): string | null {
  if (!isSqlNode(node) || !node.signature) return null;
  const known = signatureMemo.get(node.signature);
  if (known !== undefined) return known;
  const head = /^(?:function|procedure): .*?\b(?:function|procedure)\b/i.exec(node.signature);
  const open = head ? node.signature.indexOf('(', head[0].length) : -1;
  const signature = open < 0 ? null : argSignature(parenthesized(node.signature, open));
  if (signatureMemo.size >= SIGNATURE_MEMO_LIMIT) signatureMemo.clear();
  signatureMemo.set(node.signature, signature);
  return signature;
}

/** What a DROP ends: `routine:public::f(int4)` (or `routine:public::f`, any signature), `trigger:public::t::name`, `relation:public::t`. */
export interface SqlDrop {
  what: string;
  file: string;
  line: number;
}

const SQL_FILE = /\.(?:sql|psql|pgsql)$/i;
const DROP_STATEMENT =
  /\bdrop\s+(trigger|table|view|materialized\s+view|function|procedure|routine)\s+(?:if\s+exists\s+)?([^;]*)/gi;
const DROPPED_TRIGGER = new RegExp(String.raw`^(${IDENT})\s+ON\s+(${IDENT}(?:\s*\.\s*${IDENT}){0,2})`, 'i');

function dropsIn(file: string, text: string): SqlDrop[] {
  if (!/\bdrop\s/i.test(text)) return [];
  const code = codeOnly(text, true);
  const out: SqlDrop[] = [];
  let line = 1;
  let counted = 0;
  for (const m of code.matchAll(DROP_STATEMENT)) {
    for (; counted < m.index!; counted++) if (code[counted] === '\n') line++;
    const add = (what: string) => out.push({ what, file, line });
    const objectType = m[1]!.toLowerCase();
    const list = m[2]!.replace(/\b(?:cascade|restrict)\s*$/i, '').trim();
    if (objectType === 'trigger') {
      const t = DROPPED_TRIGGER.exec(list);
      const name = t && splitIdentifierPath(t[1]!)[0];
      const table = t && foldObjectName(t[2]!);
      if (name && table) add(`trigger:${qualify(table, name)}`);
      continue;
    }
    const routine = objectType === 'function' || objectType === 'procedure' || objectType === 'routine';
    for (const item of splitTopLevel(list)) {
      const open = item.indexOf('(');
      const name = foldObjectName(open < 0 ? item : item.slice(0, open));
      if (!name) continue;
      if (!routine) add(`relation:${qualify(name)}`);
      else add(`routine:${qualify(name)}${open < 0 ? '' : argSignature(parenthesized(item, open))}`);
    }
  }
  return out;
}

interface SqlFileFacts {
  drops: Map<string, SqlDrop[]>;
  /** Each migration series' last file in apply order. */
  lastFile: Map<string, string>;
}

const factsCache = new WeakMap<CodeGraph, { stamp: string; facts: SqlFileFacts }>();

/**
 * Every DROP the indexed SQL files run, by what it ends, and the last file of
 * each migration series; read once per index revision. The revision is one
 * aggregate query, where listing the files to stamp them cost more than the
 * rest of an explore call.
 */
function sqlFileFacts(cg: CodeGraph): SqlFileFacts {
  const { lastIndexedAt, fileCount } = cg.getIndexRevision();
  const stamp = `${lastIndexedAt}:${fileCount}`;
  const cached = factsCache.get(cg);
  if (cached?.stamp === stamp) return cached.facts;
  const drops = new Map<string, SqlDrop[]>();
  const lastFile = new Map<string, string>();
  const root = cg.getProjectRoot();
  for (const f of cg.getFiles().filter((file) => SQL_FILE.test(file.path))) {
    const series = migrationSeries(f.path);
    const last = lastFile.get(series);
    if (last === undefined || naturalOrder(f.path, last) > 0) lastFile.set(series, f.path);
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, f.path), 'utf-8');
    } catch {
      continue;
    }
    for (const drop of dropsIn(f.path, text)) drops.set(drop.what, [...(drops.get(drop.what) ?? []), drop]);
  }
  const facts = { drops, lastFile };
  factsCache.set(cg, { stamp, facts });
  return facts;
}

const sqlDrops = (cg: CodeGraph) => sqlFileFacts(cg).drops;

/** The first DROP of any of `whats` that runs after `node` in its migration series. */
function droppedAfter(drops: Map<string, SqlDrop[]>, node: Node, whats: readonly string[]): SqlDrop | null {
  const series = migrationSeries(node.filePath);
  const later = whats
    .flatMap((what) => drops.get(what) ?? [])
    .filter((d) => migrationSeries(d.file) === series &&
      (d.file === node.filePath ? d.line > node.startLine : naturalOrder(d.file, node.filePath) > 0))
    .sort((a, b) => (a.file === b.file ? a.line - b.line : naturalOrder(a.file, b.file)));
  return later[0] ?? null;
}

/**
 * Each SQL object once, at its live (latest) definition, with the definitions
 * it superseded. Copies of one object in one migration series are its
 * history; a function's copies are those of its argument types. An overload
 * a later migration dropped is history too, of the overload still live, as
 * long as one is. Non-SQL nodes pass through untouched, in their own order;
 * the live definition takes the place of the first of its copies.
 */
export function liveSqlDefinitions(
  cg: CodeGraph,
  nodes: readonly Node[],
  drops?: Map<string, SqlDrop[]>,
): { nodes: Node[]; superseded: Map<string, Node[]> } {
  const keys = new Map<Node, string>();
  const keyOf = (node: Node) => keys.get(node)!;
  const copies = new Map<string, Node[]>();
  for (const node of nodes) {
    if (!isSqlNode(node)) continue;
    const key = `${node.kind}|${node.qualifiedName}${routineSignature(node) ?? ''}|${migrationSeries(node.filePath)}`;
    keys.set(node, key);
    copies.set(key, [...(copies.get(key) ?? []), node]);
  }
  const lives = new Map<string, { live: Node; earlier: Node[] }>();
  for (const [key, all] of copies) {
    const ordered = [...all].sort(applyOrder);
    lives.set(key, { live: ordered[ordered.length - 1]!, earlier: ordered.slice(0, -1).reverse() });
  }

  // Overloads of one routine: those a later DROP of their signature ended join
  // the history of the latest one still live.
  const overloads = new Map<string, string[]>();
  for (const [key, { live }] of lives) {
    if (routineSignature(live) === null) continue;
    const family = `${live.qualifiedName}|${migrationSeries(live.filePath)}`;
    overloads.set(family, [...(overloads.get(family) ?? []), key]);
  }
  const dropped = new Map<string, string>();
  for (const keys of overloads.values()) {
    if (keys.length < 2) continue;
    drops ??= sqlDrops(cg);
    const ended = keys.filter((key) => droppedAfter(drops!, lives.get(key)!.live, routineDropKeys(lives.get(key)!.live)) !== null);
    const standing = keys.filter((key) => !ended.includes(key));
    if (ended.length === 0 || standing.length === 0) continue;
    const heir = standing.reduce((a, b) => (applyOrder(lives.get(a)!.live, lives.get(b)!.live) >= 0 ? a : b));
    for (const key of ended) dropped.set(key, heir);
  }

  const superseded = new Map<string, Node[]>();
  for (const [key, { live, earlier }] of lives) {
    if (dropped.has(key)) continue;
    const history = [...earlier];
    for (const [gone, heir] of dropped) {
      if (heir === key) history.push(lives.get(gone)!.live, ...lives.get(gone)!.earlier);
    }
    if (history.length > 0) superseded.set(live.id, history.sort(applyOrder).reverse());
  }
  const out: Node[] = [];
  const placed = new Set<string>();
  for (const node of nodes) {
    if (!isSqlNode(node)) {
      out.push(node);
      continue;
    }
    const key = keyOf(node);
    if (placed.has(key) || dropped.has(key)) continue;
    placed.add(key);
    out.push(lives.get(key)!.live);
  }
  return { nodes: out, superseded };
}

/**
 * A symbol's callers as a reader of SQL wants them: a column or trigger a later
 * migration declares on the table is its member, not its caller, and of a view
 * or function redefined across migrations only the live definition still reads
 * the table. Rows of any other language pass through unchanged.
 */
export function sqlCallerRows<T extends { node: Node }>(cg: CodeGraph, target: Node, rows: readonly T[]): T[] {
  if (!rows.some((row) => isSqlNode(row.node))) return [...rows];
  const members = rows.filter((row) => !isCrossFileSqlMember(row.node, target));
  const live = new Set(liveSqlDefinitions(cg, members.map((row) => row.node)).nodes.map((node) => node.id));
  return members.filter((row) => live.has(row.node.id));
}

/** A trigger as it stands once every migration has applied. */
export interface SqlTrigger {
  node: Node;
  /** `AFTER INSERT`, `BEFORE UPDATE OF status`, with `FOR EACH STATEMENT` when it is one. */
  when: string;
  fn: Node | null;
}

const TRIGGER_TIMING =
  /\btrigger\s+\S+\s+(before|after|instead\s+of)\s+([\s\S]+?)\s+on\s+[\s\S]*?(?:\bfor\s+(?:each\s+)?(row|statement)\b|$)/i;

function triggerWhen(trigger: Node): string {
  const m = TRIGGER_TIMING.exec(trigger.signature ?? '');
  if (!m) return '';
  const events = m[2]!.replace(/\s+/g, ' ').replace(/\b(?:insert|update|delete|truncate|or|of)\b/gi, (w) => w.toUpperCase());
  return `${m[1]!.toUpperCase().replace(/\s+/g, ' ')} ${events}${m[3]?.toLowerCase() === 'statement' ? ' FOR EACH STATEMENT' : ''}`;
}

const isTrigger = (node: Node) => (node.signature ?? '').startsWith('trigger:');

function triggerFunction(cg: CodeGraph, trigger: Node): Node | null {
  const call = cg.getOutgoingEdges(trigger.id).find((e) => e.kind === 'calls');
  return call ? cg.getNode(call.target) : null;
}

function routineDropKeys(fn: Node): string[] {
  const sig = routineSignature(fn);
  return [`routine:${fn.qualifiedName}`, ...(sig ? [`routine:${fn.qualifiedName}${sig}`] : [])];
}

/** A trigger ends with its own DROP, its table's, or its function's. */
function triggerDropKeys(trigger: Node, tableName: string, fn: Node | null): string[] {
  return [`trigger:${trigger.qualifiedName}`, `relation:${tableName}`, ...(fn ? routineDropKeys(fn) : [])];
}

/**
 * The DROP that ends a SQL routine, trigger, table or view after this
 * definition of it, or null while it stands. Meant for a live definition (one
 * `liveSqlDefinitions` keeps): an earlier copy may be dropped and created anew.
 */
export function sqlDroppedAt(cg: CodeGraph, node: Node): SqlDrop | null {
  return isSqlNode(node) ? droppedWith(cg, sqlDrops(cg), node) : null;
}

function droppedWith(cg: CodeGraph, drops: Map<string, SqlDrop[]>, node: Node): SqlDrop | null {
  let whats: string[];
  if (isTrigger(node)) whats = triggerDropKeys(node, node.qualifiedName.slice(0, node.qualifiedName.lastIndexOf('::')), triggerFunction(cg, node));
  else if (routineSignature(node) !== null) whats = routineDropKeys(node);
  else if (node.kind === 'class') whats = [`relation:${node.qualifiedName}`];
  else return null;
  return droppedAfter(drops, node, whats);
}

/** `migrations/0052.sql:26`: where a DROP runs. */
export const dropSite = (drop: SqlDrop) => `${drop.file}:${drop.line}`;

/** A table's triggers by name: the latest definition of each, live or ended by a later DROP. */
function tableTriggers(
  cg: CodeGraph,
  table: Node,
  members: readonly Node[],
  drops: Map<string, SqlDrop[]>,
): { live: SqlTrigger[]; dropped: Array<{ node: Node; drop: SqlDrop }> } {
  const latest = new Map<string, Node>();
  for (const node of members.filter(isTrigger).sort(applyOrder)) {
    latest.set(node.qualifiedName, node);
  }
  const calls = new Map<string, string>();
  for (const e of cg.getOutgoingEdgesFrom([...latest.values()].map((n) => n.id), ['calls'])) {
    if (!calls.has(e.source)) calls.set(e.source, e.target);
  }
  const fns = cg.getNodesByIds([...new Set(calls.values())]);
  const live: SqlTrigger[] = [];
  const dropped: Array<{ node: Node; drop: SqlDrop }> = [];
  for (const node of [...latest.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const fn = fns.get(calls.get(node.id) ?? '') ?? null;
    const drop = droppedAfter(drops, node, triggerDropKeys(node, table.qualifiedName, fn));
    if (drop) dropped.push({ node, drop });
    else live.push({ node, when: triggerWhen(node), fn });
  }
  return { live, dropped };
}

const at = (node: Node) => `${node.filePath}:${node.startLine}`;
const MAX_LISTED = 5;
const listed = (items: string[]) =>
  items.length > MAX_LISTED ? `${items.slice(0, MAX_LISTED).join(', ')} +${items.length - MAX_LISTED} more` : items.join(', ');

/** The SQL tables a function writes, or the table a trigger is on. */
export function writePathTables(cg: CodeGraph, node: Node): Node[] {
  if (!isSqlNode(node)) return [];
  const ids = cg.getOutgoingEdges(node.id)
    .filter((e) => {
      if (isTrigger(node)) return e.kind === 'references';
      return sqlEdgeOpList(e).some((op) => op !== 'select');
    })
    .map((e) => e.target);
  if (isTrigger(node)) ids.push(...cg.getIncomingEdges(node.id).filter((e) => e.kind === 'contains').map((e) => e.source));
  return [...cg.getNodesByIds([...new Set(ids)]).values()].filter((n) =>
    n.kind === 'class' && isSqlNode(n) && (!isTrigger(node) || node.qualifiedName.startsWith(`${n.qualifiedName}::`)));
}

/** The live trigger functions and writers whose bodies answer what a write to a table runs. */
export interface SqlWritePath {
  /** The table's block, as the table summary prints it. */
  summary: string;
  /** Each live trigger's function, then each live writer that fires a live trigger, in that order. */
  bodies: Node[];
}

/**
 * What a reader asking about a table's write path wants in one block: its
 * columns, its live triggers with the function each runs, the functions that
 * write it by operation and the triggers each write fires, its policies and
 * indexes, and the triggers later migrations dropped. Null for anything but a
 * SQL table or view.
 */
export function sqlTableSummary(cg: CodeGraph, table: Node): string | null {
  return sqlTableWritePath(cg, table)?.summary ?? null;
}

export function sqlTableWritePath(cg: CodeGraph, table: Node): SqlWritePath | null {
  if (table.kind !== 'class' || !isSqlNode(table)) return null;
  const incoming = cg.getIncomingEdges(table.id);
  const members = [...cg.getChildren(table.id), ...crossFileSqlMembers(cg, table, incoming)];
  const columns = new Set(members.filter((m) => m.kind === 'field').map((m) => m.name)).size;
  const { drops, lastFile } = sqlFileFacts(cg);
  const { live, dropped } = tableTriggers(cg, table, members, drops);
  const lines = [`**SQL table \`${table.qualifiedName}\`** (${at(table)}): ${columns} column${columns === 1 ? '' : 's'}`];
  const bodies = new Map<string, Node>();

  if (live.length > 0 || dropped.length > 0) {
    const last = lastFile.get(migrationSeries(table.filePath));
    const asOf = `as of the last migration${last ? `, ${last}` : ''}`;
    lines.push(live.length > 0 ? `- Triggers (${live.length}, all live triggers ${asOf}):` : `- Triggers: none live ${asOf}`);
  }
  for (const t of live) {
    const fn = t.fn ? liveSqlDefinitionOf(cg, t.fn) : null;
    if (fn && !droppedWith(cg, drops, fn)) bodies.set(fn.id, fn);
    lines.push(`  - ${t.node.name} ${t.when}${fn ? ` → ${fn.name} (${at(fn)})` : ''}, declared ${at(t.node)}`);
  }

  const liveNames = new Set(live.map((t) => t.node.qualifiedName));
  const byOp = new Map<string, Map<string, Edge[]>>();
  for (const edge of incoming) {
    for (const op of sqlEdgeOpList(edge)) {
      if (op === 'select') continue;
      const writers = byOp.get(op) ?? new Map<string, Edge[]>();
      writers.set(edge.source, [...(writers.get(edge.source) ?? []), edge]);
      byOp.set(op, writers);
    }
  }
  const writerIds = [...new Set([...byOp.values()].flatMap((writers) => [...writers.keys()]))];
  const writerNodes = cg.getNodesByIds(writerIds);
  // Keyed by writer and op: a function that updates and deletes a table fires its delete triggers on the delete row only.
  const firedBy = new Map<string, string[]>();
  for (const e of cg.getOutgoingEdgesFrom(writerIds, ['calls'])) {
    const m = e.metadata as { synthesizedBy?: unknown; trigger?: unknown; event?: unknown } | undefined;
    if (m?.synthesizedBy !== 'pg-trigger' || !liveNames.has(String(m.trigger))) continue;
    const key = `${e.source}:${typeof m.event === 'string' ? m.event : ''}`;
    firedBy.set(key, [...(firedBy.get(key) ?? []), String(m.trigger).split('::').pop()!]);
  }
  for (const op of [...SQL_OPS].filter((o) => byOp.has(o))) {
    const writers = byOp.get(op)!;
    const nodes = liveSqlDefinitions(cg, [...writers.keys()].map((id) => writerNodes.get(id)).filter((n): n is Node => !!n), drops).nodes;
    const entries = nodes.flatMap((writer) => {
      const events = op === 'merge' ? ['insert', 'update', 'delete', ''] : [op, ''];
      const fires = [...new Set(events.flatMap((event) => firedBy.get(`${writer.id}:${event}`) ?? []))];
      const firing = fires.length > 0 ? ` fires ${fires.join(', ')}` : '';
      if (writer.kind === 'file') return topLevelWrites(cg, writer, writers.get(writer.id) ?? []).map((w) => `${w}${firing}`);
      const drop = droppedWith(cg, drops, writer);
      if (drop) return [`${writer.name} (${at(writer)}, dropped ${dropSite(drop)})`];
      if (fires.length > 0) bodies.set(writer.id, writer);
      return [`${writer.name} (${at(writer)})${firing}`];
    });
    lines.push(`- ${op}: ${listed(entries)}`);
  }

  const kindOf = (prefix: string) => members.filter((m) => (m.signature ?? '').startsWith(prefix)).map((m) => `${m.name} (${at(m)})`);
  const policies = kindOf('policy:');
  const indexes = kindOf('index:');
  if (policies.length > 0) lines.push(`- Policies: ${listed(policies)}`);
  if (indexes.length > 0) lines.push(`- Indexes: ${listed(indexes)}`);
  if (dropped.length > 0) {
    lines.push(`- Dropped triggers: ${listed(dropped.map((d) => `${d.node.name} (declared ${at(d.node)}, dropped ${d.drop.file}:${d.drop.line})`))}`);
  }
  return { summary: lines.join('\n'), bodies: [...bodies.values()] };
}

const DO_OPEN = /\bDO\s+(\$[A-Za-z_]*\$)/i;

/**
 * The writes a migration runs outside any function, one per statement:
 * `DO block in a.sql:13` when an anonymous block holds it, `statement in
 * a.sql:13` otherwise.
 */
function topLevelWrites(cg: CodeGraph, file: Node, edges: readonly Edge[]): string[] {
  const lines = [...new Set(edges.map((e) => e.line ?? 1))].sort((a, b) => a - b);
  let rows: string[] = [];
  try {
    rows = fs.readFileSync(path.join(cg.getProjectRoot(), file.filePath), 'utf-8').split(/\r?\n/);
  } catch { /* named as a statement */ }
  const inBlock = new Set<number>();
  let tag: string | null = null;
  for (let i = 0; i < rows.length && i < lines[lines.length - 1]!; i++) {
    const row = rows[i]!;
    if (tag === null) {
      const open = DO_OPEN.exec(row);
      if (open && !row.slice(open.index + open[0].length).includes(open[1]!)) tag = open[1]!;
    } else if (row.includes(tag)) tag = null;
    if (tag !== null) inBlock.add(i + 1);
  }
  return lines.map((line) => `${inBlock.has(line) ? 'DO block' : 'statement'} in ${file.filePath}:${line}`);
}

/**
 * The definition of `node`'s object that stands once every migration applies:
 * the latest copy of it, or of its overload still live when a DROP of its own
 * signature ended it. `node` itself when it is no copy of anything.
 */
export function liveSqlDefinitionOf(cg: CodeGraph, node: Node): Node {
  if (!isSqlNode(node)) return node;
  const copies = cg.getNodesByName(node.name).filter((n) =>
    isSqlNode(n) && n.kind === node.kind && n.qualifiedName === node.qualifiedName);
  if (copies.length < 2) return node;
  const live = liveSqlDefinitions(cg, copies).nodes.filter((n) => migrationSeries(n.filePath) === migrationSeries(node.filePath));
  const sig = routineSignature(node);
  return live.find((n) => routineSignature(n) === sig) ?? live[0] ?? node;
}

/**
 * Why a SQL definition no longer runs once every migration applies:
 * `dropped in b.sql:2` (it, or the later copy that replaced it, was dropped),
 * `superseded by c.sql:22` (a later migration redefined it), or null while it
 * is the live definition.
 */
export function sqlHistoryNote(cg: CodeGraph, node: Node): string | null {
  if (!isSqlNode(node)) return null;
  const live = liveSqlDefinitionOf(cg, node);
  const drop = sqlDroppedAt(cg, live);
  if (drop) return `dropped in ${dropSite(drop)}`;
  return live.id === node.id ? null : `superseded by ${at(live)}`;
}

/** `storage.objects_delete_cleanup() RETURNS trigger`: how a SQL object is declared, without its body. */
export function sqlDeclaration(node: Node): string {
  const head = (node.signature ?? node.name)
    .replace(/^\w+:\s*/, '')
    .replace(/^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?(?:function|procedure|trigger|view|table)\s+/i, '')
    .replace(/\s+(?:language|as|security|immutable|stable|volatile)\b[\s\S]*$/i, '')
    .replace(/\s+/g, ' ');
  return head.length > 120 ? `${head.slice(0, 117)}...` : head;
}

const SQL_PATH_TOKEN = /^"?[A-Za-z_][\w$]*"?(?:\.|::)"?[A-Za-z_][\w$]*"?$/;

/**
 * The SQL objects a query names as Postgres writes them, `storage.objects` or
 * `"storage"."objects"`, which the index keeps as `storage::objects`.
 */
export function sqlObjectsNamed(cg: CodeGraph, query: string): Node[] {
  const out = new Map<string, Node>();
  for (const token of query.split(/[\s,()[\]]+/)) {
    const written = token.replace(/[.,;:?!]+$/, '');
    if (!SQL_PATH_TOKEN.test(written)) continue;
    const name = foldObjectName(written.replace(/::/g, '.'));
    if (!name) continue;
    const qualified = qualify(name);
    for (const n of cg.getNodesByName(name.name)) {
      if (isSqlNode(n) && n.qualifiedName === qualified) out.set(n.id, n);
    }
  }
  return [...out.values()];
}

/** `objects_cleanup (function, declared a.sql:1, dropped b.sql:2)` for each of `nodes` a later migration dropped. */
export function droppedSqlObjects(cg: CodeGraph, nodes: readonly Node[]): string[] {
  const live = liveSqlDefinitions(cg, nodes.filter(isSqlNode)).nodes;
  if (live.length === 0) return [];
  const drops = sqlDrops(cg);
  return live.flatMap((n) => {
    const drop = n.kind === 'class' ? null : droppedWith(cg, drops, n);
    const kind = isTrigger(n) ? 'trigger' : n.kind;
    return drop ? [`${n.name} (${kind}, declared ${at(n)}, dropped ${dropSite(drop)})`] : [];
  });
}
