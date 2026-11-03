import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { SYNTH_PASSES } from '../src/resolution/callback-synthesizer';
import { embeddedSqlStats } from '../src/resolution/embedded-sql-synthesizer';

const FIXTURE = path.join(__dirname, 'fixtures', 'postgres-ts');

let dir: string;

function write(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

async function indexed(files: Record<string, string> = {}): Promise<CodeGraph> {
  write(files);
  const cg = await CodeGraph.init(dir, { silent: true });
  await cg.indexAll();
  return cg;
}

/**
 * Every edge this pass makes and every trigger hop out of a TypeScript writer, as
 * `source -kind-> target {op ops columns upsert} client call @line`, sorted.
 */
function dbEdges(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const file of cg.getFiles()) {
    if (file.path.endsWith('.sql')) continue;
    for (const node of cg.getNodesInFile(file.path)) {
      for (const e of cg.getOutgoingEdges(node.id)) {
        const m = (e.metadata ?? {}) as Record<string, unknown>;
        if (m.synthesizedBy !== 'sql-embedded' && m.synthesizedBy !== 'pg-trigger') continue;
        expect(e.provenance).toBe('heuristic');
        const facts = ['op', 'ops', 'columns', 'upsert', 'event']
          .filter((k) => m[k] !== undefined)
          .map((k) => `${k}=${Array.isArray(m[k]) ? (m[k] as string[]).join(',') : String(m[k])}`)
          .join(' ');
        const via = m.synthesizedBy === 'sql-embedded' ? `${String(m.client)} ${String(m.call)}` : `trigger ${String(m.trigger)}`;
        out.push(`${node.name} -${e.kind}-> ${cg.getNode(e.target)!.qualifiedName} {${facts}} ${via} @${e.line}`);
      }
    }
  }
  return out.sort();
}

const SCHEMA = {
  'db/migrations/001_schema.sql':
    'CREATE TABLE orders (id bigint PRIMARY KEY, status text, note text, total int);\n' +
    'CREATE SCHEMA app;\nCREATE TABLE app.audit (id bigint);\n' +
    'CREATE FUNCTION create_order(p_total int) RETURNS bigint LANGUAGE sql AS $$\n  INSERT INTO orders (total) VALUES (p_total) RETURNING id;\n$$;\n',
  'db/migrations/002_triggers.sql':
    'CREATE FUNCTION on_status() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$;\n' +
    'CREATE FUNCTION on_insert() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$;\n' +
    'CREATE TRIGGER orders_status BEFORE UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION on_status();\n' +
    'CREATE TRIGGER orders_insert AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION on_insert();\n',
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sql-embedded-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tagged templates', () => {
  it('links postgres.js, slonik, drizzle and kysely sql templates, holes as parameters', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/db.ts': "import postgres from 'postgres';\nexport const sql = postgres(process.env.DATABASE_URL!);\n",
      'src/postgres.ts': [
        "import { sql } from './db';",
        'export async function add(total: number) {',
        '  await sql`',
        '    INSERT INTO orders (total)',
        '    VALUES (${total})',
        '  `;',
        '}',
        'export async function remove(id: number) {',
        '  await sql.unsafe(`DELETE FROM app.audit WHERE id = ${id}`);',
        '}',
      ].join('\n'),
      'src/slonik.ts': [
        "import { sql } from 'slonik';",
        'export async function list(pool: any) {',
        '  return pool.any(sql.type(Row)`SELECT id FROM orders WHERE status = ${"paid"}`);',
        '}',
      ].join('\n'),
      'src/drizzle.ts': [
        "import { sql } from 'drizzle-orm';",
        'export async function pay(db: any, id: number) {',
        '  await db.execute(sql`UPDATE orders SET status = ${"paid"}, note = NULL WHERE id = ${id}`);',
        '}',
        'export async function annotate(db: any, id: number, note: string) {',
        '  await db.execute(sql`UPDATE orders SET note = ${note} WHERE id = ${id}`);',
        '}',
      ].join('\n'),
      'src/kysely.ts': [
        "import { sql as raw } from 'kysely';",
        'export async function place(db: any, total: number) {',
        '  return raw<{ id: number }>`SELECT create_order(${total}) AS id`.execute(db);',
        '}',
      ].join('\n'),
    });
    try {
      expect(dbEdges(cg)).toEqual([
        'add -calls-> public::on_insert {event=insert} trigger public::orders::orders_insert @4',
        'add -references-> public::orders {op=insert ops=insert} postgres sql tag @4',
        'annotate -references-> public::orders {op=update ops=update columns=note} drizzle sql tag @6',
        'list -references-> public::orders {op=select ops=select} slonik sql tag @3',
        'pay -calls-> public::on_status {event=update} trigger public::orders::orders_status @3',
        'pay -references-> public::orders {op=update ops=update columns=status,note} drizzle sql tag @3',
        'place -calls-> public::create_order {} kysely sql tag @3',
        'remove -references-> app::audit {op=delete ops=delete} postgres .unsafe() @9',
      ]);
    } finally {
      cg.destroy();
    }
  });
});

describe('string arguments', () => {
  it('links node-postgres .query, a pooled client, knex .raw and the Prisma raw forms', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/pool.ts': "import pg from 'pg';\nexport const pool = new pg.Pool();\n",
      'src/pg.ts': [
        "import { pool } from './pool';",
        'export async function report() {',
        "  return pool.query('SELECT o.id FROM orders o JOIN app.audit a ON a.id = o.id', []);",
        '}',
        'export async function settle(id: number) {',
        '  const client = await pool.connect();',
        '  await client.query(`UPDATE orders SET status = ${"paid"} WHERE id = ${id}`);',
        '}',
      ].join('\n'),
      'src/knex.ts': [
        "const knex = require('knex')({ client: 'pg' });",
        'export async function wipe() {',
        "  await knex.raw('DELETE FROM orders WHERE total = ?', [0]);",
        '}',
      ].join('\n'),
      'src/prisma.ts': [
        "import { Prisma } from '@prisma/client';",
        'export class OrderRepository {',
        '  constructor(private prisma: any) {}',
        '  async count() {',
        '    return this.prisma.$queryRaw<{ n: number }[]>`SELECT count(*) AS n FROM "orders"`;',
        '  }',
        '  async save(id: number, status: string) {',
        '    await this.prisma.$executeRaw(Prisma.sql`',
        '      INSERT INTO orders (id, status) VALUES (${id}, ${status})',
        '      ON CONFLICT (id) DO UPDATE SET status = excluded.status',
        '    `);',
        '  }',
        '  async archive(tx: any) {',
        "    await tx.$executeRawUnsafe('DELETE FROM app.audit');",
        '  }',
        '}',
      ].join('\n'),
    });
    try {
      expect(dbEdges(cg)).toEqual([
        'archive -references-> app::audit {op=delete ops=delete} prisma .$executeRawUnsafe() @14',
        'count -references-> public::orders {op=select ops=select} prisma .$queryRaw tag @5',
        'report -references-> app::audit {op=select ops=select} pg .query() @3',
        'report -references-> public::orders {op=select ops=select} pg .query() @3',
        'save -calls-> public::on_insert {event=insert} trigger public::orders::orders_insert @9',
        'save -calls-> public::on_status {event=update} trigger public::orders::orders_status @9',
        'save -references-> public::orders {op=insert ops=insert,update columns=status upsert=true} prisma .$executeRaw() @9',
        'settle -calls-> public::on_status {event=update} trigger public::orders::orders_status @7',
        'settle -references-> public::orders {op=update ops=update columns=status} pg .query() @7',
        'wipe -references-> public::orders {op=delete ops=delete} knex .raw() @3',
      ]);
    } finally {
      cg.destroy();
    }
  });
});

describe('what makes no edge', () => {
  it('skips a syntax error, a concatenation, a non-literal, a hole naming a table, and an unproven receiver', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/pool.ts': "import { Pool } from 'pg';\nexport const pool = new Pool();\n",
      'src/db.ts': "import postgres from 'postgres';\nexport const sql = postgres();\n",
      'src/bad.ts': [
        "import { pool } from './pool';",
        "import { sql } from './db';",
        'export async function typo() {',
        '  await sql`SELEC * FRM orders`;',
        '}',
        'export async function concat(id: number) {',
        "  await pool.query('DELETE FROM orders WHERE id = ' + id);",
        '}',
        'export async function variable(text: string) {',
        '  await pool.query(text);',
        '}',
        'export async function dynamic(table: string) {',
        '  await sql`DELETE FROM ${sql(table)}`;',
        '}',
      ].join('\n'),
      'src/unproven.ts': [
        "import { db } from './somewhere';",
        'const sql = (s: TemplateStringsArray) => s;',
        'export async function guess() {',
        "  await db.query('DELETE FROM orders');",
        '  sql`DELETE FROM orders`;',
        "  await db.$queryRawUnsafe('DELETE FROM orders');",
        '}',
      ].join('\n'),
    });
    try {
      expect(dbEdges(cg)).toEqual([]);
      expect(embeddedSqlStats).toEqual({ files: 4, candidates: 2, parsed: 0, edges: 0, grammarLoaded: true });
    } finally {
      cg.destroy();
    }
  });

  it('does not load the postgres grammar when no literal is a candidate', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/api.ts': "import { db } from './db';\nexport async function list() {\n  return db.query('SELECT * FROM orders');\n}\n",
    });
    try {
      expect(dbEdges(cg)).toEqual([]);
      expect(embeddedSqlStats).toEqual({ files: 1, candidates: 0, parsed: 0, edges: 0, grammarLoaded: false });
    } finally {
      cg.destroy();
    }
  });

  it('is gated out of a project with no postgres files', () => {
    const pass = SYNTH_PASSES.find((p) => p.name === 'embeddedSqlEdges')!;
    expect(pass.gate((...langs) => langs.includes('typescript'))).toBe(false);
    expect(pass.gate((...langs) => langs.some((l) => l === 'typescript' || l === 'postgres'))).toBe(true);
  });
});

describe('the postgres-ts fixture', () => {
  async function flowOf(cg: CodeGraph, query: string): Promise<string> {
    const text = (await new ToolHandler(cg).execute('codegraph_explore', { query })).content[0]!.text;
    const start = text.indexOf('**Flow');
    if (start < 0) return '';
    return text.slice(start, text.indexOf('\n\n', text.indexOf('1. ', start)));
  }

  it('lists the handler among the callers of orders with op insert, and runs through to the trigger', async () => {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const cg = await indexed();
    try {
      const orders = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'public::orders')!;
      const writers = cg.getIncomingEdges(orders.id)
        .filter((e) => (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'sql-embedded')
        .map((e) => `${cg.getNode(e.source)!.name} ${String((e.metadata as Record<string, unknown>).op)}`)
        .sort();
      expect(writers).toEqual(['customerOrdersHandler select', 'markPaidHandler update', 'placeOrderHandler insert']);
      expect(await flowOf(cg, 'placeOrderHandler orders log_order_insert')).toBe([
        '**Flow (call path among the symbols you queried)**',
        '',
        '1. placeOrderHandler (api/checkout.ts:4)',
        '   ↓ dynamic: postgres sql tag `INSERT INTO orders (customer_id, total_cents) VALUES ($1, $2) RETURNING id` @supabase/migrations/001_schema.sql:26',
        '2. orders (supabase/migrations/001_schema.sql:26)',
        '   ↓ dynamic: trigger `orders_audit` AFTER INSERT ON `orders` @supabase/migrations/004_audit.sql:16',
        '3. log_order_insert (supabase/migrations/004_audit.sql:8)',
      ].join('\n'));
    } finally {
      cg.destroy();
    }
  });
});
