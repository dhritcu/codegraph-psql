import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
