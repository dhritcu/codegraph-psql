import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { buildNode } from '../src/ui-server/api/node';
import { tokenizeSource } from '../src/extraction/syntax-tokens';

const FIXTURE = path.join(__dirname, 'fixtures', 'postgres');

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

async function tool(cg: CodeGraph, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await new ToolHandler(cg).execute(name, args);
  return res.content[0]!.text;
}

/** The Flow section of an explore answer, up to the blank line that ends it. */
async function flowOf(cg: CodeGraph, query: string): Promise<string> {
  const text = await tool(cg, 'codegraph_explore', { query });
  const start = text.indexOf('**Flow');
  if (start < 0) return '';
  return text.slice(start, text.indexOf('\n\n', text.indexOf('1. ', start)));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sql-flow-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('explore Flow through SQL tables', () => {
  it('runs from a writer through the table it inserts into to the trigger that fires', async () => {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const cg = await indexed();
    try {
      expect(await flowOf(cg, 'create_order orders log_order_insert')).toBe([
        '**Flow (call path among the symbols you queried)**',
        '',
        '1. create_order (migrations/002_functions.sql:18)',
        '   ↓ insert into `orders`',
        '2. orders (migrations/001_schema.sql:26)',
        '   ↓ dynamic: trigger `orders_audit` AFTER INSERT ON `orders` @migrations/004_audit.sql:16',
        '3. log_order_insert (migrations/004_audit.sql:8)',
      ].join('\n'));
      expect(await flowOf(cg, 'cancel_order orders touch_updated_at')).toBe([
        '**Flow (call path among the symbols you queried)**',
        '',
        '1. cancel_order (migrations/002_functions.sql:30)',
        '   ↓ update `orders`',
        '2. orders (migrations/001_schema.sql:26)',
        '   ↓ dynamic: trigger `orders_touch` BEFORE UPDATE ON `orders` @migrations/002_functions.sql:9',
        '3. touch_updated_at (migrations/002_functions.sql:1)',
      ].join('\n'));
    } finally {
      cg.destroy();
    }
  });

  it('ends at a named table over the operation that reaches it', async () => {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const cg = await indexed();
    try {
      expect(await flowOf(cg, 'create_order customer_total orders')).toBe([
        '**Flow (call path among the symbols you queried)**',
        '',
        '1. create_order (migrations/002_functions.sql:18)',
        '   ↓ calls',
        '2. customer_total (migrations/002_functions.sql:13)',
        '   ↓ select from `orders`',
        '3. orders (migrations/001_schema.sql:26)',
      ].join('\n'));
    } finally {
      cg.destroy();
    }
  });

  it('prints a TypeScript call chain as it always has', async () => {
    const cg = await indexed({
      'src/app.ts':
        "import { loadUser } from './users';\nexport function handle(id: string) {\n  return loadUser(id);\n}\n",
      'src/users.ts':
        "import { query } from './db';\nexport function loadUser(id: string) {\n  return query(id);\n}\n",
      'src/db.ts': 'export function query(id: string) {\n  return id;\n}\n',
    });
    try {
      expect(await flowOf(cg, 'handle loadUser query')).toBe([
        '**Flow (call path among the symbols you queried)**',
        '',
        '1. handle (src/app.ts:2)',
        '   ↓ calls',
        '2. loadUser (src/users.ts:2)',
        '   ↓ calls',
        '3. query (src/db.ts:1)',
      ].join('\n'));
    } finally {
      cg.destroy();
    }
  });
});

describe('SQL tables on the node, callers and impact surfaces', () => {
  it('lists cross-file triggers as members of the table and names each caller\'s operation', async () => {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const cg = await indexed();
    try {
      const text = await tool(cg, 'codegraph_node', { symbol: 'public::orders', includeCode: true });
      expect(text).toContain([
        '- orders_owner (property):52 — `policy: CREATE POLICY orders_owner ON orders`',
        '- orders_touch (method) migrations/002_functions.sql:9 — `trigger: CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE`',
        '- orders_audit (method) migrations/004_audit.sql:16 — `trigger: CREATE TRIGGER orders_audit AFTER INSERT ON orders FOR EACH ROW EXECUTE`',
      ].join('\n'));
      expect(text).toContain('**Members (9):**');
      expect(text.split('\n').find((l) => l.startsWith('**Called by ←**'))).toBe(
        '**Called by ←** open_orders (migrations/003_views.sql:3), order_items (migrations/001_schema.sql:45), ' +
        'customer_revenue (migrations/003_views.sql:9), cancel_order (migrations/002_functions.sql:32) [update], ' +
        'create_order (migrations/002_functions.sql:23) [insert], customer_total (migrations/002_functions.sql:15) [select]'
      );

      const callers = await tool(cg, 'codegraph_callers', { symbol: 'public::orders' });
      expect(callers).toContain('- create_order (function) - migrations/002_functions.sql:23 — via insert');
      expect(callers).not.toContain('orders_touch');

      const impact = await tool(cg, 'codegraph_impact', { symbol: 'public::orders', depth: 1 });
      expect(impact).toContain('cancel_order:30 [update]');
      expect(impact).toContain('create_order:18 [insert]');
    } finally {
      cg.destroy();
    }
  });

  it('counts a column a later migration adds as a member and in the table\'s impact', async () => {
    const cg = await indexed({
      'migrations/001_init.sql': 'CREATE TABLE accounts (id int PRIMARY KEY);\n',
      'migrations/002_extra.sql': 'ALTER TABLE accounts ADD COLUMN nickname text;\n',
    });
    try {
      const text = await tool(cg, 'codegraph_node', { symbol: 'public::accounts', includeCode: true });
      expect(text).toContain('- nickname (field) migrations/002_extra.sql:1');
      expect(text).not.toContain('Called by');
      const impact = await tool(cg, 'codegraph_impact', { symbol: 'public::accounts', depth: 1 });
      expect(impact).toContain('nickname:1');
    } finally {
      cg.destroy();
    }
  });

  it('leads with the live definition of a redefined view and lists only it as a caller', async () => {
    const cg = await indexed({
      'migrations/001_init.sql':
        'CREATE TABLE accounts (id int, name text);\nCREATE VIEW named AS SELECT id FROM accounts;\n',
      'migrations/002_view.sql': 'CREATE OR REPLACE VIEW named AS SELECT id, name FROM accounts;\n',
    });
    try {
      const node = await tool(cg, 'codegraph_node', { symbol: 'named' });
      expect(node.startsWith('**named** (class)\n\n**Location:** migrations/002_view.sql:1')).toBe(true);
      expect(node.endsWith('**Superseded by the definition above (1, latest first)**\n- migrations/001_init.sql:2')).toBe(true);

      const callers = await tool(cg, 'codegraph_callers', { symbol: 'public::accounts' });
      expect(callers).toContain('**Callers of public::accounts (1 found)**');
      expect(callers).toContain('- named (class) - migrations/002_view.sql:1');
    } finally {
      cg.destroy();
    }
  });

  it('keeps overloads in one file as separate definitions', async () => {
    const cg = await indexed({
      'migrations/001_init.sql':
        'CREATE FUNCTION add(a int, b int) RETURNS int LANGUAGE sql AS $$ SELECT a + b $$;\n' +
        "CREATE FUNCTION add(a text, b text) RETURNS text LANGUAGE sql AS $$ SELECT a || b $$;\n",
    });
    try {
      const node = await tool(cg, 'codegraph_node', { symbol: 'add' });
      expect(node.startsWith('**2 definitions named "add"**')).toBe(true);
      expect(node).not.toContain('Superseded');
    } finally {
      cg.destroy();
    }
  });

  it('names a missing table in the viewer without the operation prefix', async () => {
    const cg = await indexed({
      'migrations/001_init.sql':
        'CREATE FUNCTION log_it() RETURNS void LANGUAGE sql AS $$\n  INSERT INTO audit.missing_log (id) VALUES (1);\n$$;\n',
    });
    try {
      const fn = cg.getNodesByName('log_it')[0]!;
      const body = (await buildNode(cg, dir, fn.id)) as { outsideIndex: { samples: Array<{ name: string }> } };
      expect(body.outsideIndex.samples.map((s) => s.name)).toEqual(['audit::missing_log']);
    } finally {
      cg.destroy();
    }
  });

  it('colors SQL keywords as keywords in the viewer', async () => {
    const source = 'SELECT id FROM accounts;\n';
    const result = await tokenizeSource(source, 'postgres');
    const keywords = result!.spans.filter((s) => s.cls === 'keyword').map((s) => source.slice(s.start, s.end));
    expect(keywords).toEqual(['SELECT', 'FROM']);
  });
});

describe('SQL functions across migrations', () => {
  const items = 'CREATE TABLE public.items (id bigint, name text);\n';
  const byId = 'CREATE FUNCTION public.add_item(p_id bigint) RETURNS void LANGUAGE sql AS $$ INSERT INTO public.items (id) VALUES (p_id) $$;\n';
  const byName = 'CREATE FUNCTION public.add_item(p_name text) RETURNS void LANGUAGE sql AS $$ INSERT INTO public.items (name) VALUES (p_name) $$;\n';

  it('keeps an overload a later migration adds beside the first', async () => {
    const cg = await indexed({ 'migrations/001_t.sql': items + byId, 'migrations/002_t.sql': byName });
    try {
      const callers = await tool(cg, 'codegraph_callers', { symbol: 'public::items' });
      expect(callers).toContain('**Callers of public::items (2 found)**');
      expect(callers).toContain('- add_item (function) - migrations/001_t.sql:2 — via insert');
      expect(callers).toContain('- add_item (function) - migrations/002_t.sql:1 — via insert');
      const node = await tool(cg, 'codegraph_node', { symbol: 'add_item' });
      expect(node.startsWith('**2 definitions named "add_item"**')).toBe(true);
      expect(node).not.toContain('Superseded');
    } finally {
      cg.destroy();
    }
  });

  it.each([
    ['with parameter names', 'DROP FUNCTION IF EXISTS public.add_item(p_id bigint);\n'],
    ['by type alias in a DO block', 'DO $$ BEGIN DROP FUNCTION public.add_item(int8); END $$;\n'],
  ])('ends an overload at a later DROP of its signature, written %s', async (_label, drop) => {
    const cg = await indexed({ 'migrations/001_t.sql': items + byId, 'migrations/002_t.sql': byName, 'migrations/003_drop.sql': drop });
    try {
      const callers = await tool(cg, 'codegraph_callers', { symbol: 'public::items' });
      expect(callers).toContain('**Callers of public::items (1 found)**');
      expect(callers).toContain('- add_item (function) - migrations/002_t.sql:1 — via insert');
      const node = await tool(cg, 'codegraph_node', { symbol: 'add_item' });
      expect(node.startsWith('**add_item** (function)\n\n**Location:** migrations/002_t.sql:1')).toBe(true);
      expect(node.endsWith('**Superseded by the definition above (1, latest first)**\n- migrations/001_t.sql:2')).toBe(true);
    } finally {
      cg.destroy();
    }
  });

  it('takes int and integer, or a renamed parameter, for one signature', async () => {
    const cg = await indexed({
      'migrations/001_t.sql': items + 'CREATE FUNCTION bump(a int) RETURNS int LANGUAGE sql AS $$ SELECT a + 1 $$;\n',
      'migrations/002_t.sql': 'CREATE OR REPLACE FUNCTION bump(b integer DEFAULT 0) RETURNS int LANGUAGE sql AS $$ SELECT b + 2 $$;\n',
    });
    try {
      const node = await tool(cg, 'codegraph_node', { symbol: 'bump' });
      expect(node.startsWith('**bump** (function)\n\n**Location:** migrations/002_t.sql:1')).toBe(true);
      expect(node.endsWith('**Superseded by the definition above (1, latest first)**\n- migrations/001_t.sql:2')).toBe(true);
    } finally {
      cg.destroy();
    }
  });
});

describe('a SQL table\'s write path', () => {
  const ORDERS = [
    '**SQL table `public::orders`** (migrations/001_schema.sql:26): 5 columns',
    '- Triggers (2):',
    '  - orders_audit AFTER INSERT → log_order_insert (migrations/004_audit.sql:8), declared migrations/004_audit.sql:16',
    '  - orders_touch BEFORE UPDATE → touch_updated_at (migrations/002_functions.sql:1), declared migrations/002_functions.sql:9',
    '- insert: create_order (migrations/002_functions.sql:18) fires orders_audit',
    '- update: cancel_order (migrations/002_functions.sql:30) fires orders_touch',
    '- Policies: orders_owner (migrations/001_schema.sql:52)',
    '- Indexes: orders_customer_idx (migrations/001_schema.sql:48)',
  ].join('\n');

  it('lists the table\'s triggers and writers in the default codegraph_node answer', async () => {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const cg = await indexed();
    try {
      const text = await tool(cg, 'codegraph_node', { symbol: 'public::orders' });
      expect(text).toContain(`**Signature:** \`table: CREATE TABLE orders\`\n\n${ORDERS}\n\n**Trail`);
    } finally {
      cg.destroy();
    }
  });

  it('answers a prose question about the write path in one explore call', async () => {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const cg = await indexed();
    try {
      const text = await tool(cg, 'codegraph_explore', { query: 'create order function insert into orders table triggers' });
      expect(text).toContain(`${ORDERS}\n\n**SQL table \`app::audit\`** (migrations/004_audit.sql:2): 3 columns\n- insert: log_order_insert (migrations/004_audit.sql:8)\n\n**Source Code**`);
      expect(text).toContain('18\tCREATE FUNCTION app.create_order(p_customer uuid, p_total integer) RETURNS bigint');
    } finally {
      cg.destroy();
    }
  });

  it('brings in the table a queried function writes, and counts the table\'s callers as callers lists them', async () => {
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const cg = await indexed();
    try {
      expect(await tool(cg, 'codegraph_explore', { query: 'cancel_order' })).toContain(ORDERS);
      expect(await tool(cg, 'codegraph_explore', { query: 'public::orders' })).toContain(
        '- `orders` (migrations/001_schema.sql:26) — 6 callers in `migrations/003_views.sql`, `migrations/001_schema.sql`, `migrations/002_functions.sql`'
      );
    } finally {
      cg.destroy();
    }
  });

  it('lists a trigger a later migration dropped apart from the live ones', async () => {
    const cg = await indexed({
      'migrations/001_init.sql':
        'CREATE TABLE notes (id int, body text);\n' +
        'CREATE FUNCTION stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\n' +
        'CREATE FUNCTION add_note() RETURNS void LANGUAGE sql AS $$ INSERT INTO notes (id) VALUES (1) $$;\n' +
        'CREATE TRIGGER notes_stamp BEFORE INSERT OR UPDATE OF body ON notes FOR EACH ROW EXECUTE FUNCTION stamp();\n' +
        'CREATE TRIGGER notes_old AFTER DELETE ON notes FOR EACH STATEMENT EXECUTE FUNCTION stamp();\n',
      'migrations/002_drop.sql': '-- DROP TRIGGER notes_stamp ON notes;\nDROP TRIGGER notes_old ON notes;\n',
    });
    try {
      expect(await tool(cg, 'codegraph_node', { symbol: 'public::notes' })).toContain([
        '**SQL table `public::notes`** (migrations/001_init.sql:1): 2 columns',
        '- Triggers (1):',
        '  - notes_stamp BEFORE INSERT OR UPDATE OF body → stamp (migrations/001_init.sql:2), declared migrations/001_init.sql:4',
        '- insert: add_note (migrations/001_init.sql:3) fires notes_stamp',
        '- Dropped triggers: notes_old (declared migrations/001_init.sql:5, dropped migrations/002_drop.sql:2)',
      ].join('\n'));
    } finally {
      cg.destroy();
    }
  });
});

describe('SQL objects a later migration drops', () => {
  const OBJECTS = 'CREATE SCHEMA storage;\nCREATE TABLE storage.objects (id uuid, name text);\n';
  const CLEANUP =
    'CREATE FUNCTION storage.objects_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM storage.objects WHERE false; RETURN NULL; END $$;\n' +
    'CREATE TRIGGER objects_cleanup AFTER DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.objects_cleanup();\n';
  const GUARD =
    'CREATE FUNCTION storage.protect_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$;\n' +
    'CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.protect_delete();\n';
  const DROPS =
    'DROP TRIGGER IF EXISTS objects_cleanup ON storage.objects;\n' +
    'DO $$ BEGIN DROP FUNCTION IF EXISTS storage.objects_cleanup(); END $$;\n';
  const files = {
    'migrations/001_objects.sql': OBJECTS,
    'migrations/002_cleanup.sql': CLEANUP,
    'migrations/003_guard.sql': GUARD,
    'migrations/004_drop.sql': DROPS,
  };
  const BLOCK = [
    '**SQL table `storage::objects`** (migrations/001_objects.sql:2): 2 columns',
    '- Triggers (1):',
    '  - protect_objects_delete BEFORE DELETE → protect_delete (migrations/003_guard.sql:1), declared migrations/003_guard.sql:2',
    '- delete: objects_cleanup (migrations/002_cleanup.sql:1, dropped migrations/004_drop.sql:2)',
    '- Dropped triggers: objects_cleanup (declared migrations/002_cleanup.sql:2, dropped migrations/004_drop.sql:1)',
  ].join('\n');

  it.each(['storage.objects delete trigger', '"storage"."objects" delete trigger'])(
    'answers %s with the table block in one explore call',
    async (query) => {
      const cg = await indexed(files);
      try {
        expect(await tool(cg, 'codegraph_explore', { query })).toContain(`${BLOCK}\n`);
      } finally {
        cg.destroy();
      }
    },
  );

  it('shows a dropped function as dropped in node and explore', async () => {
    const cg = await indexed(files);
    try {
      const node = await tool(cg, 'codegraph_node', { symbol: 'storage::objects_cleanup' });
      expect(node.startsWith([
        '**objects_cleanup** (function)',
        '',
        '**Location:** migrations/002_cleanup.sql:1',
        '**Dropped:** migrations/004_drop.sql:2, by a later migration; it does not exist once every migration applies.',
      ].join('\n'))).toBe(true);
      expect(await tool(cg, 'codegraph_explore', { query: 'objects_cleanup storage.objects' })).toContain(
        '**Dropped by later migrations:** objects_cleanup (function, declared migrations/002_cleanup.sql:1, dropped migrations/004_drop.sql:2), ' +
          'objects_cleanup (trigger, declared migrations/002_cleanup.sql:2, dropped migrations/004_drop.sql:1)',
      );
    } finally {
      cg.destroy();
    }
  });

  it('reads the DROPs once per index revision, not once per object, and again after a sync', async () => {
    const cg = await indexed(files);
    try {
      const getFiles = vi.spyOn(cg, 'getFiles');
      for (const symbol of ['storage::objects', 'storage::objects', 'storage::objects_cleanup', 'objects_cleanup']) {
        await tool(cg, 'codegraph_node', { symbol });
      }
      expect(getFiles).toHaveBeenCalledTimes(1);

      write({ 'migrations/005_drop_guard.sql': 'DROP TRIGGER protect_objects_delete ON storage.objects;\n' });
      await cg.sync();
      const node = await tool(cg, 'codegraph_node', { symbol: 'storage::objects' });
      expect(getFiles).toHaveBeenCalledTimes(2);
      expect(node).toContain(
        '- Dropped triggers: objects_cleanup (declared migrations/002_cleanup.sql:2, dropped migrations/004_drop.sql:1), ' +
          'protect_objects_delete (declared migrations/003_guard.sql:2, dropped migrations/005_drop_guard.sql:1)',
      );
    } finally {
      cg.destroy();
    }
  });

  it('keeps the superseded list when a long body is cut', async () => {
    const body = Array.from({ length: 800 }, (_, i) => `  PERFORM ${i} + ${i};`).join('\n');
    const cg = await indexed({
      'migrations/001_t.sql': 'CREATE FUNCTION big() RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;\n',
      'migrations/002_t.sql': `CREATE OR REPLACE FUNCTION big() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n${body}\nEND\n$$;\n`,
    });
    try {
      const node = await tool(cg, 'codegraph_node', { symbol: 'big', includeCode: true });
      expect(node).toContain('... (output truncated)');
      expect(node.endsWith('**Superseded by the definition above (1, latest first)**\n- migrations/001_t.sql:1')).toBe(true);
    } finally {
      cg.destroy();
    }
  });
});

describe('SQL argument types with a typmod', () => {
  it.each([
    ['numeric(10, 2)', 'p numeric'],
    ['timestamp(3) with time zone', 'at timestamptz'],
    ['varchar(20)[]', 'names character varying[]'],
  ])('takes %s and %s for one signature', async (first, second) => {
    const cg = await indexed({
      'migrations/001_t.sql': `CREATE FUNCTION fmt(${first}) RETURNS text LANGUAGE sql AS $$ SELECT 'a' $$;\n`,
      'migrations/002_t.sql': `CREATE OR REPLACE FUNCTION fmt(${second}) RETURNS text LANGUAGE sql AS $$ SELECT 'b' $$;\n`,
    });
    try {
      const node = await tool(cg, 'codegraph_node', { symbol: 'fmt' });
      expect(node.startsWith('**fmt** (function)\n\n**Location:** migrations/002_t.sql:1')).toBe(true);
      expect(node.endsWith('**Superseded by the definition above (1, latest first)**\n- migrations/001_t.sql:1')).toBe(true);
    } finally {
      cg.destroy();
    }
  });
});
