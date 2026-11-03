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
 * Triggers apply in migration order like every other object, read from the
 * shared SQL model of what a migration ends (`sql-model.ts`): the latest CREATE
 * TRIGGER of a name on a table wins; a later DROP of the trigger, its table or
 * its function leaves none; `ALTER TABLE ... DISABLE TRIGGER` stops it until
 * an ENABLE. A write a migration runs itself (a DO block) fires the triggers
 * in force at that point of its series. Every other write (a routine body,
 * application code) runs once the migrations have applied, so it fires the
 * triggers in force at the end. The trigger's table and function are the ones
 * its own edges were resolved to, so a table dropped and created again keeps
 * its triggers apart.
 */

import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { splitIdentifierPath } from '../extraction/languages/postgres-names';
import {
  codeOnly, compareNodes, comparePositions, ddlAfter, IDENT, migrationSeries, nodePosition, QUALIFIED, routineDropKeys, SQL_FILE,
  sqlDdlEvents, triggerDropKeys, type SqlDdl, type SqlPosition,
} from './sql-model';

type TriggerEvent = 'insert' | 'update' | 'delete' | 'truncate';

interface Trigger {
  node: Node;
  table: string;
  fn: string;
  tableName: string;
  fnName: string;
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

const TRIGGER_HEAD = new RegExp(
  String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+${IDENT}\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+([\s\S]+?)\s+ON\s+`,
  'i'
);
const TRIGGER_EVENT = /^(INSERT|UPDATE|DELETE|TRUNCATE)(?:\s+OF\s+([\s\S]+))?$/i;
const TRIGGER_LEVEL = /\bFOR\s+(?:EACH\s+)?(ROW|STATEMENT)\b/i;
const UPDATE_TARGET = new RegExp(
  String.raw`^${QUALIFIED}\s*\*?\s*(?:(?:AS\s+)?(?!SET\b)${IDENT}\s+)?SET\b`,
  'i'
);

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

const fileSeries = (file: string): string => migrationSeries(file, 'file');

/**
 * The definition among `defs` (one trigger's, in apply order) in force at
 * `when`, or once every migration has applied when `when` is null: the latest
 * created by then that no DROP of it, its table or its function, and no
 * DISABLE TRIGGER without a later ENABLE, has ended by then.
 */
function inForce(defs: Trigger[], when: SqlPosition | null, ddl: SqlDdl): Trigger | null {
  const created = when ? defs.filter((d) => comparePositions(nodePosition(d.node), when) <= 0) : defs;
  const def = created[created.length - 1];
  if (!def) return null;
  const from = nodePosition(def.node);
  const trigger = def.node.qualifiedName;
  const ends = ddlAfter(ddl, triggerDropKeys(trigger, def.tableName, routineDropKeys(def.fnName, null)), from, fileSeries, when)
    .some((e) => e.kind === 'drop');
  if (ends) return null;
  const switches = ddlAfter(ddl, [`trigger:${trigger}`, `triggers:${def.tableName}`], from, fileSeries, when)
    .filter((e) => e.kind !== 'drop');
  return switches[switches.length - 1]?.kind === 'disable' ? null : def;
}

export async function pgTriggerEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const nodes = ctx.getNodesByKind('method').filter((n) => n.language === 'postgres' && n.signature?.startsWith('trigger:'));
  if (nodes.length === 0) return [];
  // Every definition of one trigger in one series (or unordered file), in apply order.
  const histories = new Map<string, Trigger[]>();
  for (const node of nodes) {
    const text = nodeText(ctx, node);
    const head = text ? readTriggerHead(text) : null;
    const table = tableOf(queries, node);
    const fn = queries.getOutgoingEdges(node.id, ['calls'])[0]?.target;
    const tableName = table && queries.getNodeById(table)?.qualifiedName;
    const fnName = fn && queries.getNodeById(fn)?.qualifiedName;
    if (!head || !table || !fn || !tableName || !fnName) continue;
    const key = `${fileSeries(node.filePath)}\0${node.qualifiedName}`;
    const defs = histories.get(key) ?? [];
    defs.push({ node, table, fn, tableName, fnName, ...head });
    histories.set(key, defs);
  }
  const byTable = new Map<string, Trigger[][]>();
  for (const defs of histories.values()) {
    defs.sort((x, y) => compareNodes(x.node, y.node));
    for (const table of new Set(defs.map((d) => d.table))) {
      const list = byTable.get(table) ?? [];
      list.push(defs);
      byTable.set(table, list);
    }
  }
  const ddl = sqlDdlEvents(ctx);
  await onYield();

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [table, tableHistories] of byTable) {
    for (const write of queries.getIncomingEdges(table, ['references'])) {
      const op = write.metadata?.op;
      if (typeof op !== 'string' || !WRITE_OPS.has(op)) continue;
      const writer = queries.getNodeById(write.source);
      if (!writer) continue;
      const runsAt = writer.kind === 'file' && SQL_FILE.test(writer.filePath) && write.line
        ? { file: writer.filePath, line: write.line }
        : null;
      const actions = writeActions(op, sqlStatementAt(ctx, writer, write), write.metadata?.columns);
      for (const defs of tableHistories) {
        const when = runsAt && fileSeries(runsAt.file) === fileSeries(defs[0]!.node.filePath) ? runsAt : null;
        const trigger = inForce(defs, when, ddl);
        if (!trigger || trigger.table !== table) continue;
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
