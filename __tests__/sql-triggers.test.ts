import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

let dir: string;

function write(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  write(files);
  const cg = await CodeGraph.init(dir, { silent: true });
  await cg.indexAll();
  return cg;
}

/** Every pg-trigger edge, as `writer -> function [timing event level] trigger @registeredAt`, sorted. */
function triggerEdges(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const file of cg.getFiles()) {
    for (const node of cg.getNodesInFile(file.path)) {
      for (const e of cg.getOutgoingEdges(node.id)) {
        const m = e.metadata as Record<string, unknown> | undefined;
        if (m?.synthesizedBy !== 'pg-trigger') continue;
        expect(e.kind).toBe('calls');
        expect(e.provenance).toBe('heuristic');
        const when = m.when ? ` when ${String(m.when)}` : '';
        out.push(`${node.qualifiedName} -> ${cg.getNode(e.target)!.qualifiedName} [${String(m.timing)} ${String(m.event)} ${String(m.level)}${when}] ${String(m.trigger)} @${String(m.registeredAt)}`);
      }
    }
  }
  return out.sort();
}

const TABLE = 'CREATE TABLE orders (id int, status text, total int, note text);\n';

const triggerFn = (name: string): string =>
  `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$;\n`;

const writers =
  'CREATE FUNCTION add_order() RETURNS void LANGUAGE sql AS $$\n  INSERT INTO orders (id) VALUES (1);\n$$;\n' +
  "CREATE FUNCTION pay() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  UPDATE orders o SET status = 'paid', note = NULL WHERE o.id = 1;\nEND;\n$$;\n" +
  'CREATE FUNCTION retotal() RETURNS void LANGUAGE sql AS $$\n  UPDATE orders SET total = total + 1;\n$$;\n';

describe('PostgreSQL trigger edges', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sql-triggers-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('links an insert to its INSERT trigger and an update to the trigger guarding a column it sets', async () => {
    const cg = await indexed({
      'migrations/001_schema.sql': TABLE + triggerFn('on_insert') + triggerFn('on_status'),
      'migrations/002_triggers.sql':
        'CREATE TRIGGER orders_insert AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION on_insert();\n' +
        'CREATE TRIGGER orders_status\n  BEFORE UPDATE OF status ON orders\n  FOR EACH ROW EXECUTE FUNCTION on_status();\n',
      'migrations/003_writers.sql': writers,
    });
    try {
      expect(triggerEdges(cg)).toEqual([
        'public::add_order -> public::on_insert [after insert row] public::orders::orders_insert @migrations/002_triggers.sql:1',
        'public::pay -> public::on_status [before update row] public::orders::orders_status @migrations/002_triggers.sql:2',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('makes no edge for an update that sets none of the guarded columns', async () => {
    const cg = await indexed({
      'schema.sql': TABLE + triggerFn('on_status') +
        'CREATE TRIGGER orders_status BEFORE UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION on_status();\n' +
        'CREATE FUNCTION retotal() RETURNS void LANGUAGE sql AS $$\n  UPDATE orders SET (total, note) = (1, NULL);\n$$;\n',
    });
    try {
      expect(triggerEdges(cg)).toEqual([]);
    } finally {
      cg.destroy();
    }
  });

  it('fires an unguarded UPDATE trigger, an upsert, a MERGE and an INSTEAD OF trigger, and records WHEN', async () => {
    const cg = await indexed({
      'schema.sql': TABLE + triggerFn('touch') + triggerFn('on_view') + triggerFn('on_truncate') +
        'CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION touch();\n' +
        'CREATE TRIGGER orders_truncate AFTER TRUNCATE ON orders EXECUTE FUNCTION on_truncate();\n' +
        'CREATE VIEW open_orders AS SELECT * FROM orders;\n' +
        'CREATE TRIGGER open_orders_write INSTEAD OF INSERT OR DELETE ON open_orders FOR EACH ROW EXECUTE FUNCTION on_view();\n' +
        'CREATE FUNCTION upsert() RETURNS void LANGUAGE sql AS $$\n  INSERT INTO orders (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET total = 0;\n$$;\n' +
        'CREATE FUNCTION sync_orders() RETURNS void LANGUAGE sql AS $$\n  MERGE INTO orders o USING orders s ON o.id = s.id\n  WHEN MATCHED THEN UPDATE SET note = s.note\n  WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id);\n$$;\n' +
        'CREATE FUNCTION close_view() RETURNS void LANGUAGE sql AS $$\n  DELETE FROM open_orders WHERE id = 1;\n$$;\n' +
        writers,
    });
    try {
      const when = 'when OLD.* IS DISTINCT FROM NEW.*';
      expect(triggerEdges(cg)).toEqual([
        'public::close_view -> public::on_view [instead of delete row] public::open_orders::open_orders_write @schema.sql:20',
        `public::pay -> public::touch [before update row ${when}] public::orders::orders_touch @schema.sql:17`,
        `public::retotal -> public::touch [before update row ${when}] public::orders::orders_touch @schema.sql:17`,
        `public::sync_orders -> public::touch [before update row ${when}] public::orders::orders_touch @schema.sql:17`,
        `public::upsert -> public::touch [before update row ${when}] public::orders::orders_touch @schema.sql:17`,
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('makes one edge per writer for a statement-level trigger with a transition table', async () => {
    const cg = await indexed({
      'schema.sql': TABLE + triggerFn('audit') +
        'CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE ON orders\n  REFERENCING NEW TABLE AS changed\n  FOR EACH STATEMENT EXECUTE FUNCTION audit();\n' +
        'CREATE FUNCTION twice() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  INSERT INTO orders (id) VALUES (1);\n  UPDATE orders SET total = 2;\nEND;\n$$;\n',
    });
    try {
      expect(triggerEdges(cg)).toEqual([
        'public::twice -> public::audit [after insert statement] public::orders::orders_audit @schema.sql:7',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('drops the edges of a trigger a later migration drops, and keeps one dropped and created again', async () => {
    const cg = await indexed({
      'migrations/001_schema.sql': TABLE + triggerFn('on_insert') + triggerFn('on_delete') +
        'CREATE TRIGGER orders_insert AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION on_insert();\n' +
        'CREATE TRIGGER orders_delete AFTER DELETE ON orders FOR EACH ROW EXECUTE FUNCTION on_delete();\n',
      'migrations/002_drop.sql':
        '-- DROP TRIGGER orders_delete ON orders;\nDROP TRIGGER IF EXISTS orders_insert ON public.orders;\n',
      'migrations/003_writers.sql': writers +
        'CREATE FUNCTION remove() RETURNS void LANGUAGE sql AS $$\n  DELETE FROM orders;\n$$;\n',
      'migrations/004_again.sql':
        'DROP TRIGGER IF EXISTS orders_delete ON orders;\n' +
        'CREATE TRIGGER orders_delete AFTER DELETE ON orders FOR EACH ROW EXECUTE FUNCTION on_delete();\n',
    });
    try {
      expect(triggerEdges(cg)).toEqual([
        'public::remove -> public::on_delete [after delete row] public::orders::orders_delete @migrations/004_again.sql:2',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('removes a trigger\'s edges when a sync redefines the trigger away', async () => {
    const cg = await indexed({
      'schema.sql': TABLE + triggerFn('on_insert') +
        'CREATE TRIGGER orders_insert AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION on_insert();\n',
      'writers.sql': writers,
    });
    try {
      expect(triggerEdges(cg)).toEqual([
        'public::add_order -> public::on_insert [after insert row] public::orders::orders_insert @schema.sql:7',
      ]);
      write({ 'schema.sql': TABLE + triggerFn('on_insert') });
      await cg.sync();
      expect(triggerEdges(cg)).toEqual([]);
    } finally {
      cg.destroy();
    }
  });

  it('links the fixture procedure that updates orders to the trigger function touching it', async () => {
    fs.cpSync(path.join(__dirname, 'fixtures', 'postgres'), dir, { recursive: true });
    const cg = await indexed({});
    try {
      expect(triggerEdges(cg)).toEqual([
        'app::cancel_order -> public::touch_updated_at [before update row] public::orders::orders_touch @migrations/002_functions.sql:9',
      ]);
    } finally {
      cg.destroy();
    }
  });
});
