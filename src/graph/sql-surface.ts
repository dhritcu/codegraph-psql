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
 * in apply order is live; the older copies are history, not callers.
 */

import type CodeGraph from '../index';
import type { Edge, Node } from '../types';

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

/** The distinct operations a set of edges performs, in first-seen order. */
export function sqlEdgeOps(edges: readonly Edge[]): string[] {
  return [...new Set(edges.map(sqlEdgeOp).filter((op): op is string => op !== null))];
}

/** For each node among `edges` that accesses a table, the ` [insert, select]` tag its line carries. */
export function sqlOpTags(edges: Iterable<Edge>): Map<string, string> {
  const ops = new Map<string, Set<string>>();
  for (const edge of edges) {
    const op = sqlEdgeOp(edge);
    if (op) ops.set(edge.source, (ops.get(edge.source) ?? new Set()).add(op));
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
export function crossFileSqlMembers(cg: CodeGraph, container: Node): Node[] {
  if (!isSqlNode(container)) return [];
  const ids = cg.getIncomingEdges(container.id).filter((e) => e.kind === 'references').map((e) => e.source);
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

/**
 * Each SQL object once, at its live (latest) definition, with the definitions
 * it superseded. Only copies in different files of one migration series are
 * one object's history: two definitions in one file are overloads, which the
 * qualified name does not tell apart. Non-SQL nodes pass through untouched, in
 * their own order; the live definition takes the place of the first of its copies.
 */
export function liveSqlDefinitions(nodes: readonly Node[]): { nodes: Node[]; superseded: Map<string, Node[]> } {
  const keyOf = (node: Node) => `${node.kind}|${node.qualifiedName}|${migrationSeries(node.filePath)}`;
  const copies = new Map<string, Node[]>();
  for (const node of nodes) {
    if (isSqlNode(node)) copies.set(keyOf(node), [...(copies.get(keyOf(node)) ?? []), node]);
  }
  for (const [key, all] of copies) {
    if (new Set(all.map((n) => n.filePath)).size < all.length) copies.delete(key);
  }
  const superseded = new Map<string, Node[]>();
  const out: Node[] = [];
  const placed = new Set<string>();
  for (const node of nodes) {
    const all = isSqlNode(node) ? copies.get(keyOf(node)) : undefined;
    if (!all) {
      out.push(node);
      continue;
    }
    if (placed.has(keyOf(node))) continue;
    placed.add(keyOf(node));
    const ordered = [...all].sort(applyOrder);
    const live = ordered[ordered.length - 1]!;
    out.push(live);
    if (ordered.length > 1) superseded.set(live.id, ordered.slice(0, -1).reverse());
  }
  return { nodes: out, superseded };
}

/**
 * A symbol's callers as a reader of SQL wants them: a column or trigger a later
 * migration declares on the table is its member, not its caller, and of a view
 * redefined across migrations only the live definition still reads the table.
 * Rows of any other language pass through unchanged.
 */
export function sqlCallerRows<T extends { node: Node }>(target: Node, rows: readonly T[]): T[] {
  if (!rows.some((row) => isSqlNode(row.node))) return [...rows];
  const members = rows.filter((row) => !isCrossFileSqlMember(row.node, target));
  const live = new Set(liveSqlDefinitions(members.map((row) => row.node)).nodes.map((node) => node.id));
  return members.filter((row) => live.has(row.node.id));
}
