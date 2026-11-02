/**
 * What PostgreSQL routine bodies read, write, and call.
 *
 * A `LANGUAGE plpgsql` body or a `DO` block is parsed with the PL/pgSQL
 * grammar, and each `sql_expression` in it again with the Postgres grammar;
 * a `LANGUAGE sql` body is parsed with the Postgres grammar directly. Every
 * parse covers only its span of the real file through tree-sitter's included
 * ranges, so each position it reports is a position in the file. A bare
 * expression (`PERFORM f(x)`, `v := g(y)`) is read as `SELECT <expr>` by
 * presenting the keyword in place of the text just before it, and the
 * PL/pgSQL-only `INTO` targets are presented as blanks, since those are
 * variables and the Postgres grammar has no `RETURNING ... INTO`.
 *
 * Dynamic SQL (`EXECUTE`) yields nothing: its text is only known at run time.
 */

import type { Node as SyntaxNode, Parser, Point, Range } from 'web-tree-sitter';
import { getParser } from '../grammars';
import { foldObjectName, splitIdentifierPath, type SqlName } from './postgres-names';

export type SqlOp = 'select' | 'insert' | 'update' | 'delete' | 'merge';

/**
 * Prefix of the `candidates` entry that carries a table reference's operation
 * (`sql-op:insert`) through the unresolved-reference store to the resolver,
 * which has no other field for it.
 */
export const SQL_OP_CANDIDATE = 'sql-op:';

export interface BodyRef {
  target: SqlName;
  kind: 'references' | 'calls';
  op?: SqlOp;
  at: { startPosition: Point };
}

/** The table a DML statement writes sits in this child, with this operation. */
const WRITE_TARGET: Record<string, { child: string; op: SqlOp }> = {
  InsertStmt: { child: 'insert_target', op: 'insert' },
  UpdateStmt: { child: 'relation_expr_opt_alias', op: 'update' },
  DeleteStmt: { child: 'relation_expr_opt_alias', op: 'delete' },
  MergeStmt: { child: 'relation_expr_opt_alias', op: 'merge' },
};

const STATEMENT_START = /^\s*\(*\s*(select|with|values|table|insert|update|delete|merge)\b/i;

interface Overlay {
  start: number;
  end: number;
  text: string;
}

const firstDescendant = (n: SyntaxNode, type: string): SyntaxNode | null => {
  for (const c of n.namedChildren) {
    if (!c) continue;
    if (c.type === type) return c;
    const d = firstDescendant(c, type);
    if (d) return d;
  }
  return null;
};

function collectText(n: SyntaxNode, type: string, out: Set<string>): Set<string> {
  for (const c of n.namedChildren) {
    if (!c) continue;
    if (c.type === type) {
      const name = splitIdentifierPath(c.text)[0];
      if (name) out.add(name);
    } else {
      collectText(c, type, out);
    }
  }
  return out;
}

/**
 * Parse `range` of `source` with `parser`, seeing `overlays` in place of the
 * text they cover. Overlays keep every newline they cover, so rows stay the file's.
 */
function parseRange(parser: Parser, source: string, range: Range, overlays: Overlay[] = []): SyntaxNode | null {
  const input = overlays.length === 0
    ? source
    : (index: number): string | undefined => {
      if (index >= source.length) return undefined;
      for (const o of overlays) {
        if (index >= o.start && index < o.end) return o.text.slice(index - o.start);
        if (index < o.start) return source.slice(index, o.start);
      }
      return source.slice(index);
    };
  return parser.parse(input, null, { includedRanges: [range] })?.rootNode ?? null;
}

/** Table and function references in a Postgres syntax tree. `locals` are names that are variables, never tables. */
export function sqlTreeRefs(root: SyntaxNode, locals: ReadonlySet<string>, out: BodyRef[] = []): BodyRef[] {
  const ctes = new Set<string>();
  for (const cte of root.descendantsOfType('common_table_expr')) {
    const name = cte?.namedChildren.find((c) => c?.type === 'name');
    const folded = name && splitIdentifierPath(name.text)[0];
    if (folded) ctes.add(folded);
  }
  const table = (q: SyntaxNode | null, op: SqlOp): void => {
    if (!q) return;
    const parts = splitIdentifierPath(q.text);
    if (parts.length === 1 && (ctes.has(parts[0]!) || locals.has(parts[0]!))) return;
    const target = foldObjectName(q.text);
    if (target) out.push({ target, kind: 'references', op, at: { startPosition: q.startPosition } });
  };
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'ERROR') return;
    if (n.type === 'relation_expr') {
      table(firstDescendant(n, 'qualified_name'), 'select');
      return;
    }
    if (n.type === 'func_application') {
      const fn = n.namedChildren.find((c) => c?.type === 'func_name');
      const target = fn ? foldObjectName(fn.text) : null;
      if (target) out.push({ target, kind: 'calls', at: { startPosition: fn!.startPosition } });
    }
    const write = WRITE_TARGET[n.type];
    for (const c of n.namedChildren) {
      if (!c) continue;
      if (write && c.type === write.child) table(firstDescendant(c, 'qualified_name'), write.op);
      else walk(c);
    }
  };
  walk(root);
  return out;
}

/** Spaces over `[start, end)` that keep its newlines. */
function blank(source: string, start: number, end: number): Overlay {
  return { start, end, text: source.slice(start, end).replace(/[^\n]/g, ' ') };
}

/**
 * `INTO [STRICT] a, b` in a PL/pgSQL statement names variables; outside
 * `INSERT INTO` / `MERGE INTO` it is blanked.
 */
function intoTargets(source: string, start: number, end: number): Overlay[] {
  const out: Overlay[] = [];
  const re = /(\S+)(\s+)INTO\s+(?:STRICT\s+)?(?:"[^"]*"|[\w$.]+)(?:\s*,\s*(?:"[^"]*"|[\w$.]+))*/gi;
  const text = source.slice(start, end);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const prev = m[1]!.toLowerCase();
    if (prev === 'insert' || prev === 'merge') continue;
    out.push(blank(source, start + m.index + m[1]!.length + m[2]!.length, start + m.index + m[0].length));
  }
  return out;
}

/**
 * Where `SELECT` can be presented before an expression starting at `at`: the
 * nearest six characters with no newline that end before it, with blanks
 * between them and the expression. Null when the source holds no such run.
 */
function selectPrefix(source: string, at: number, atPoint: Point): { overlay: Overlay; start: Point } | null {
  let k = at - 7;
  while (k >= 0 && source.slice(k, k + 6).includes('\n')) k--;
  if (k < 0) return null;
  const gap = blank(source, k + 6, at);
  const rowsUp = gap.text.split('\n').length - 1;
  return {
    overlay: { start: k, end: at, text: `SELECT${gap.text}` },
    start: { row: atPoint.row - rowsUp, column: k - (source.lastIndexOf('\n', k - 1) + 1) },
  };
}

/** Table and function references of one PL/pgSQL `sql_expression`. */
function expressionRefs(expr: SyntaxNode, source: string, locals: ReadonlySet<string>, out: BodyRef[]): void {
  const pg = getParser('postgres');
  if (!pg) return;
  const isStatement = expr.parent?.type === 'stmt_execsql' || STATEMENT_START.test(expr.text);
  const overlays = intoTargets(source, expr.startIndex, expr.endIndex);
  let range: Range = { startIndex: expr.startIndex, endIndex: expr.endIndex, startPosition: expr.startPosition, endPosition: expr.endPosition };
  if (!isStatement) {
    const prefix = selectPrefix(source, expr.startIndex, expr.startPosition);
    if (!prefix) return;
    overlays.unshift(prefix.overlay);
    range = { ...range, startIndex: prefix.overlay.start, startPosition: prefix.start };
  }
  const root = parseRange(pg, source, range, overlays);
  if (!root) return;
  try {
    if (!root.hasError) sqlTreeRefs(root, locals, out);
  } finally {
    root.tree.delete();
  }
}

/** Expressions whose SQL text is not known until run time. */
const isDynamic = (expr: SyntaxNode): boolean =>
  expr.parent?.children.some((c) => c?.type === 'kw_execute') ?? false;

/** An assignment's first expression is its target variable. */
const isAssignTarget = (expr: SyntaxNode): boolean =>
  expr.parent?.type === 'stmt_assign' && expr.parent.namedChildren.find((c) => c?.type === 'sql_expression')?.startIndex === expr.startIndex;

function plpgsqlRefs(source: string, range: Range, params: ReadonlySet<string>): BodyRef[] {
  const pl = getParser('plpgsql');
  if (!pl) return [];
  const root = parseRange(pl, source, range);
  if (!root) return [];
  try {
    const locals = new Set(params);
    locals.add('new').add('old');
    collectText(root, 'decl_varname', locals);
    collectText(root, 'for_variable', locals);
    const out: BodyRef[] = [];
    const visit = (n: SyntaxNode): void => {
      for (const c of n.namedChildren) {
        if (!c) continue;
        if (c.type !== 'sql_expression') visit(c);
        else if (!isDynamic(c) && !isAssignTarget(c)) expressionRefs(c, source, locals, out);
      }
    };
    visit(root);
    return out;
  } finally {
    root.tree.delete();
  }
}

/** The inside of a `$tag$...$tag$` or plain `'...'` string constant. */
function bodyRange(sconst: SyntaxNode | null): Range | null {
  const str = sconst?.namedChildren[0];
  if (!str) return null;
  const text = str.text;
  let open = 0;
  if (str.type === 'dollar_quoted_string') {
    const tag = /^\$[^$]*\$/.exec(text)?.[0];
    if (!tag || !text.endsWith(tag) || text.length < tag.length * 2) return null;
    open = tag.length;
  } else if (str.type === 'string_literal' && text.startsWith("'") && !text.slice(1, -1).includes("'")) {
    open = 1;
  } else {
    return null;
  }
  const endRow = str.endPosition.row;
  const lastLineStart = text.lastIndexOf('\n') + 1;
  return {
    startIndex: str.startIndex + open,
    endIndex: str.endIndex - open,
    startPosition: { row: str.startPosition.row, column: str.startPosition.column + open },
    endPosition: {
      row: endRow,
      column: lastLineStart === 0 ? str.endPosition.column - open : text.length - open - lastLineStart,
    },
  };
}

function sqlRefs(source: string, range: Range, params: ReadonlySet<string>): BodyRef[] {
  const pg = getParser('postgres');
  if (!pg) return [];
  const root = parseRange(pg, source, range);
  if (!root) return [];
  try {
    const out: BodyRef[] = [];
    for (const stmt of root.namedChildren) {
      if (stmt && !stmt.hasError) sqlTreeRefs(stmt, params, out);
    }
    return out;
  } finally {
    root.tree.delete();
  }
}

/** References made by a CREATE FUNCTION / PROCEDURE body in `language`. */
export function routineBodyRefs(stmt: SyntaxNode, source: string, language: string | null): BodyRef[] {
  const params = collectText(stmt.namedChildren.find((c) => c?.type === 'func_args_with_defaults') ?? stmt, 'param_name', new Set());
  const atomic = stmt.descendantsOfType('opt_routine_body')[0];
  if (atomic) return sqlTreeRefs(atomic, params);
  const funcAs = stmt.descendantsOfType('func_as')[0];
  const range = funcAs ? bodyRange(funcAs.namedChildren.find((c) => c?.type === 'Sconst') ?? null) : null;
  if (!range) return [];
  if (language === 'plpgsql') return plpgsqlRefs(source, range, params);
  if (language === 'sql') return sqlRefs(source, range, params);
  return [];
}

/** References made by a DO block, whose language defaults to plpgsql. */
export function doBlockRefs(stmt: SyntaxNode, source: string): BodyRef[] {
  let range: Range | null = null;
  let language = 'plpgsql';
  for (const item of stmt.descendantsOfType('dostmt_opt_item')) {
    const sconst = item?.namedChildren.find((c) => c?.type === 'Sconst');
    if (sconst) range = bodyRange(sconst);
    else if (item) language = item.text.replace(/^language\s+/i, '').replace(/'/g, '').trim().toLowerCase();
  }
  return range && language === 'plpgsql' ? plpgsqlRefs(source, range, new Set()) : [];
}
