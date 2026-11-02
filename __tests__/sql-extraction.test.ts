import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { getParser, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { foldObjectName, splitIdentifierPath } from '../src/extraction/languages/postgres-names';
import { preParsePostgres } from '../src/extraction/languages/postgres-preparse';

const FIXTURE = path.join(__dirname, 'fixtures', 'postgres');

function symbols(filePath: string, source: string): string[] {
  return extractFromSource(filePath, source, 'postgres')
    .nodes.filter((n) => n.kind !== 'file')
    .map((n) => `${n.kind} ${n.qualifiedName} :${n.startLine}`);
}

function fixtureSymbols(file: string): string[] {
  return symbols(`migrations/${file}`, fs.readFileSync(path.join(FIXTURE, 'migrations', file), 'utf8'));
}

describe('PostgreSQL schema extraction', () => {
  beforeAll(async () => {
    await loadGrammarsForLanguages(['postgres']);
  });

  it('extracts every object kind in the shop schema with its folded qualified name and line', () => {
    expect(fixtureSymbols('001_schema.sql')).toEqual([
      'module pgcrypto :2',
      'namespace app :4',
      'enum public::order_status :6',
      'enum_member public::order_status::pending :6',
      'enum_member public::order_status::paid :6',
      'enum_member public::order_status::shipped :6',
      'enum_member public::order_status::cancelled :6',
      'struct app::address :8',
      'field app::address::street :9',
      'field app::address::city :10',
      'field app::address::postal_code :11',
      'type_alias public::email :14',
      'variable app::invoice_number_seq :17',
      'class public::customers :19',
      'field public::customers::id :20',
      'field public::customers::email :21',
      'field public::customers::shipping_address :22',
      'field public::customers::created_at :23',
      'class public::orders :26',
      'field public::orders::id :27',
      'field public::orders::customer_id :28',
      'field public::orders::status :29',
      'field public::orders::total_cents :30',
      'field public::orders::updated_at :31',
      'class app::products :34',
      'field app::products::sku :35',
      'field app::products::name :36',
      'field app::products::price_cents :37',
      'class app::order_items :40',
      'field app::order_items::order_id :41',
      'field app::order_items::sku :42',
      'field app::order_items::quantity :43',
      'property public::orders::orders_customer_idx :48',
      'property public::orders::orders_owner :52',
    ]);
  });

  it('extracts functions, a procedure, and a trigger owned by a table in another file', () => {
    expect(fixtureSymbols('002_functions.sql')).toEqual([
      'function public::touch_updated_at :1',
      'method public::orders::orders_touch :9',
      'function public::customer_total :13',
      'function app::create_order :18',
      'function app::cancel_order :30',
    ]);
  });

  it('extracts a view, a materialized view, an inheriting table, and an ALTER TABLE constraint', () => {
    expect(fixtureSymbols('003_views.sql')).toEqual([
      'class app::open_orders :1',
      'class app::customer_revenue :7',
      'class app::archived_orders :12',
      'field app::archived_orders::archived_at :13',
      'property app::order_items::order_items_sku_fk :17',
    ]);
  });

  it('records the object type in each signature and the language of a function', () => {
    const source = fs.readFileSync(path.join(FIXTURE, 'migrations', '002_functions.sql'), 'utf8');
    const signatures = extractFromSource('migrations/002_functions.sql', source, 'postgres')
      .nodes.filter((n) => n.kind !== 'file')
      .map((n) => n.signature);
    expect(signatures).toEqual([
      'function: CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger LANGUAGE plpgsql',
      'trigger: CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE',
      'function: CREATE FUNCTION customer_total(p_customer uuid) RETURNS bigint LANGUAGE sql',
      'function: CREATE FUNCTION app.create_order(p_customer uuid, p_total integer) RETURNS bigint LANGUAGE plpgsql',
      'procedure: CREATE PROCEDURE app.cancel_order(p_order bigint) LANGUAGE sql',
    ]);
  });

  it('nests a trigger, index, and policy under a table declared in the same file', () => {
    const result = extractFromSource(
      'm.sql',
      [
        'CREATE TABLE t (id int);',
        'CREATE INDEX t_idx ON t (id);',
        'CREATE POLICY t_pol ON t USING (true);',
        'CREATE TRIGGER t_trg AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();',
      ].join('\n'),
      'postgres'
    );
    const byId = new Map(result.nodes.map((n) => [n.id, n.qualifiedName]));
    const contains = result.edges
      .filter((e) => e.kind === 'contains')
      .map((e) => `${byId.get(e.source)} > ${byId.get(e.target)}`);
    expect(contains).toEqual([
      'm.sql > public::t',
      'public::t > public::t::id',
      'public::t > public::t::t_idx',
      'public::t > public::t::t_pol',
      'public::t > public::t::t_trg',
    ]);
    expect(result.unresolvedReferences.map((r) => `${byId.get(r.fromNodeId)} ${r.referenceKind} ${r.referenceName}`)).toEqual([
      'public::t::t_trg calls public::f',
    ]);
  });

  it('attaches ALTER TABLE ADD COLUMN and an unnamed foreign key to a table in another file', () => {
    const result = extractFromSource(
      'm2.sql',
      'ALTER TABLE "Booking" ADD COLUMN "location" TEXT, ADD FOREIGN KEY ("userId") REFERENCES "users"("id");',
      'postgres'
    );
    const byId = new Map(result.nodes.map((n) => [n.id, n.qualifiedName]));
    expect(result.nodes.map((n) => `${n.kind} ${n.qualifiedName}`)).toEqual([
      'file m2.sql',
      'field public::Booking::location',
      'property public::Booking::Booking_userId_fkey',
    ]);
    expect(result.unresolvedReferences.map((r) => `${byId.get(r.fromNodeId)} ${r.referenceKind} ${r.referenceName}`)).toEqual([
      'public::Booking::location references public::Booking',
      'public::Booking::Booking_userId_fkey references public::users',
      'public::Booking::Booking_userId_fkey references public::Booking',
    ]);
  });

  it('skips statements the grammar cannot parse instead of reading garbage from them', () => {
    const mysqlAndSqlite = [
      'CREATE TABLE `posts` (`id` int(11) NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
      'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);',
      'PRAGMA foreign_keys = ON;',
      'CREATE TABLE kept (id int);',
    ].join('\n');
    expect(symbols('other.sql', mysqlAndSqlite)).toEqual(['class public::kept :4', 'field public::kept::id :4']);
  });

  it('folds unquoted names to lower case and keeps quoted names as written', () => {
    expect(symbols('fold.sql', 'CREATE TABLE Orders (Id int);\nCREATE TABLE "Orders" ("Id" int);\nCREATE TABLE App."Line Items" (q int);')).toEqual([
      'class public::orders :1',
      'field public::orders::id :1',
      'class public::Orders :2',
      'field public::Orders::Id :2',
      'class app::Line Items :3',
      'field app::Line Items::q :3',
    ]);
  });

  it('splits identifier paths with quotes, escaped quotes, and comments', () => {
    expect(splitIdentifierPath('App."Line ""A"" Items"')).toEqual(['app', 'Line "A" Items']);
    expect(splitIdentifierPath('db . Sch /* c */ . "T"')).toEqual(['db', 'sch', 'T']);
    expect(foldObjectName('db.sch.t')).toEqual({ schema: 'sch', name: 't' });
    expect(foldObjectName('T')).toEqual({ schema: 'public', name: 't' });
  });
});

describe('psql preparse', () => {
  beforeAll(async () => {
    await loadGrammarsForLanguages(['postgres']);
  });

  const script = [
    '\\set ON_ERROR_STOP 1',
    "LOAD :'regresslib';",
    'CREATE TABLE :"schema".t (a int, b text);',
    'COPY t (a, b) FROM stdin;',
    '1\tone',
    '2\ttwo: :x \\N',
    '\\.',
    "SELECT a::text, ':not_a_var' FROM t WHERE a = :lim;",
    'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN x := 1; RETURN :y; END $$;',
  ].join('\n');

  it('blanks meta-commands, COPY data, and interpolation colons, keeping every offset', () => {
    const out = preParsePostgres(script);
    expect(out.length).toBe(script.length);
    expect(out.split('\n')).toEqual([
      '                    ',
      "LOAD  'regresslib';",
      'CREATE TABLE  "schema".t (a int, b text);',
      'COPY t (a, b) FROM stdin;',
      '     ',
      '            ',
      '  ',
      "SELECT a::text, ':not_a_var' FROM t WHERE a =  lim;",
      'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN x := 1; RETURN :y; END $$;',
    ]);
  });

  it('parses the preparsed script with no error node and keeps line numbers', () => {
    const tree = getParser('postgres')!.parse(preParsePostgres(script))!;
    expect(tree.rootNode.hasError).toBe(false);
    expect(symbols('s.sql', script).filter((s) => s.startsWith('class') || s.startsWith('function'))).toEqual([
      'class schema::t :3',
      'function public::f :9',
    ]);
  });

  it('returns plain SQL unchanged', () => {
    const plain = 'SELECT a::int FROM t;\n';
    expect(preParsePostgres(plain)).toBe(plain);
  });

  it('keeps an array slice with named bounds, which is no psql variable', () => {
    const source = 'CREATE VIEW recent_tags AS SELECT tags[lo:hi], tags[:hi], tags[lo:] FROM posts;\n';
    expect(preParsePostgres(source)).toBe(source);
    expect(symbols('v.sql', source)).toEqual(['class public::recent_tags :1']);
  });
});

describe('indexing the shop schema', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-extraction-'));
    fs.cpSync(FIXTURE, dir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves foreign keys, view reads, trigger calls, column types, and inheritance across files', async () => {
    const cg = await CodeGraph.init(dir, { silent: true });
    try {
      await cg.indexAll();
      const rows = (cg as any).db.db
        .prepare(
          `SELECT e.kind AS kind, s.qualified_name AS source, t.qualified_name AS target
             FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
            WHERE e.kind != 'contains'`
        )
        .all()
        .map((r: { kind: string; source: string; target: string }) => `${r.source} ${r.kind} ${r.target}`)
        .sort();
      expect(rows).toEqual([
        'app::archived_orders extends public::orders',
        'app::cancel_order calls public::touch_updated_at',
        'app::cancel_order references public::orders',
        'app::create_order calls public::customer_total',
        'app::create_order references public::orders',
        'app::customer_revenue references public::orders',
        'app::open_orders references public::customers',
        'app::open_orders references public::orders',
        'app::order_items references public::orders',
        'app::order_items::order_items_sku_fk references app::order_items',
        'app::order_items::order_items_sku_fk references app::products',
        'public::customer_total references public::orders',
        'public::customers::email type_of public::email',
        'public::customers::shipping_address type_of app::address',
        'public::orders references public::customers',
        'public::orders::orders_touch calls public::touch_updated_at',
        'public::orders::orders_touch references public::orders',
        'public::orders::status type_of public::order_status',
      ]);
    } finally {
      cg.destroy();
    }
  });
});
