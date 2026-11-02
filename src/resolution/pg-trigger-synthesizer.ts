/**
 * PostgreSQL trigger edge synthesis.
 *
 * A write to a table runs the functions its triggers execute, though no
 * line of the writer names them. For every `references` edge that writes a
 * table (`metadata.op` insert / update / delete / merge, from any language),
 * this pass adds a `calls` edge from the writer to each function a live
 * trigger on that table runs for the write.
 *
 * A trigger fires on a write when its events name the write's event:
 * BEFORE, AFTER and INSTEAD OF alike, row and statement level alike. An
 * `UPDATE OF a, b` trigger fires only for an update known to set `a` or `b`:
 * a SQL writer's SET list is read from its statement, another writer's from
 * `metadata.columns` on its edge; an update whose columns are unknown fires
 * only triggers without a column list. An `INSERT ... ON CONFLICT DO UPDATE`
 * is an update too, and a MERGE performs the actions its WHEN clauses name.
 * A trigger's WHEN condition is not evaluated; it is recorded on the edge.
 *
 * Triggers apply in migration order like every other object: the latest
 * CREATE TRIGGER of a name on a table wins, and a later DROP TRIGGER leaves
 * none. The trigger's table and function are the ones its own edges were
 * resolved to, so a table dropped and created again keeps its triggers apart.
 */

import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { foldObjectName, qualify, splitIdentifierPath } from '../extraction/languages/postgres-names';
import { makeLineAt } from './synth-utils';

type TriggerEvent = 'insert' | 'update' | 'delete' | 'truncate';

interface Trigger {
  node: Node;
  table: string;
  fn: string;
  timing: 'before' | 'after' | 'instead of';
  level: 'row' | 'statement';
  /** Each event the trigger fires on; an UPDATE OF list as its column set, any other event as null. */
  events: Map<TriggerEvent, ReadonlySet<string> | null>;
  when?: string;
}

/** One event a write performs: an update with the columns it sets, or null when they are unknown. */
interface WriteAction {
  event: TriggerEvent;
  columns: ReadonlySet<string> | null;
}

const SQL_FILE = /\.(?:sql|psql|pgsql)$/i;
const IDENT = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;

const TRIGGER_HEAD = new RegExp(
  String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+${IDENT}\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+([\s\S]+?)\s+ON\s+`,
  'i'
);
const TRIGGER_EVENT = /^(INSERT|UPDATE|DELETE|TRUNCATE)(?:\s+OF\s+([\s\S]+))?$/i;
const TRIGGER_LEVEL = /\bFOR\s+(?:EACH\s+)?(ROW|STATEMENT)\b/i;
const DROP_TRIGGER = new RegExp(
  String.raw`(?:^|;)\s*DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+ON\s+(${QUALIFIED})`,
  'gi'
);
const UPDATE_TARGET = new RegExp(
  String.raw`^${QUALIFIED}\s*\*?\s*(?:(?:AS\s+)?(?!SET\b)${IDENT}\s+)?SET\b`,
  'i'
);

/**
 * `text` with comments and single-quoted strings blanked, offsets and
 * newlines kept. With `dollarBodies`, dollar-quoted bodies are blanked too;
 * without, the first dollar quote ends the text, as it ends the body a
 * statement inside a routine is read from.
 */
function codeOnly(text: string, dollarBodies: boolean): string {
  let out = '';
  let copied = 0;
  let i = 0;
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

const columnName = (text: string): string | undefined => splitIdentifierPath(text.trim())[0];

/** The text of one statement from `code[at]` up to its `;` (or the end), outside parentheses. */
function statementFrom(code: string, at: number): string {
  let depth = 0;
  for (let i = at; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return code.slice(at, i);
    else if (ch === ';' && depth === 0) return code.slice(at, i);
  }
  return code.slice(at);
}

const SET_END = new Set(['from', 'where', 'returning', 'when']);

/**
 * The columns a SET list assigns, read from `stmt[at]` just past `SET`: `a = 1,
 * (b, c) = (2, 3)` sets a, b, c. Null when the list is not plain enough to read.
 */
function setColumns(stmt: string, at: number): Set<string> | null {
  const columns = new Set<string>();
  const target = new RegExp(String.raw`^\s*(?:\(([^()]*)\)|(${IDENT}))`, 'y');
  let i = at;
  for (;;) {
    target.lastIndex = 0;
    const m = target.exec(stmt.slice(i));
    if (!m) return null;
    for (const name of m[1] !== undefined ? m[1].split(',') : [m[2]!]) {
      const col = columnName(name);
      if (!col) return null;
      columns.add(col);
    }
    i += m[0].length;
    let depth = 0;
    let next = false;
    while (i < stmt.length) {
      const ch = stmt[i]!;
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        i++;
        next = true;
        break;
      } else if (/[A-Za-z_]/.test(ch) && !/[\w$]/.test(stmt[i - 1] ?? ' ')) {
        const word = /^[A-Za-z_][\w$]*/.exec(stmt.slice(i))![0];
        const lower = word.toLowerCase();
        if (lower === 'case') depth++;
        else if (lower === 'end') depth--;
        else if (depth === 0 && SET_END.has(lower)) return columns;
        i += word.length;
        continue;
      }
      i++;
    }
    if (!next) return columns;
  }
}

const afterSet = (stmt: string, re: RegExp): Set<string> | null => {
  const m = re.exec(stmt);
  return m ? setColumns(stmt, m.index + m[0].length) : null;
};

/** What a write of `op` performs, from its statement in a SQL file when it can be read. */
function writeActions(op: string, statement: string | null, edgeColumns: unknown): WriteAction[] {
  const known = Array.isArray(edgeColumns) && edgeColumns.every((c) => typeof c === 'string')
    ? new Set(edgeColumns as string[])
    : null;
  if (op === 'delete') return [{ event: 'delete', columns: null }];
  if (op === 'update') {
    const m = statement ? UPDATE_TARGET.exec(statement) : null;
    return [{ event: 'update', columns: m ? setColumns(statement!, m[0].length) : known }];
  }
  if (op === 'insert') {
    const actions: WriteAction[] = [{ event: 'insert', columns: null }];
    if (statement && /\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\b/i.test(statement)) {
      actions.push({ event: 'update', columns: afterSet(statement, /\bDO\s+UPDATE\s+SET\b/i) });
    }
    return actions;
  }
  if (op !== 'merge') return [];
  if (!statement) {
    return [{ event: 'insert', columns: null }, { event: 'update', columns: known }, { event: 'delete', columns: null }];
  }
  const actions: WriteAction[] = [];
  for (const m of statement.matchAll(/\bTHEN\s+(INSERT|UPDATE|DELETE)\b/gi)) {
    const event = m[1]!.toLowerCase() as TriggerEvent;
    if (actions.some((a) => a.event === event)) continue;
    const columns = event === 'update' ? afterSet(statement.slice(m.index!), /\bUPDATE\s+SET\b/i) : null;
    actions.push({ event, columns });
  }
  return actions;
}

function fires(trigger: Trigger, action: WriteAction): boolean {
  if (!trigger.events.has(action.event)) return false;
  const guard = trigger.events.get(action.event);
  if (!guard) return true;
  return action.columns !== null && [...action.columns].some((c) => guard.has(c));
}

/** `CREATE TRIGGER` text → timing, events, level, WHEN; null when it does not read as one. */
function readTriggerHead(text: string): Pick<Trigger, 'timing' | 'level' | 'events' | 'when'> | null {
  const code = codeOnly(text, true);
  const head = TRIGGER_HEAD.exec(code);
  if (!head) return null;
  const events = new Map<TriggerEvent, ReadonlySet<string> | null>();
  for (const part of head[2]!.split(/\s+OR\s+/i)) {
    const m = TRIGGER_EVENT.exec(part.trim());
    if (!m) return null;
    const columns = m[2] ? new Set(m[2].split(',').map(columnName).filter((c): c is string => !!c)) : null;
    events.set(m[1]!.toLowerCase() as TriggerEvent, columns);
  }
  const rest = code.slice(head.index + head[0].length);
  const when = /\bWHEN\s*\(/i.exec(rest);
  let condition: string | undefined;
  if (when) {
    const open = head.index + head[0].length + when.index + when[0].length;
    let depth = 1;
    let i = open;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
    }
    condition = text.slice(open, i - 1).replace(/\s+/g, ' ').trim();
  }
  return {
    timing: head[1]!.toLowerCase().replace(/\s+/, ' ') as Trigger['timing'],
    level: TRIGGER_LEVEL.exec(rest.slice(0, when?.index ?? rest.length))?.[1]?.toLowerCase() === 'row' ? 'row' : 'statement',
    events,
    ...(condition ? { when: condition } : {}),
  };
}

/** The source text a node spans. */
function nodeText(ctx: ResolutionContext, node: Node): string | null {
  const lines = (ctx.getFileLines?.(node.filePath) ?? ctx.readFile(node.filePath)?.split('\n')) ?? null;
  if (!lines) return null;
  const span = lines.slice(node.startLine - 1, node.endLine);
  if (span.length === 0) return null;
  span[0] = span[0]!.slice(node.startColumn);
  return span.join('\n');
}

/**
 * The migration series a file belongs to, as the Postgres resolver reads it:
 * its path up to the first part that starts with a sequence number, or its
 * directory when that is a `migrations` one; null for a file that is no migration.
 */
function migrationSeries(filePath: string): string | null {
  const parts = filePath.split('/');
  const numbered = parts.findIndex((p) => /^\d+(?:[_\-.]|$)/.test(p));
  if (numbered >= 0) return parts.slice(0, numbered).join('/');
  const dir = parts.slice(0, -1);
  return dir.some((p) => /^migrations?$/i.test(p)) ? dir.join('/') : null;
}

const naturalOrder = new Intl.Collator('en', { numeric: true }).compare;

interface TriggerEventAt {
  file: string;
  line: number;
  node: Node | null;
}

/** Definitions of one trigger in one migration series (or one unordered file) share a key. */
const historyKey = (file: string, qualifiedName: string): string => `${migrationSeries(file) ?? file}\0${qualifiedName}`;

/** Every top-level DROP TRIGGER, keyed like the definitions it ends. */
function readDrops(ctx: ResolutionContext, into: Map<string, TriggerEventAt[]>): void {
  for (const file of ctx.getAllFiles()) {
    if (!SQL_FILE.test(file)) continue;
    const text = ctx.readFile(file);
    if (!text || !/drop\s+trigger/i.test(text)) continue;
    const code = codeOnly(text, true);
    const lineAt = makeLineAt(code, 1);
    for (const m of code.matchAll(DROP_TRIGGER)) {
      const name = columnName(m[1]!);
      const table = foldObjectName(m[2]!);
      if (!name || !table) continue;
      const list = into.get(historyKey(file, qualify(table, name)));
      list?.push({ file, line: lineAt(m.index! + m[0].search(/drop/i)), node: null });
    }
  }
}

/** The trigger nodes still defined once every migration has applied. */
function liveTriggers(nodes: Node[], ctx: ResolutionContext): Node[] {
  const histories = new Map<string, TriggerEventAt[]>();
  for (const node of nodes) {
    const key = historyKey(node.filePath, node.qualifiedName);
    const list = histories.get(key) ?? [];
    list.push({ file: node.filePath, line: node.startLine, node });
    histories.set(key, list);
  }
  readDrops(ctx, histories);
  const live: Node[] = [];
  for (const events of histories.values()) {
    events.sort((a, b) => (a.file === b.file ? a.line - b.line : naturalOrder(a.file, b.file)));
    const last = events[events.length - 1]!.node;
    if (last) live.push(last);
  }
  return live;
}

/** The table a trigger was resolved onto: its containing table, or the table its own reference names. */
function tableOf(queries: QueryBuilder, trigger: Node): string | null {
  for (const e of queries.getIncomingEdges(trigger.id, ['contains'])) {
    if (queries.getNodeById(e.source)?.kind === 'class') return e.source;
  }
  for (const e of queries.getOutgoingEdges(trigger.id, ['references'])) {
    if (!e.metadata?.op && queries.getNodeById(e.target)?.kind === 'class') return e.target;
  }
  return null;
}

const WRITE_OPS = new Set(['insert', 'update', 'delete', 'merge']);

export async function pgTriggerEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const nodes = ctx.getNodesByKind('method').filter((n) => n.language === 'postgres' && n.signature?.startsWith('trigger:'));
  if (nodes.length === 0) return [];
  const byTable = new Map<string, Trigger[]>();
  for (const node of liveTriggers(nodes, ctx)) {
    const text = nodeText(ctx, node);
    const head = text ? readTriggerHead(text) : null;
    const table = tableOf(queries, node);
    const fn = queries.getOutgoingEdges(node.id, ['calls'])[0]?.target;
    if (!head || !table || !fn) continue;
    const list = byTable.get(table) ?? [];
    list.push({ node, table, fn, ...head });
    byTable.set(table, list);
  }
  await onYield();

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [table, triggers] of byTable) {
    for (const write of queries.getIncomingEdges(table, ['references'])) {
      const op = write.metadata?.op;
      if (typeof op !== 'string' || !WRITE_OPS.has(op)) continue;
      const writer = queries.getNodeById(write.source);
      if (!writer) continue;
      const actions = writeActions(op, sqlStatementAt(ctx, writer, write), write.metadata?.columns);
      for (const trigger of triggers) {
        const action = actions.find((a) => fires(trigger, a));
        const key = `${writer.id}>${trigger.fn}`;
        if (!action || trigger.fn === writer.id || seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: writer.id,
          target: trigger.fn,
          kind: 'calls',
          line: write.line,
          column: write.column,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'pg-trigger',
            channel: 'trigger',
            trigger: trigger.node.qualifiedName,
            timing: trigger.timing,
            event: action.event,
            level: trigger.level,
            ...(trigger.when ? { when: trigger.when } : {}),
            registeredAt: `${trigger.node.filePath}:${trigger.node.startLine}`,
          },
        });
      }
    }
    await onYield();
  }
  return edges;
}

/** The write statement a SQL writer's edge sits in, from the table name it names on. */
function sqlStatementAt(ctx: ResolutionContext, writer: Node, write: Edge): string | null {
  if (!SQL_FILE.test(writer.filePath) || !write.line) return null;
  const lines = ctx.getFileLines?.(writer.filePath) ?? ctx.readFile(writer.filePath)?.split('\n');
  if (!lines || write.line > lines.length) return null;
  const tail = [lines[write.line - 1]!.slice(write.column ?? 0), ...lines.slice(write.line, writer.endLine)].join('\n');
  return statementFrom(codeOnly(tail, false), 0);
}
