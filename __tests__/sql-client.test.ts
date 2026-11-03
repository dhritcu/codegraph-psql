import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { SYNTH_PASSES } from '../src/resolution/callback-synthesizer';

const FIXTURE = path.join(__dirname, 'fixtures', 'postgres-ts');
const BIN = path.join(__dirname, '..', 'dist', 'bin', 'codegraph.js');

let dir: string;

function write(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

async function tool(cg: CodeGraph, name: string, args: Record<string, unknown>): Promise<string> {
  return (await new ToolHandler(cg).execute(name, args)).content[0]!.text;
}

async function indexed(files: Record<string, string> = {}): Promise<CodeGraph> {
  write(files);
  const cg = await CodeGraph.init(dir, { silent: true });
  await cg.indexAll();
  return cg;
}

/**
 * Every edge this pass makes and every trigger hop out of a TypeScript writer, as
 * `source -kind-> target {op ops columns upsert} call @line`, sorted.
 */
function dbEdges(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const file of cg.getFiles()) {
    if (file.path.endsWith('.sql')) continue;
    for (const node of cg.getNodesInFile(file.path)) {
      for (const e of cg.getOutgoingEdges(node.id)) {
        const m = (e.metadata ?? {}) as Record<string, unknown>;
        if (m.synthesizedBy !== 'sql-client' && m.synthesizedBy !== 'pg-trigger') continue;
        expect(e.provenance).toBe('heuristic');
        const facts = ['op', 'ops', 'columns', 'upsert', 'event']
          .filter((k) => m[k] !== undefined)
          .map((k) => `${k}=${Array.isArray(m[k]) ? (m[k] as string[]).join(',') : String(m[k])}`)
          .join(' ');
        const via = m.synthesizedBy === 'sql-client' ? `${String(m.client)} ${String(m.call)}` : `trigger ${String(m.trigger)}`;
        out.push(`${node.name} -${e.kind}-> ${cg.getNode(e.target)!.qualifiedName} {${facts}} ${via} @${e.line}`);
      }
    }
  }
  return out.sort();
}

const SCHEMA = {
  'supabase/migrations/001_schema.sql':
    'CREATE TABLE orders (id bigint, status text, note text, total int);\n' +
    'CREATE SCHEMA app;\nCREATE TABLE app.audit (id bigint);\n' +
    'CREATE FUNCTION create_order(p_total int) RETURNS bigint LANGUAGE sql AS $$\n  INSERT INTO orders (total) VALUES (p_total) RETURNING id;\n$$;\n',
  'supabase/migrations/002_triggers.sql':
    'CREATE FUNCTION on_status() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$;\n' +
    'CREATE FUNCTION on_insert() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$;\n' +
    'CREATE TRIGGER orders_status BEFORE UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION on_status();\n' +
    'CREATE TRIGGER orders_insert AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION on_insert();\n',
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sql-client-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Supabase client calls', () => {
  it('links each .from op and .rpc through a client imported from the module that creates it', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/lib/supabase.ts':
        "import { createClient } from '@supabase/supabase-js';\n" +
        'export const supabase = createClient(URL, KEY);\n',
      'src/api/orders.ts': [
        "import { supabase } from '../lib/supabase';",
        'export async function pay(id: number) {',
        "  await supabase.from('orders').update({ status: 'paid', note: null }).eq('id', id);",
        '}',
        'export async function annotate(id: number, note: string) {',
        "  await supabase.from('orders').update({ note }).eq('id', id);",
        '}',
        'export async function list() {',
        "  return supabase.from('orders').select('*');",
        '}',
        'export async function add(total: number) {',
        "  await supabase.from('orders').insert({ total }).select();",
        '}',
        'export async function save(row: { id: number; status: string }) {',
        "  await supabase.from('orders').upsert({ id: row.id, status: row.status });",
        '}',
        'export async function purge() {',
        "  await supabase.schema('app').from('audit').delete().neq('id', 0);",
        '}',
        'export async function place(total: number) {',
        "  return supabase.rpc('create_order', { p_total: total });",
        '}',
      ].join('\n'),
    });
    try {
      expect(dbEdges(cg)).toEqual([
        "add -calls-> public::on_insert {event=insert} trigger public::orders::orders_insert @12",
        "add -references-> public::orders {op=insert ops=insert} supabase .from('orders').insert @12",
        "annotate -references-> public::orders {op=update ops=update columns=note} supabase .from('orders').update @6",
        "list -references-> public::orders {op=select ops=select} supabase .from('orders').select @9",
        "pay -calls-> public::on_status {event=update} trigger public::orders::orders_status @3",
        "pay -references-> public::orders {op=update ops=update columns=status,note} supabase .from('orders').update @3",
        "place -calls-> public::create_order {} supabase .rpc('create_order') @21",
        "purge -references-> app::audit {op=delete ops=delete} supabase .schema('app').from('audit').delete @18",
        "save -calls-> public::on_insert {event=insert} trigger public::orders::orders_insert @15",
        "save -calls-> public::on_status {event=update} trigger public::orders::orders_status @15",
        "save -references-> public::orders {op=insert ops=insert,update columns=id,status upsert=true} supabase .from('orders').upsert @15",
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('follows a factory function from @supabase/ssr and the client options schema', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/utils/server.ts':
        "import { createServerClient } from '@supabase/ssr';\n" +
        'export async function createClient() {\n' +
        "  return createServerClient(URL, KEY, { db: { schema: 'app' } });\n" +
        '}\n',
      'src/page.ts':
        "import { createClient } from './utils/server';\n" +
        'export async function Page() {\n' +
        '  const supabase = await createClient();\n' +
        "  return supabase.from('audit').select();\n" +
        '}\n',
    });
    try {
      expect(dbEdges(cg)).toEqual([
        "Page -references-> app::audit {op=select ops=select} supabase .from('audit').select @4",
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('follows a memoized factory called inline as the receiver', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/lib/admin.ts': [
        "import { createClient, type SupabaseClient } from '@supabase/supabase-js';",
        'let client: SupabaseClient | null = null;',
        'export function supabaseAdmin() {',
        '  if (!client) {',
        '    client = createClient(URL, KEY);',
        '  }',
        '  return client;',
        '}',
      ].join('\n'),
      'src/jobs.ts': [
        "import { supabaseAdmin } from '~/lib/admin';",
        'export async function cleanup() {',
        "  await supabaseAdmin().from('orders').delete().lt('id', 0);",
        '}',
      ].join('\n'),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['src/*'] } } }),
    });
    try {
      expect(dbEdges(cg)).toEqual([
        "cleanup -references-> public::orders {op=delete ops=delete} supabase .from('orders').delete @3",
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('keeps one edge per function and table, at its first write, for a Deno import and over a schema snapshot', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'full-schema.sql': 'CREATE TABLE orders (id bigint, status text);\n',
      'supabase/functions/pay/index.ts': [
        "import { createClient } from 'npm:@supabase/supabase-js@2';",
        'const supabase = createClient(URL, KEY);',
        'export async function handler(id: number) {',
        "  const { data } = await supabase.from('orders').select('status').eq('id', id);",
        '  await supabase',
        "    .from('orders')",
        "    .update({ status: 'paid' })",
        "    .eq('id', id);",
        '  return data;',
        '}',
      ].join('\n'),
    });
    try {
      expect(dbEdges(cg)).toEqual([
        "handler -calls-> public::on_status {event=update} trigger public::orders::orders_status @6",
        "handler -references-> public::orders {op=update ops=select,update columns=status} supabase .from('orders').update @6",
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('makes no edge from a receiver with no client evidence, or one more than one import away', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/lib/supabase.ts':
        "import { createClient } from '@supabase/supabase-js';\n" +
        'export const supabase = createClient(URL, KEY);\n',
      'src/lib/reexport.ts': "import { supabase } from './supabase';\nexport const db = supabase;\n",
      'src/api/other.ts': [
        "import { db } from '../lib/reexport';",
        "import { makeStore } from './store';",
        'const store = makeStore();',
        'export function fromStore() {',
        "  return store.from('orders').update({ status: 'x' });",
        '}',
        'export function arrays() {',
        "  return Array.from('orders');",
        '}',
        'export function twoHops() {',
        "  return db.rpc('create_order');",
        '}',
      ].join('\n'),
      'src/api/store.ts': 'export function makeStore() {\n  return { from: (t: string) => t };\n}\n',
    });
    try {
      expect(dbEdges(cg)).toEqual([]);
    } finally {
      cg.destroy();
    }
  });

  it('binds a client to the scope that declares it, a parameter or inner declaration of the name shadows it, and a client-typed parameter is one', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/shadow.ts': [
        "import { createClient, type SupabaseClient } from '@supabase/supabase-js';",
        'const db = createClient(URL, KEY);',
        'export function makesOne() {',
        '  const supabase = createClient(URL, KEY);',
        "  return supabase.from('orders').select();",
        '}',
        'export function shadowed(supabase: Other) {',
        "  return supabase.from('orders').insert({ total: 1 });",
        '}',
        'export function outsideItsScope() {',
        "  return supabase.from('orders').delete();",
        '}',
        'export function moduleClient() {',
        "  return db.from('orders').update({ note: 'x' });",
        '}',
        'export function paramShadows(db: Other) {',
        "  return db.from('orders').delete();",
        '}',
        'export function localShadows() {',
        '  const db = makeOther();',
        "  return db.rpc('create_order');",
        '}',
        'export function typedParam(client: SupabaseClient) {',
        "  return client.from('orders').delete();",
        '}',
      ].join('\n'),
    });
    try {
      expect(dbEdges(cg)).toEqual([
        "makesOne -references-> public::orders {op=select ops=select} supabase .from('orders').select @5",
        "moduleClient -references-> public::orders {op=update ops=update columns=note} supabase .from('orders').update @14",
        "typedParam -references-> public::orders {op=delete ops=delete} supabase .from('orders').delete @24",
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('links a call only to the schema of a project that contains it when several define the name, and never from sample code', async () => {
    const client = "import { createClient } from '@supabase/supabase-js';\nconst supabase = createClient(URL, KEY);\n";
    const cg = await indexed({
      'apps/shop/supabase/migrations/001_init.sql': 'CREATE TABLE todos (id int);\n',
      'apps/blog/supabase/migrations/001_init.sql': 'CREATE TABLE todos (id int);\n',
      'apps/shop/src/list.ts': client + "export function mine() {\n  return supabase.from('todos').select();\n}\n",
      'apps/docs/src/list.ts': client + "export function theirs() {\n  return supabase.from('todos').select();\n}\n",
      'apps/shop/src/sample.ts':
        client + "export function snippet() {\n  return `const { data } = await supabase.from('todos').delete()`;\n}\n",
    });
    try {
      expect(dbEdges(cg)).toEqual([
        "mine -references-> public::todos {op=select ops=select} supabase .from('todos').select @4",
      ]);
    } finally {
      cg.destroy();
    }
  });
});

describe('Supabase client calls in a monorepo', () => {
  it('does not link a sibling project to the one schema another project holds', async () => {
    const cg = await indexed({
      'examples/with-nextjs/package.json': '{ "name": "with-nextjs" }\n',
      'examples/with-nextjs/supabase/migrations/001_init.sql': 'CREATE TABLE articles (id int);\n',
      'examples/with-workers/package.json': '{ "name": "with-workers", "dependencies": { "@supabase/supabase-js": "^2" } }\n',
      'examples/with-workers/src/articles.ts':
        "import { createClient } from '@supabase/supabase-js';\nconst supabase = createClient(URL, KEY);\n" +
        "export function list() {\n  return supabase.from('articles').select();\n}\n",
    });
    try {
      expect(dbEdges(cg)).toEqual([]);
    } finally {
      cg.destroy();
    }
  });

  it('links a package to the schema of a workspace package it depends on', async () => {
    const cg = await indexed({
      'shared/schema/package.json': '{ "name": "@acme/schema" }\n',
      'shared/schema/supabase/migrations/001_init.sql': 'CREATE TABLE todos (id int);\n',
      'apps/web/package.json': '{ "name": "web", "dependencies": { "@acme/schema": "workspace:*" } }\n',
      'apps/web/lib/todos.ts':
        "import { createClient } from '@supabase/supabase-js';\nconst supabase = createClient(URL, KEY);\n" +
        "export function list() {\n  return supabase.from('todos').select();\n}\n",
    });
    try {
      expect(dbEdges(cg)).toEqual([
        "list -references-> public::todos {op=select ops=select} supabase .from('todos').select @4",
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('links app code to the one schema a package holds, through a one-line template name', async () => {
    const cg = await indexed({
      'packages/db/supabase/migrations/001_init.sql': 'CREATE TABLE todos (id int);\n',
      'apps/web/lib/todos.ts':
        "import { createClient } from '@supabase/supabase-js';\nconst supabase = createClient(URL, KEY);\n" +
        'export function list() {\n  return supabase.from(`todos`).select();\n}\n',
    });
    try {
      expect(dbEdges(cg)).toEqual([
        "list -references-> public::todos {op=select ops=select} supabase .from('todos').select @4",
      ]);
    } finally {
      cg.destroy();
    }
  });
});

describe('a function that performs several ops on one table', () => {
  it('shows every op on callers, impact, the node trail and the table block', async () => {
    const cg = await indexed({
      'supabase/migrations/001_schema.sql':
        'CREATE TABLE orders (id bigint, status text);\n' +
        'CREATE FUNCTION on_delete() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN OLD;\nEND;\n$$;\n' +
        'CREATE TRIGGER orders_deleted AFTER DELETE ON orders FOR EACH ROW EXECUTE FUNCTION on_delete();\n',
      'src/orders.ts':
        "import { createClient } from '@supabase/supabase-js';\nconst supabase = createClient(URL, KEY);\n" +
        'export async function folded(id: number) {\n' +
        "  await supabase.from('orders').select('id').eq('id', id);\n" +
        "  await supabase.from('orders').update({ status: 'x' }).eq('id', id);\n" +
        "  await supabase.from('orders').delete().eq('id', id);\n}\n",
    });
    try {
      expect(await tool(cg, 'codegraph_callers', { symbol: 'public::orders' })).toBe(
        '**Callers of public::orders (1 found)**\n\n- folded (function) - src/orders.ts:5 — via select, update, delete',
      );
      expect(await tool(cg, 'codegraph_impact', { symbol: 'public::orders', depth: 1 })).toContain(
        '**src/orders.ts:**\nfolded:3 [select, update, delete]',
      );
      const table = await tool(cg, 'codegraph_node', { symbol: 'public::orders' });
      expect(table).toContain([
        '- update: folded (src/orders.ts:3)',
        '- delete: folded (src/orders.ts:3) fires orders_deleted',
      ].join('\n'));
      expect(table).toContain(
        "**Called by ←** folded (src/orders.ts:5) [dynamic: supabase `.from('orders').update` @src/orders.ts:5]",
      );
    } finally {
      cg.close();
    }
    const cli = spawnSync(process.execPath, [BIN, 'callers', 'public::orders'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, CODEGRAPH_TELEMETRY: '0', NO_COLOR: '1' },
    });
    expect(cli.stdout).toContain('function    folded [select, update, delete]\n  src/orders.ts:5\n');
  });
});

describe('Knex, Kysely and Drizzle', () => {
  it('links knex builder calls with the op chained on them', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/db.ts': "import knex from 'knex';\nexport const db = knex({ client: 'pg' });\n",
      'src/repo.ts': [
        "import { db } from './db';",
        'export async function add() {',
        "  await db('orders').insert({ total: 1 });",
        '}',
        'export async function pay(id: number) {',
        "  await db('orders').where({ id }).update({ status: 'paid' });",
        '}',
        'export async function all() {',
        "  return db.from('app.audit').select('*');",
        '}',
      ].join('\n'),
      'src/jobs.js': [
        "const knex = require('knex')({ client: 'pg' });",
        'async function bump(id) {',
        "  await knex('orders').where({ id }).increment('total', 1);",
        '}',
        'function preview(id) {',
        "  return knex('orders').where({ id }).toString();",
        '}',
        'module.exports = { bump, preview };',
      ].join('\n'),
    });
    try {
      expect(dbEdges(cg)).toEqual([
        "add -calls-> public::on_insert {event=insert} trigger public::orders::orders_insert @3",
        "add -references-> public::orders {op=insert ops=insert} knex ('orders').insert @3",
        "all -references-> app::audit {op=select ops=select} knex .from('app.audit') @9",
        "bump -references-> public::orders {op=update ops=update columns=total} knex ('orders').increment @3",
        "pay -calls-> public::on_status {event=update} trigger public::orders::orders_status @6",
        "pay -references-> public::orders {op=update ops=update columns=status} knex ('orders').update @6",
        "preview -references-> public::orders {op=select ops=select} knex ('orders') @6",
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('links Kysely statements, with the columns its set() and doUpdateSet() write', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/repo.ts': [
        "import { Kysely, PostgresDialect } from 'kysely';",
        'const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });',
        'export async function find() {',
        "  return db.selectFrom('orders as o').selectAll().execute();",
        '}',
        'export async function pay(id: number) {',
        "  await db.updateTable('orders').set({ status: 'paid' }).where('id', '=', id).execute();",
        '}',
        'export async function upsert(id: number) {',
        "  await db.insertInto('orders').values({ id, note: 'x' })",
        "    .onConflict((oc) => oc.column('id').doUpdateSet({ note: 'x' })).execute();",
        '}',
        'export async function purge() {',
        "  await db.deleteFrom('app.audit').execute();",
        '}',
      ].join('\n'),
    });
    try {
      expect(dbEdges(cg)).toEqual([
        "find -references-> public::orders {op=select ops=select} kysely .selectFrom('orders as o') @4",
        "pay -calls-> public::on_status {event=update} trigger public::orders::orders_status @7",
        "pay -references-> public::orders {op=update ops=update columns=status} kysely .updateTable('orders') @7",
        "purge -references-> app::audit {op=delete ops=delete} kysely .deleteFrom('app.audit') @14",
        "upsert -calls-> public::on_insert {event=insert} trigger public::orders::orders_insert @10",
        "upsert -references-> public::orders {op=insert ops=insert,update columns=note upsert=true} kysely .insertInto('orders') @10",
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('links a Drizzle pgTable declaration to its table, with no op', async () => {
    const cg = await indexed({
      ...SCHEMA,
      'src/schema.ts': [
        "import { pgTable, pgSchema, bigint, text } from 'drizzle-orm/pg-core';",
        "export const orders = pgTable('orders', { id: bigint('id', { mode: 'number' }), status: text('status') });",
        "const app = pgSchema('app');",
        "export const audit = app.table('audit', { id: bigint('id', { mode: 'number' }) });",
      ].join('\n'),
    });
    try {
      expect(dbEdges(cg)).toEqual([
        "audit -references-> app::audit {} drizzle pgTable('audit') @4",
        "orders -references-> public::orders {} drizzle pgTable('orders') @2",
      ]);
    } finally {
      cg.destroy();
    }
  });
});

describe('the postgres-ts fixture', () => {
  async function flowOf(cg: CodeGraph, query: string): Promise<string> {
    const text = (await new ToolHandler(cg).execute('codegraph_explore', { query })).content[0]!.text;
    const start = text.indexOf('**Flow');
    if (start < 0) return '';
    return text.slice(start, text.indexOf('\n\n', text.indexOf('1. ', start)));
  }

  it('keeps the file of every hop of a SQL flow under the file cap, ahead of the table write path', async () => {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const cg = await indexed({
      'api/createOrderReport.ts': 'export function createOrderReport() {\n  return createOrderSummary();\n}\nexport function createOrderSummary() {\n  return 1;\n}\n',
      'api/createOrderForm.ts': 'export function createOrderForm() {\n  return createOrderFormState();\n}\nexport function createOrderFormState() {\n  return 2;\n}\n',
      'api/createOrderEmail.ts': 'export function createOrderEmail() {\n  return createOrderEmailBody();\n}\nexport function createOrderEmailBody() {\n  return 3;\n}\n',
    });
    try {
      const text = await tool(cg, 'codegraph_explore', {
        query: 'createOrderHandler create_order log_order_insert createOrderReport createOrderForm createOrderEmail',
      });
      const source = text.slice(text.indexOf('**Source Code**'));
      expect([...source.matchAll(/^\*\*`([^`]+)`\*\*/gm)].map((m) => m[1])).toEqual([
        'api/orders.ts',
        'supabase/migrations/002_functions.sql',
        'supabase/migrations/001_schema.sql',
        'supabase/migrations/004_audit.sql',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('keeps every file of a SQL flow under the file cap when the table has writers outside the flow', async () => {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const cg = await indexed({
      'api/archive.ts': "import { sql } from '../lib/sql';\nexport async function archiveOrdersHandler() {\n  await sql`UPDATE orders SET status = 'archived'`;\n}\n",
      'api/cancelOrderReport.ts': 'export function cancelOrderReport() {\n  return cancelOrderSummary();\n}\nexport function cancelOrderSummary() {\n  return 1;\n}\n',
      'api/cancelOrderEmail.ts': 'export function cancelOrderEmail() {\n  return cancelOrderEmailBody();\n}\nexport function cancelOrderEmailBody() {\n  return 2;\n}\n',
    });
    try {
      const text = await tool(cg, 'codegraph_explore', {
        query: 'cancelOrderHandler orders touch_updated_at cancelOrderReport cancelOrderEmail',
      });
      expect(text).toContain('archiveOrdersHandler');
      const source = text.slice(text.indexOf('**Source Code**'));
      expect([...source.matchAll(/^\*\*`([^`]+)`\*\*/gm)].map((m) => m[1])).toEqual([
        'api/orders.ts',
        'supabase/migrations/001_schema.sql',
        'supabase/migrations/002_functions.sql',
        'supabase/migrations/004_audit.sql',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('runs from each API handler through SQL to the trigger function its write fires', async () => {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const cg = await indexed();
    try {
      expect(await flowOf(cg, 'createOrderHandler create_order orders log_order_insert')).toBe([
        '**Flow (call path among the symbols you queried)**',
        '',
        '1. createOrderHandler (api/orders.ts:3)',
        "   ↓ dynamic: supabase `.schema('app').rpc('create_order')` @api/orders.ts:4",
        '2. create_order (supabase/migrations/002_functions.sql:18)',
        '   ↓ insert into `orders`',
        '3. orders (supabase/migrations/001_schema.sql:26)',
        '   ↓ dynamic: trigger `orders_audit` AFTER INSERT ON `orders` @supabase/migrations/004_audit.sql:16',
        '4. log_order_insert (supabase/migrations/004_audit.sql:8)',
      ].join('\n'));
      expect(await flowOf(cg, 'cancelOrderHandler orders touch_updated_at')).toBe([
        '**Flow (call path among the symbols you queried)**',
        '',
        '1. cancelOrderHandler (api/orders.ts:12)',
        "   ↓ dynamic: supabase `.from('orders').update` @api/orders.ts:14",
        '2. orders (supabase/migrations/001_schema.sql:26)',
        '   ↓ dynamic: trigger `orders_touch` BEFORE UPDATE ON `orders` @supabase/migrations/002_functions.sql:9',
        '3. touch_updated_at (supabase/migrations/002_functions.sql:1)',
      ].join('\n'));
    } finally {
      cg.destroy();
    }
  });
});

describe('without SQL', () => {
  it('is gated out of a project with no postgres files, and the same calls make no edge', async () => {
    const pass = SYNTH_PASSES.find((p) => p.name === 'sqlClientEdges')!;
    expect(pass.gate((...langs) => langs.includes('typescript'))).toBe(false);
    expect(pass.gate((...langs) => langs.some((l) => l === 'typescript' || l === 'postgres'))).toBe(true);
    const cg = await indexed({
      'src/lib/supabase.ts': "import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(URL, KEY);\n",
      'src/api.ts': "import { supabase } from './lib/supabase';\nexport function list() {\n  return supabase.from('orders').select();\n}\n",
    });
    try {
      expect(dbEdges(cg)).toEqual([]);
    } finally {
      cg.destroy();
    }
  });
});
