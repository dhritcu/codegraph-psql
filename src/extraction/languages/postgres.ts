/**
 * PostgreSQL schema extraction.
 *
 * Each top-level statement the grammar recognizes is read into one `SqlDecl`
 * by the reader its node type maps to in `READERS`; `emit` turns a decl into
 * nodes and unresolved references the same way for every statement. Adding a
 * statement is one reader, not a new branch in the walk.
 *
 * Object kinds, with the object type in each signature:
 *   schema → namespace, extension → module,
 *   table / view / materialized view → class, column → field,
 *   function / procedure → function, trigger → method in its table,
 *   enum → enum (values → enum_member), composite type → struct,
 *   domain → type_alias, sequence → variable,
 *   index / policy / constraint → property in its table.
 *
 * An object owned by a table (trigger, index, policy, a constraint or column
 * added by ALTER TABLE) nests under the table when this file declares it,
 * and otherwise stands alone at the top level under the qualified name
 * `schema::table::name`, with a `references` edge to the table.
 *
 * A function's signature records its language. What a PL/pgSQL or SQL body
 * (or a DO block) reads, writes, and calls is read by `postgres-bodies.ts`.
 */

import type { Node as SyntaxNode, Point } from 'web-tree-sitter';
import type { EdgeKind, Node, NodeKind } from '../../types';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';
import { doBlockRefs, routineBodyRefs, SQL_OP_CANDIDATE, type SqlOp } from './postgres-bodies';
import { foldObjectName, objectFromParts, qualify, splitIdentifierPath, type SqlName } from './postgres-names';
import { preParsePostgres } from './postgres-preparse';

type SqlObjectType =
  | 'schema' | 'extension' | 'table' | 'view' | 'materialized view'
  | 'function' | 'procedure' | 'trigger' | 'enum' | 'composite type'
  | 'domain' | 'sequence' | 'index' | 'policy' | 'constraint' | 'column';

const KIND: Record<SqlObjectType, NodeKind> = {
  schema: 'namespace',
  extension: 'module',
  table: 'class',
  view: 'class',
  'materialized view': 'class',
  function: 'function',
  procedure: 'function',
  trigger: 'method',
  enum: 'enum',
  'composite type': 'struct',
  domain: 'type_alias',
  sequence: 'variable',
  index: 'property',
  policy: 'property',
  constraint: 'property',
  column: 'field',
};

interface SqlRef {
  target: SqlName;
  kind: EdgeKind;
  op?: SqlOp;
  at: { startPosition: Point };
}

interface SqlMember {
  kind: 'field' | 'enum_member';
  name: string;
  at: SyntaxNode;
  signature: string;
  refs: SqlRef[];
}

/**
 * One statement's contribution. `name` is null for a statement that only
 * adds members or references to a table (`ALTER TABLE ... ADD COLUMN`, an
 * unnamed `ADD FOREIGN KEY`): those attach to `owner`.
 */
interface SqlDecl {
  objectType: SqlObjectType;
  name: SqlName | null;
  owner?: SqlName;
  at: SyntaxNode;
  signature: string;
  members: SqlMember[];
  refs: SqlRef[];
}

type Reader = (stmt: SyntaxNode, source: string) => SqlDecl[];

const child = (n: SyntaxNode, type: string): SyntaxNode | null =>
  n.namedChildren.find((c) => c?.type === type) ?? null;
const children = (n: SyntaxNode, type: string): SyntaxNode[] =>
  n.namedChildren.filter((c): c is SyntaxNode => c?.type === type);
const hasKeyword = (n: SyntaxNode, kw: string): boolean => n.children.some((c) => c?.type === kw);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Flatten a left-recursive list rule (`TableElementList`, `enum_val_list`) into its items. */
function flatten(list: SyntaxNode | null, itemType: string): SyntaxNode[] {
  if (!list) return [];
  const out: SyntaxNode[] = [];
  for (const c of list.namedChildren) {
    if (!c) continue;
    if (c.type === list.type) out.push(...flatten(c, itemType));
    else if (c.type === itemType) out.push(c);
  }
  return out;
}

function descendants(n: SyntaxNode, type: string, out: SyntaxNode[] = []): SyntaxNode[] {
  for (const c of n.namedChildren) {
    if (!c) continue;
    if (c.type === type) out.push(c);
    descendants(c, type, out);
  }
  return out;
}

const nameOf = (n: SyntaxNode | null): SqlName | null => (n ? foldObjectName(n.text) : null);

/** A relation_expr (`ONLY app.t`, `t *`) names its table through a qualified_name. */
function relationName(n: SyntaxNode | null): SqlName | null {
  if (!n) return null;
  if (n.type === 'qualified_name') return nameOf(n);
  return nameOf(descendants(n, 'qualified_name')[0] ?? null);
}

/** Types every database has; a column of one of these refers to nothing in the project. */
const BUILTIN_TYPES = new Set([
  'text', 'uuid', 'json', 'jsonb', 'bytea', 'date', 'time', 'timetz', 'timestamp', 'timestamptz',
  'interval', 'bool', 'boolean', 'int2', 'int4', 'int8', 'float4', 'float8', 'serial', 'bigserial',
  'smallserial', 'serial4', 'serial8', 'money', 'inet', 'cidr', 'macaddr', 'xml', 'tsvector',
  'tsquery', 'citext', 'oid', 'regclass', 'name', 'void', 'trigger', 'record', 'jsonpath',
  'point', 'line', 'box', 'circle', 'polygon', 'path', 'lseg', 'int4range', 'int8range',
  'numrange', 'tsrange', 'tstzrange', 'daterange', 'hstore', 'vector', 'geometry', 'geography',
]);

/** A column or attribute type naming a user type (`app.address`, `order_status`) → type_of. */
function typeRef(typename: SyntaxNode | null): SqlRef[] {
  const generic = typename ? child(child(typename, 'SimpleTypename') ?? typename, 'GenericType') : null;
  const fn = generic ? child(generic, 'type_function_name') : null;
  if (!generic || !fn) return [];
  const parts = splitIdentifierPath(fn.text + (child(generic, 'attrs')?.text ?? ''));
  if (parts.length === 1 && BUILTIN_TYPES.has(parts[0]!)) return [];
  const target = objectFromParts(parts);
  return target ? [{ target, kind: 'type_of', at: typename! }] : [];
}

/** A FOREIGN KEY or column REFERENCES clause → its target table. */
function foreignKeyRefs(constraint: SyntaxNode): SqlRef[] {
  if (!hasKeyword(constraint, 'kw_references')) return [];
  const target = nameOf(child(constraint, 'qualified_name'));
  return target ? [{ target, kind: 'references', at: constraint }] : [];
}

function readColumn(def: SyntaxNode, refsToOwner: SqlRef[]): SqlMember | null {
  const id = child(def, 'ColId');
  if (!id) return null;
  const name = splitIdentifierPath(id.text)[0];
  if (!name) return null;
  const typename = child(def, 'Typename');
  for (const elem of descendants(def, 'ColConstraintElem')) refsToOwner.push(...foreignKeyRefs(elem));
  return {
    kind: 'field',
    name,
    at: def,
    signature: oneLine(`${id.text} ${typename?.text ?? ''}`),
    refs: typeRef(typename),
  };
}

/** Columns and table constraints of a CREATE TABLE element list. */
function readTableElements(list: SyntaxNode | null, refs: SqlRef[]): SqlMember[] {
  const members: SqlMember[] = [];
  for (const el of flatten(list, 'TableElement')) {
    const def = child(el, 'columnDef');
    if (def) {
      const col = readColumn(def, refs);
      if (col) members.push(col);
    }
    const tc = child(el, 'TableConstraint');
    const elem = tc && child(tc, 'ConstraintElem');
    if (elem) refs.push(...foreignKeyRefs(elem));
  }
  return members;
}

function decl(objectType: SqlObjectType, at: SyntaxNode, name: SqlName | null, extra: Partial<SqlDecl> = {}): SqlDecl {
  return { objectType, at, name, signature: '', members: [], refs: [], ...extra };
}

const signatureOf = (objectType: string, stmt: SyntaxNode, upTo?: SyntaxNode | null): string => {
  const text = upTo ? stmt.text.slice(0, upTo.startIndex - stmt.startIndex) : stmt.text;
  return `${objectType}: ${oneLine(text).replace(/\s*\($/, '').slice(0, 200)}`;
};

function readFunctionLanguage(stmt: SyntaxNode): string | null {
  for (const item of descendants(stmt, 'createfunc_opt_item')) {
    if (hasKeyword(item, 'kw_language')) return oneLine(child(item, 'NonReservedWord_or_Sconst')?.text ?? '').replace(/'/g, '').toLowerCase();
  }
  return null;
}

const READERS: Record<string, Reader> = {
  CreateSchemaStmt: (stmt) => {
    const id = child(stmt, 'ColId');
    const name = id && splitIdentifierPath(id.text)[0];
    return name ? [decl('schema', stmt, { schema: name, name }, { signature: `schema ${name}` })] : [];
  },

  CreateExtensionStmt: (stmt) => {
    const name = nameOf(child(stmt, 'name'));
    return name ? [decl('extension', stmt, name, { signature: `extension ${name.name}` })] : [];
  },

  CreateStmt: (stmt) => {
    const [own, parent] = children(stmt, 'qualified_name');
    const name = nameOf(own ?? null);
    if (!name) return [];
    const refs: SqlRef[] = [];
    const members = readTableElements(child(child(stmt, 'OptTableElementList') ?? stmt, 'TableElementList'), refs);
    const inherit = child(stmt, 'OptInherit');
    for (const q of inherit ? descendants(inherit, 'qualified_name') : []) {
      const target = nameOf(q);
      if (target) refs.push({ target, kind: 'extends', at: q });
    }
    const partitionOf = nameOf(parent ?? null);
    if (partitionOf) refs.push({ target: partitionOf, kind: 'extends', at: parent! });
    const body = child(stmt, 'OptTableElementList');
    return [decl('table', stmt, name, { members, refs, signature: signatureOf('table', stmt, body) })];
  },

  ViewStmt: (stmt) => readView('view', stmt, child(stmt, 'qualified_name')),
  CreateMatViewStmt: (stmt) =>
    readView('materialized view', stmt, child(child(stmt, 'create_mv_target') ?? stmt, 'qualified_name')),

  CreateFunctionStmt: (stmt, source) => {
    const name = nameOf(child(stmt, 'func_name'));
    if (!name) return [];
    const objectType = hasKeyword(stmt, 'kw_procedure') ? 'procedure' : 'function';
    const head = oneLine(stmt.text.slice(0, (child(stmt, 'opt_createfunc_opt_list')?.startIndex ?? stmt.endIndex) - stmt.startIndex));
    const language = readFunctionLanguage(stmt);
    return [decl(objectType, stmt, name, {
      refs: routineBodyRefs(stmt, source, language),
      signature: `${objectType}: ${head}${language ? ` LANGUAGE ${language}` : ''}`,
    })];
  },

  CreateTrigStmt: (stmt) => {
    const id = child(stmt, 'name');
    const owner = relationName(child(stmt, 'qualified_name'));
    const fn = nameOf(child(stmt, 'func_name'));
    const name = id && splitIdentifierPath(id.text)[0];
    if (!name || !owner) return [];
    return [decl('trigger', stmt, { schema: owner.schema, name }, {
      owner,
      refs: fn ? [{ target: fn, kind: 'calls', at: child(stmt, 'func_name')! }] : [],
      signature: signatureOf('trigger', stmt, child(stmt, 'FUNCTION_or_PROCEDURE')),
    })];
  },

  DefineStmt: (stmt) => {
    const name = nameOf(child(stmt, 'any_name'));
    if (!name || !hasKeyword(stmt, 'kw_type')) return [];
    const values = child(stmt, 'opt_enum_val_list');
    if (values || hasKeyword(stmt, 'kw_enum')) {
      const members = flatten(child(values ?? stmt, 'enum_val_list'), 'Sconst').map((s): SqlMember => {
        const value = s.text.replace(/^'|'$/g, '').replace(/''/g, "'");
        return { kind: 'enum_member', name: value, at: s, signature: s.text, refs: [] };
      });
      return [decl('enum', stmt, name, { members, signature: signatureOf('enum', stmt, values) })];
    }
    const attrs = child(stmt, 'OptTableFuncElementList');
    if (!attrs) return [];
    const members = flatten(child(attrs, 'TableFuncElementList'), 'TableFuncElement')
      .map((el) => readColumn(el, []))
      .filter((m): m is SqlMember => m !== null);
    return [decl('composite type', stmt, name, { members, signature: signatureOf('composite type', stmt, attrs) })];
  },

  CreateDomainStmt: (stmt) => {
    const name = nameOf(child(stmt, 'any_name'));
    if (!name) return [];
    const typename = child(stmt, 'Typename');
    return [decl('domain', stmt, name, {
      refs: typeRef(typename),
      signature: signatureOf('domain', stmt, typename?.nextNamedSibling),
    })];
  },

  CreateSeqStmt: (stmt) => {
    const name = nameOf(child(stmt, 'qualified_name'));
    return name ? [decl('sequence', stmt, name, { signature: signatureOf('sequence', stmt) })] : [];
  },

  IndexStmt: (stmt) => {
    const id = child(stmt, 'opt_single_name') ?? child(stmt, 'name');
    const owner = relationName(child(stmt, 'relation_expr'));
    const name = id && splitIdentifierPath(id.text)[0];
    if (!name || !owner) return [];
    return [decl('index', stmt, { schema: owner.schema, name }, { owner, signature: signatureOf('index', stmt) })];
  },

  CreatePolicyStmt: (stmt) => {
    const id = child(stmt, 'name');
    const owner = relationName(child(stmt, 'qualified_name'));
    const name = id && splitIdentifierPath(id.text)[0];
    if (!name || !owner) return [];
    return [decl('policy', stmt, { schema: owner.schema, name }, {
      owner,
      signature: signatureOf('policy', stmt, child(stmt, 'RowSecurityOptionalExpr')),
    })];
  },

  AlterTableStmt: (stmt) => {
    const owner = relationName(child(stmt, 'relation_expr'));
    if (!owner || !hasKeyword(stmt, 'kw_table')) return [];
    const out: SqlDecl[] = [];
    const columnRefs: SqlRef[] = [];
    const columns: SqlMember[] = [];
    for (const cmd of flatten(child(stmt, 'alter_table_cmds'), 'alter_table_cmd')) {
      const def = child(cmd, 'columnDef');
      if (def && hasKeyword(cmd, 'kw_add')) {
        const col = readColumn(def, columnRefs);
        if (col) columns.push(col);
      }
      const tc = child(cmd, 'TableConstraint');
      const elem = tc && child(tc, 'ConstraintElem');
      const refs = elem ? foreignKeyRefs(elem) : [];
      if (!tc || refs.length === 0) continue;
      const id = child(tc, 'name');
      const name = id && splitIdentifierPath(id.text)[0];
      if (name) {
        out.push(decl('constraint', tc, { schema: owner.schema, name }, {
          owner, refs, signature: `constraint: ${oneLine(tc.text).slice(0, 200)}`,
        }));
      } else {
        columnRefs.push(...refs);
      }
    }
    if (columns.length > 0 || columnRefs.length > 0) {
      out.unshift(decl('column', stmt, null, { owner, members: columns, refs: columnRefs }));
    }
    return out;
  },
};

function readView(objectType: 'view' | 'materialized view', stmt: SyntaxNode, nameNode: SyntaxNode | null): SqlDecl[] {
  const name = nameOf(nameNode);
  const select = child(stmt, 'SelectStmt');
  if (!name) return [];
  const ctes = new Set(
    (select ? descendants(select, 'common_table_expr') : [])
      .map((cte) => splitIdentifierPath(child(cte, 'name')?.text ?? '')[0])
      .filter(Boolean)
  );
  const refs: SqlRef[] = [];
  const seen = new Set<string>();
  for (const rel of select ? descendants(select, 'relation_expr') : []) {
    const q = descendants(rel, 'qualified_name')[0] ?? null;
    const parts = q ? splitIdentifierPath(q.text) : [];
    const target = nameOf(q);
    if (!target || (parts.length === 1 && ctes.has(parts[0]))) continue;
    const key = qualify(target);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ target, kind: 'references', at: q! });
  }
  return [decl(objectType, stmt, name, { refs, signature: signatureOf(objectType, stmt, select) })];
}

/** COMMENT ON TABLE/COLUMN/TYPE ... IS '...' → the docstring of an object this file declares. */
function applyComment(stmt: SyntaxNode, ctx: ExtractorContext): void {
  const target = child(stmt, 'any_name');
  const text = child(stmt, 'comment_text');
  if (!target || !text || text.text.toUpperCase() === 'NULL') return;
  const parts = splitIdentifierPath(target.text);
  const isColumn = hasKeyword(stmt, 'kw_column');
  const object = objectFromParts(isColumn ? parts.slice(0, -1) : parts);
  if (!object) return;
  const qn = isColumn ? qualify(object, parts[parts.length - 1]!) : qualify(object);
  const node = ctx.nodes.find((n) => n.qualifiedName === qn && n.kind !== 'file');
  if (node) node.docstring = text.text.replace(/^'|'$/g, '').replace(/''/g, "'");
}

/** The table this file declares under `owner`, if any. */
function findTable(ctx: ExtractorContext, owner: SqlName): Node | undefined {
  const qn = qualify(owner);
  return ctx.nodes.find((n) => n.kind === 'class' && n.qualifiedName === qn);
}

function addRefs(ctx: ExtractorContext, fromNodeId: string, refs: SqlRef[]): void {
  for (const ref of refs) {
    ctx.addUnresolvedReference({
      fromNodeId,
      referenceName: qualify(ref.target),
      referenceKind: ref.kind,
      line: ref.at.startPosition.row + 1,
      column: ref.at.startPosition.column,
      ...(ref.op ? { candidates: [SQL_OP_CANDIDATE + ref.op] } : {}),
    });
  }
}

function emit(d: SqlDecl, ctx: ExtractorContext): void {
  const ownerNode = d.owner ? findTable(ctx, d.owner) : undefined;
  const ownerRef: SqlRef[] = d.owner && !ownerNode ? [{ target: d.owner, kind: 'references', at: d.at }] : [];
  if (ownerNode) ctx.pushScope(ownerNode.id);
  try {
    let parent: Node | null | undefined = ownerNode;
    let memberBase: SqlName | undefined = d.owner;
    if (d.name) {
      const qualifiedName = d.objectType === 'schema' || d.objectType === 'extension'
        ? d.name.name
        : d.owner ? qualify(d.owner, d.name.name) : qualify(d.name);
      parent = ctx.createNode(KIND[d.objectType], d.name.name, d.at, {
        qualifiedName,
        signature: d.signature,
        isExported: true,
      });
      if (!parent) return;
      addRefs(ctx, parent.id, [...d.refs, ...ownerRef]);
      memberBase = d.name;
    } else if (ownerNode) {
      addRefs(ctx, ownerNode.id, d.refs);
    } else {
      const fileId = ctx.nodeStack[0];
      if (fileId) addRefs(ctx, fileId, d.refs);
    }
    if (!memberBase || d.members.length === 0) return;
    if (parent) ctx.pushScope(parent.id);
    try {
      for (const m of d.members) {
        const member = ctx.createNode(m.kind, m.name, m.at, {
          qualifiedName: qualify(memberBase, m.name),
          signature: m.signature,
          isExported: true,
        });
        if (member) addRefs(ctx, member.id, m.refs);
      }
    } finally {
      if (parent) ctx.popScope();
    }
  } finally {
    if (ownerNode) ctx.popScope();
  }
}

const PASS_THROUGH = new Set(['source_file', 'toplevel_stmt', 'stmt']);

export const postgresExtractor: LanguageExtractor = {
  preParse: (source) => preParsePostgres(source),
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: '',
  bodyField: '',
  paramsField: '',

  visitNode: (node, ctx) => {
    if (PASS_THROUGH.has(node.type)) return false;
    if (node.type === 'CommentStmt') {
      applyComment(node, ctx);
      return true;
    }
    const fileId = ctx.nodeStack[0];
    if (node.type === 'DoStmt' && !node.hasError && fileId) {
      addRefs(ctx, fileId, doBlockRefs(node, ctx.source));
      return true;
    }
    // A statement the grammar could not parse is usually another dialect
    // (MySQL backticks, SQLite AUTOINCREMENT); reading it would mint garbage.
    const read = node.hasError ? undefined : READERS[node.type];
    if (read) for (const d of read(node, ctx.source)) emit(d, ctx);
    return true;
  },
};
