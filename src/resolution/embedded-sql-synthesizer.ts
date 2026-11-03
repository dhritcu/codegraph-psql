/**
 * SQL written inside TypeScript / JavaScript strings → the SQL objects it touches.
 *
 * `await sql\`INSERT INTO orders ...\`` and `pool.query('UPDATE orders SET ...')`
 * write a table no line of the graph names. This pass reads the literal, parses
 * it with the Postgres grammar, and links the enclosing function to each table
 * and function the statement names, as a SQL routine body's edges are linked.
 *
 * A literal counts only on a client with evidence (`CLIENTS`): the `sql` tag of
 * slonik, drizzle-orm or kysely; a postgres.js instance (`postgres(url)`) used
 * as a tag or through `.unsafe()`; `.query()` on a node-postgres `Pool` /
 * `Client` (or the client a pool's `.connect()` returns); `.raw()` on a knex
 * instance. Instances and factories are found in the file or one project
 * import away, as the query-builder pass finds them. Prisma's raw API is its
 * own evidence: `$queryRaw` / `$executeRaw` (tagged, or given a `Prisma.sql`
 * template) and their `Unsafe` forms, and `Prisma.sql` templates, in a file
 * that imports a Prisma module; Prisma clients are injected (`this.prisma`, a
 * transaction's `tx`) more often than they are bound.
 *
 * Each `${...}` hole becomes a parameter (`$1`, `$2`, ...) of the hole's length,
 * so positions in the statement are positions in the file. A literal that does
 * not parse clean makes nothing: a fragment, a hole standing for a name
 * (`${sql(table)}`), a string built by concatenation.
 *
 * The Postgres grammar loads only once a candidate literal is found.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ImportMapping, ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import { resolveImportPath } from './import-resolver';
import { isGeneratedFile } from '../extraction/generated-detection';
import { isTestPath } from '../search/query-utils';
import { enclosingFn, makeLineAt } from './synth-utils';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { sqlTreeRefs, type BodyRef, type SqlOp } from '../extraction/languages/postgres-bodies';
import { splitIdentifierPath } from '../extraction/languages/postgres-names';
import { sqlClients, type SqlTextClient } from './sql-model';
import { closeBracket, importsOf, packageOf, resolveTarget, triggerHops, type PackageCache, type SqlTarget } from './sql-client-synthesizer';

type Client = SqlTextClient | 'prisma';

const CLIENTS = sqlClients('text');

/** A module specifier with a `prisma` segment: `@prisma/client`, `@calcom/prisma`, `../generated/prisma/client`. */
const PRISMA_MODULE = /(?:^|[/@])prisma(?:[/-]|$)/;

const JS_FILE = /\.(?:[cm]?[jt]sx?)$/;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const GENERIC = String.raw`(?:<[^()\`]{0,400}?>)?`;
const escape = (name: string): string => name.replace(/\$/g, '\\$');

/** A call shape one of the clients runs SQL with, or a client package; a file with neither is not read. */
const USE_GATE = /\$(?:query|execute)Raw|\bsql\s*(?:<[^`;]*?>)?\s*`|\.\s*(?:query|raw|unsafe)\s*(?:<[^()]*?>)?\s*\(|['"](?:pg|postgres|slonik|knex|drizzle-orm|kysely)['"]/;

/** Whether a file can feed this pass. */
export function hasEmbeddedSqlPattern(filePath: string, content: string): boolean {
  return JS_FILE.test(filePath) && USE_GATE.test(content);
}

/** What the last run of the pass saw; the grammar is loaded only when `candidates > 0`. */
export const embeddedSqlStats = { files: 0, candidates: 0, parsed: 0, edges: 0, grammarLoaded: false };

// =============================================================================
// Receiver evidence
// =============================================================================

interface FileFacts {
  file: string;
  code: string;
  imports: ImportMapping[];
  /** Local names bound to a client: an instance, or a tag. */
  instances: Map<string, SqlTextClient>;
  /** Local functions whose body makes a client and returns it. */
  factories: Map<string, SqlTextClient>;
  defaultExport: string | null;
}

/** The client an import makes or is, and how. */
function importedClient(im: ImportMapping): SqlTextClient | null {
  const pkg = packageOf(im.source);
  for (const [client, c] of CLIENTS) {
    if (c.packages[pkg]?.includes(im.isDefault || im.isNamespace ? 'default' : im.exportedName)) return client;
  }
  return null;
}

const BOUND = new RegExp(String.raw`(?:\b(?:const|let|var)\s+)?(?<![\w$.])(${IDENT})\s*(?::[^=;]*?)?=\s*(?:await\s+)?(?:[\w$.]+\s*(?:\|\||\?\?)\s*)?$`);
const RETURNED = /(?:\breturn|=>)\s*(?:await\s+)?$/;

function readFacts(ctx: ResolutionContext, file: string): FileFacts | null {
  const content = ctx.readFile(file);
  if (!content) return null;
  const code = stripCommentsForRegex(content, 'typescript');
  const imports = importsOf(ctx, file, code).filter((im) => code.includes(`'${im.source}'`) || code.includes(`"${im.source}"`));
  const instances = new Map<string, SqlTextClient>();
  const factories = new Map<string, SqlTextClient>();
  const nodes = ctx.getNodesInFile(file);
  const lineOf = makeLineAt(code, 1);
  const lines = code.split('\n');
  for (const im of imports) {
    const client = importedClient(im);
    if (!client) continue;
    const { make } = CLIENTS.get(client)!;
    if (make === 'tag') {
      instances.set(im.localName, client);
      continue;
    }
    // `new pg.Pool()` through a default import, `new Pool()` through a named one.
    const member = client === 'pg' && (im.isDefault || im.isNamespace) ? String.raw`\s*\.\s*(?:Pool|Client)` : '';
    const maker = new RegExp(String.raw`(?<![\w$.])${make === 'new' ? String.raw`new\s+` : ''}${escape(im.localName)}${member}\s*${GENERIC}\s*\(`, 'g');
    for (const m of code.matchAll(maker)) {
      const before = code.slice(Math.max(0, m.index! - 200), m.index!);
      const name = BOUND.exec(before)?.[1];
      if (name) instances.set(name, client);
      const fn = enclosingFn(nodes, lineOf(m.index!));
      const body = fn ? lines.slice(fn.startLine - 1, fn.endLine).join('\n') : '';
      if (fn && (RETURNED.test(before) || (name && new RegExp(String.raw`\breturn\s+${escape(name)}\s*(?:;|\}|$)`, 'm').test(body)))) {
        factories.set(fn.name, client);
      }
    }
  }
  // `const knex = require('knex')({ client: 'pg' })`: the factory called where it is required.
  for (const m of code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)\s*\(`, 'g'))) {
    const client = importedClient({ localName: m[1]!, exportedName: 'default', source: m[3]!, isDefault: true, isNamespace: false });
    if (client && CLIENTS.get(client)!.make === 'call') instances.set(m[1]!, client);
  }
  const def = new RegExp(String.raw`\bexport\s+default\s+(${IDENT})\s*;?\s*$`, 'm').exec(code);
  return { file, code, imports, instances, factories, defaultExport: def?.[1] ?? null };
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

/** The receivers of a file, as regex sources: its own clients and those of the modules it imports them from. */
function receivers(ctx: ResolutionContext, facts: FileFacts, cache: FactsCache): Map<string, SqlTextClient> {
  const instances = new Map(facts.instances);
  const factories = new Map(facts.factories);
  const lang = facts.file.endsWith('x') ? 'tsx' : 'typescript';
  for (const im of facts.imports) {
    if (im.isNamespace || instances.has(im.localName) || factories.has(im.localName)) continue;
    if (!im.source.startsWith('.') && !im.resolvedPath && !/^[@~#]\//.test(im.source)) continue;
    const resolved = im.resolvedPath ?? resolveImportPath(im.source, facts.file, lang, ctx);
    if (!resolved || !JS_FILE.test(resolved)) continue;
    const there = factsOf(ctx, resolved, cache);
    const exported = im.isDefault ? there?.defaultExport : im.exportedName;
    if (!there || !exported) continue;
    const instance = there.instances.get(exported);
    const factory = there.factories.get(exported);
    if (instance) instances.set(im.localName, instance);
    else if (factory) factories.set(im.localName, factory);
  }
  // `const db = await makeDb()`, and `const client = await pool.connect()` on a pg pool.
  const made = new RegExp(String.raw`\b(?:const|let|var)\s+(${IDENT})\s*(?::[^=;]*?)?=\s*(?:await\s+)?(${IDENT})\s*(\.\s*connect\s*)?\(`, 'g');
  for (const m of facts.code.matchAll(made)) {
    const client = m[3] ? (instances.get(m[2]!) === 'pg' ? 'pg' : undefined) : factories.get(m[2]!);
    if (client && !instances.has(m[1]!)) instances.set(m[1]!, client);
  }
  return new Map([
    ...[...instances].map(([name, c]) => [escape(name), c] as const),
    ...[...factories].map(([name, c]) => [String.raw`${escape(name)}\s*\(\s*\)`, c] as const),
  ]);
}

// =============================================================================
// Literals
// =============================================================================

interface Literal {
  /** Index of the statement's first character in the file. */
  start: number;
  /** The statement, holes as parameters, as long as the source it came from. */
  text: string;
}

/** The template literal whose backtick is at `tick`, each hole a parameter of its own length. */
function template(s: string, tick: number): Literal | null {
  let text = '';
  let holes = 0;
  for (let i = tick + 1; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '`') return { start: tick + 1, text };
    if (ch === '\\') {
      text += ` ${s[i + 1] ?? ''}`;
      i++;
    } else if (ch === '$' && s[i + 1] === '{') {
      const close = closeBracket(s, i + 1);
      if (close >= s.length) return null;
      const param = `$${++holes}`;
      text += param + s.slice(i + param.length, close + 1).replace(/[^\n]/g, ' ');
      i = close;
    } else {
      text += ch;
    }
  }
  return null;
}

/**
 * The SQL a call's first argument spells out: a string literal, a template
 * literal, or a template under one of `tags`, standing alone as the argument.
 */
function argument(s: string, open: number, tags: RegExp): Literal | null {
  const at = open + 1 + (/^\s*/.exec(s.slice(open + 1))?.[0].length ?? 0);
  const ch = s[at];
  let lit: Literal | null = null;
  let end: number;
  if (ch === "'" || ch === '"') {
    const m = new RegExp(String.raw`^${ch}((?:[^${ch}\\\n]|\\.)*)${ch}`).exec(s.slice(at));
    if (!m) return null;
    lit = { start: at + 1, text: m[1]!.replace(/\\(.)/g, ' $1') };
    end = at + m[0].length;
  } else {
    const tag = tags.exec(s.slice(at));
    const tick = ch === '`' ? at : tag ? at + tag[0].length - 1 : -1;
    lit = tick >= 0 ? template(s, tick) : null;
    if (!lit) return null;
    end = lit.start + lit.text.length + 1;
  }
  return /^\s*[,)]/.test(s.slice(end)) ? lit : null;
}

/** Knex's `?` value bindings as parameters; a `??` binding names an identifier and is left to fail the parse. */
function knexBindings(literal: Literal): Literal {
  let n = 0;
  return { ...literal, text: literal.text.replace(/(?<!\?)\?(?!\?)/g, () => `$${++n}`) };
}

interface Candidate {
  client: Client;
  /** How the call reads: "sql tag", ".query()", ".$queryRaw tag". */
  call: string;
  literal: Literal;
}

function prismaCandidates(facts: FileFacts, out: Candidate[]): void {
  const prisma = facts.imports.filter((im) => PRISMA_MODULE.test(packageOf(im.source)));
  if (prisma.length === 0) return;
  const ns = prisma.filter((im) => im.exportedName === 'Prisma' || im.localName === 'Prisma').map((im) => escape(im.localName));
  const nsTag = ns.length > 0 ? String.raw`(?:${ns.join('|')})\s*\.\s*sql\s*\`` : null;
  const tags = new RegExp(String.raw`^${nsTag ?? '(?!)'}`);
  const methods = new RegExp(String.raw`\.\s*(\$(?:query|execute)Raw(?:Unsafe)?)\s*${GENERIC}\s*([\`(])`, 'g');
  for (const m of facts.code.matchAll(methods)) {
    const at = m.index! + m[0].length - 1;
    const tagged = m[2] === '`';
    if (tagged && m[1]!.endsWith('Unsafe')) continue;
    const literal = tagged ? template(facts.code, at) : argument(facts.code, at, tags);
    if (literal) out.push({ client: 'prisma', call: `.${m[1]}${tagged ? ' tag' : '()'}`, literal });
  }
  if (!nsTag) return;
  for (const m of facts.code.matchAll(new RegExp(String.raw`(?<![\w$.])${nsTag}`, 'g'))) {
    const literal = template(facts.code, m.index! + m[0].length - 1);
    if (literal) out.push({ client: 'prisma', call: 'Prisma.sql tag', literal });
  }
}

function candidatesIn(ctx: ResolutionContext, facts: FileFacts, cache: FactsCache): Candidate[] {
  const out: Candidate[] = [];
  const recv = receivers(ctx, facts, cache);
  const tagSources = [...recv].filter(([, c]) => CLIENTS.get(c)!.tagged).map(([r]) => r);
  const tags = new RegExp(String.raw`^(?:${tagSources.length > 0 ? tagSources.join('|') : '(?!)'})\s*${GENERIC}\s*\``);
  for (const [receiver, client] of recv) {
    const { tagged, methods } = CLIENTS.get(client)!;
    if (tagged) {
      // slonik's `sql.unsafe\`...\``, `sql.type(Row)\`...\``, `sql.typeAlias('id')\`...\``.
      const re = new RegExp(String.raw`(?<![\w$.])${receiver}\s*(?:\.\s*(?:unsafe|type(?:Alias)?\s*\([^()]*\)))?\s*${GENERIC}\s*\``, 'g');
      for (const m of facts.code.matchAll(re)) {
        const literal = template(facts.code, m.index! + m[0].length - 1);
        if (literal) out.push({ client, call: 'sql tag', literal });
      }
    }
    if (methods.length === 0) continue;
    const re = new RegExp(String.raw`(?<![\w$.])${receiver}\s*\??\.\s*(${methods.join('|')})\s*${GENERIC}\s*\(`, 'g');
    for (const m of facts.code.matchAll(re)) {
      const literal = argument(facts.code, m.index! + m[0].length - 1, tags);
      if (literal) out.push({ client, call: `.${m[1]}()`, literal: client === 'knex' ? knexBindings(literal) : literal });
    }
  }
  prismaCandidates(facts, out);
  // `$queryRaw(Prisma.sql`...`)` is found as the call and as the template: one literal, one candidate.
  const byStart = new Map<number, Candidate>();
  for (const c of out) if (!byStart.has(c.literal.start) && /\S/.test(c.literal.text)) byStart.set(c.literal.start, c);
  return [...byStart.values()].sort((a, b) => a.literal.start - b.literal.start);
}

// =============================================================================
// Statements
// =============================================================================

/** What a write does beyond its op: the columns an update sets, and an insert's ON CONFLICT DO UPDATE. */
interface WriteFacts {
  columns: string[] | null;
  upsert: boolean;
}

/** The columns a SET list assigns. */
function setColumns(list: SyntaxNode | null | undefined): string[] | null {
  if (!list) return null;
  const columns = new Set<string>();
  for (const target of list.descendantsOfType('set_target')) {
    const name = target?.namedChildren[0] && splitIdentifierPath(target.namedChildren[0].text)[0];
    if (name) columns.add(name);
  }
  return columns.size > 0 ? [...columns] : null;
}

/** Each write's facts, by the position of the table name it writes. */
function writeFacts(root: SyntaxNode): Map<string, WriteFacts> {
  const out = new Map<string, WriteFacts>();
  const key = (n: SyntaxNode): string => `${n.startPosition.row}:${n.startPosition.column}`;
  for (const stmt of root.descendantsOfType(['UpdateStmt', 'InsertStmt'])) {
    if (!stmt) continue;
    const update = stmt.type === 'UpdateStmt';
    const target = stmt.namedChildren.find((c) => c?.type === (update ? 'relation_expr_opt_alias' : 'insert_target'));
    const name = target?.descendantsOfType('qualified_name')[0];
    if (!name) continue;
    if (update) {
      out.set(key(name), { columns: setColumns(stmt.namedChildren.find((c) => c?.type === 'set_clause_list')), upsert: false });
      continue;
    }
    const conflict = stmt.namedChildren.find((c) => c?.type === 'opt_on_conflict');
    if (conflict?.namedChildren.some((c) => c?.type === 'kw_update')) {
      out.set(key(name), { columns: setColumns(conflict.namedChildren.find((c) => c?.type === 'set_clause_list')), upsert: true });
    }
  }
  return out;
}

interface Statement {
  refs: BodyRef[];
  writes: Map<string, WriteFacts>;
}

async function parse(text: string): Promise<Statement | null> {
  if (!embeddedSqlStats.grammarLoaded) {
    embeddedSqlStats.grammarLoaded = true;
    await loadGrammarsForLanguages(['postgres']);
  }
  const tree = getParser('postgres')?.parse(text);
  if (!tree) return null;
  try {
    if (tree.rootNode.hasError) return null;
    return { refs: sqlTreeRefs(tree.rootNode), writes: writeFacts(tree.rootNode) };
  } finally {
    tree.delete();
  }
}

// =============================================================================
// The pass
// =============================================================================

/** The first words of a statement, for the hop's wording. */
const head = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').replace(/ ([,)])/g, '$1').trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
};

function addRef(byPair: Map<string, Edge>, edges: Edge[], from: Node, target: Node, ref: BodyRef, write: WriteFacts | undefined,
  candidate: Candidate, line: number, column: number): void {
  const ops: SqlOp[] = ref.op ? [ref.op, ...(write?.upsert ? ['update' as const] : [])] : [];
  const pair = `${from.id}>${target.id}`;
  const seen = byPair.get(pair);
  if (!seen) {
    const edge: Edge = {
      source: from.id,
      target: target.id,
      kind: ref.kind,
      line,
      column,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'sql-embedded',
        channel: 'db',
        client: candidate.client,
        call: candidate.call,
        statement: head(candidate.literal.text),
        ...(ops.length > 0 ? { op: ops[0], ops } : {}),
        ...(write?.upsert ? { upsert: true } : {}),
        ...(write?.columns ? { columns: [...write.columns] } : {}),
        registeredAt: `${target.filePath}:${target.startLine}`,
      },
    };
    byPair.set(pair, edge);
    edges.push(edge);
    return;
  }
  // One edge per function and object: it sits at the first write, where a trigger hop starts.
  const m = seen.metadata as Record<string, unknown>;
  if (ops.length === 0) return;
  m.ops = [...new Set([...((m.ops as SqlOp[] | undefined) ?? []), ...ops])];
  if (ops[0] !== 'select' && (!m.op || m.op === 'select')) {
    Object.assign(m, { op: ops[0], call: candidate.call, statement: head(candidate.literal.text) });
    seen.line = line;
    seen.column = column;
  }
  if (write?.upsert) m.upsert = true;
  if (write?.columns) m.columns = [...new Set([...((m.columns as string[] | undefined) ?? []), ...write.columns])];
}

export async function embeddedSqlEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  Object.assign(embeddedSqlStats, { files: 0, candidates: 0, parsed: 0, edges: 0, grammarLoaded: false });
  const cache: FactsCache = new Map();
  const edges: Edge[] = [];
  const byPair = new Map<string, Edge>();
  const targets = new Map<string, Node | null>();
  const packages: PackageCache = new Map();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!JS_FILE.test(file) || isTestPath(file) || isGeneratedFile(file)) continue;
    if ((++scanned & 63) === 0) await onYield();
    const content = ctx.readFile(file);
    if (!content || !USE_GATE.test(content)) continue;
    const facts = factsOf(ctx, file, cache);
    if (!facts) continue;
    embeddedSqlStats.files++;
    const candidates = candidatesIn(ctx, facts, cache);
    if (candidates.length === 0) continue;
    const nodes = ctx.getNodesInFile(file);
    const lineOf = makeLineAt(facts.code, 1);
    for (const candidate of candidates) {
      embeddedSqlStats.candidates++;
      const statement = await parse(candidate.literal.text);
      if (!statement) continue;
      embeddedSqlStats.parsed++;
      const startLine = lineOf(candidate.literal.start);
      const startColumn = candidate.literal.start - (facts.code.lastIndexOf('\n', candidate.literal.start - 1) + 1);
      const from = enclosingFn(nodes, startLine);
      if (!from) continue;
      for (const ref of statement.refs) {
        const kind: SqlTarget['kind'] = ref.kind === 'calls' ? 'function' : 'table';
        const key = `${kind}:${ref.target.schema}.${ref.target.name}@${file}`;
        let target = targets.get(key);
        if (target === undefined) {
          target = resolveTarget(ctx, { kind, ...ref.target }, file, packages);
          targets.set(key, target);
        }
        if (!target) continue;
        const { row, column } = ref.at.startPosition;
        const write = statement.writes.get(`${row}:${column}`);
        addRef(byPair, edges, from, target, ref, write, candidate, startLine + row, row === 0 ? startColumn + column : column);
      }
    }
  }
  await onYield();
  embeddedSqlStats.edges = edges.length;
  if (process.env.CODEGRAPH_SYNTH_TIMINGS) {
    const s = embeddedSqlStats;
    console.error(`[sql-embedded] files=${s.files} candidates=${s.candidates} parsed=${s.parsed} edges=${s.edges} grammar=${s.grammarLoaded ? 'loaded' : 'not-loaded'}`);
  }
  return [...edges, ...(await triggerHops(queries, ctx, edges, onYield))];
}
