/**
 * Where a call path meets a SQL table.
 *
 * The walk in `named-symbol-flow.ts` rides `calls` edges only, and a table is
 * no callable. Two SQL facts still belong on the path it prints. A write fires
 * the triggers on its table, and the synthesized `pg-trigger` edge runs from the
 * writer straight to the trigger's function, skipping the table that explains
 * the hop; so the table is put back between them. And a query that names a
 * table asks how the flow reaches it, so a route may end one hop further, on the
 * writer's `references` edge carrying the operation (`metadata.op`).
 *
 * Neither changes the walk. Tables are scored and spliced around the routes it
 * found, and with no table named and no trigger hop on a route both are the
 * identity, so a flow in any other language comes out exactly as before.
 */

import type CodeGraph from '../index';
import type { Edge, Node } from '../types';
import type { FlowStep } from './named-symbol-flow';
import { isSqlNode, sqlEdgeOp } from './sql-surface';

/** One route of the walk, as `named-symbol-flow` keeps it in its parent map. */
interface RouteStep extends FlowStep {
  prev: string | null;
  depth: number;
  named: number;
}

/** A route that ends one hop further, at a named table its last node accesses. */
export interface TableEnd {
  key: string;
  table: Node;
  edge: Edge;
}

const MAX_TABLES_PER_TOKEN = 4;
const WRITE_OPS: ReadonlySet<string> = new Set(['insert', 'update', 'delete', 'merge']);

/** The SQL tables and views among one token's hits. */
export function sqlTablesOf(hits: readonly Node[]): Node[] {
  return hits.filter((n) => n.kind === 'class' && isSqlNode(n)).slice(0, MAX_TABLES_PER_TOKEN);
}

/** `insert into \`orders\``: how a step onto a table reads; null for any other edge. */
export function describeTableAccess(edge: Edge | null, table: Node): string | null {
  const op = sqlEdgeOp(edge);
  if (!op) return null;
  const name = `\`${table.name}\``;
  switch (op) {
    case 'select': return `select from ${name}`;
    case 'insert': return `insert into ${name}`;
    case 'merge': return `merge into ${name}`;
    case 'delete': return `delete from ${name}`;
    default: return `${op} ${name}`;
  }
}

function isTriggerHop(edge: Edge | null): edge is Edge {
  return (edge?.metadata as { synthesizedBy?: unknown } | undefined)?.synthesizedBy === 'pg-trigger';
}

export interface SqlFlow {
  /** Routes whose last node accesses a table the query named. */
  tableEnds(parent: ReadonlyMap<string, RouteStep>): TableEnd[];
  /** A route's length and named count once its tables are spliced in, as it will print. */
  score(parent: ReadonlyMap<string, RouteStep>, key: string, end: TableEnd | null): { len: number; named: number };
  /** The chain as it prints: each trigger hop through its table, then the table it ends at. */
  expand(steps: FlowStep[], end: TableEnd | null): FlowStep[];
}

export function sqlFlow(cg: CodeGraph, tables: ReadonlyMap<string, Node>): SqlFlow {
  let writers: Map<string, TableEnd[]> | null = null;
  const writersOf = (): Map<string, TableEnd[]> => {
    if (writers) return writers;
    writers = new Map();
    for (const table of tables.values()) {
      for (const edge of cg.getIncomingEdges(table.id)) {
        if (!sqlEdgeOp(edge)) continue;
        const list = writers.get(edge.source) ?? [];
        if (!list.some((e) => e.table.id === table.id)) list.push({ key: '', table, edge });
        writers.set(edge.source, list);
      }
    }
    return writers;
  };

  // The synthesizer gives a trigger hop the position of the write that fires it,
  // so the write edge at that position names the table.
  const behind = new Map<Edge, { table: Node; write: Edge } | null>();
  const tableBehind = (hop: Edge): { table: Node; write: Edge } | null => {
    if (behind.has(hop)) return behind.get(hop)!;
    const writes = cg.getOutgoingEdges(hop.source).filter((e) => WRITE_OPS.has(sqlEdgeOp(e) ?? ''));
    const write = writes.find((e) => e.line === hop.line && e.column === hop.column);
    const table = write ? cg.getNode(write.target) : null;
    const found = write && table ? { table, write } : null;
    behind.set(hop, found);
    return found;
  };

  /** The tables a route's trigger hops pass through. */
  const splicedOn = (parent: ReadonlyMap<string, RouteStep>, key: string): Node[] => {
    const out: Node[] = [];
    for (let cur: string | null = key; cur !== null; cur = parent.get(cur)!.prev) {
      const { edge } = parent.get(cur)!;
      const spliced = isTriggerHop(edge) ? tableBehind(edge) : null;
      if (spliced) out.push(spliced.table);
    }
    return out;
  };

  return {
    tableEnds(parent) {
      if (tables.size === 0) return [];
      const ends: TableEnd[] = [];
      for (const [key, step] of parent) {
        for (const end of writersOf().get(step.node.id) ?? []) {
          if (!splicedOn(parent, key).some((t) => t.id === end.table.id)) ends.push({ ...end, key });
        }
      }
      return ends;
    },

    score(parent, key, end) {
      const spliced = splicedOn(parent, key);
      const at = parent.get(key)!;
      const len = at.depth + 1 + spliced.length + (end ? 1 : 0);
      const named = at.named + spliced.filter((t) => tables.has(t.id)).length + (end ? 1 : 0);
      return { len, named };
    },

    expand(steps, end) {
      if (!end && !steps.some((s) => isTriggerHop(s.edge))) return steps;
      const out: FlowStep[] = [];
      for (const step of steps) {
        const spliced = isTriggerHop(step.edge) ? tableBehind(step.edge) : null;
        if (!spliced) {
          out.push(step);
          continue;
        }
        // The hop out of the table is the trigger's, but it is no call the table
        // makes: it carries the trigger's wording and no call-site line.
        const { line: _line, column: _column, ...trigger } = step.edge!;
        out.push({ node: spliced.table, edge: spliced.write });
        out.push({ node: step.node, edge: { ...trigger, source: spliced.table.id } });
      }
      if (end) out.push({ node: end.table, edge: end.edge });
      return out;
    },
  };
}
