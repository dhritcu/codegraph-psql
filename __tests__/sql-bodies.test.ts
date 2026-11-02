import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { splitOpReferenceName } from '../src/extraction/languages/postgres-bodies';

const FIXTURE = path.join(__dirname, 'fixtures', 'postgres');

/** `from kind target line:column [op]` for every reference a file makes. */
function refs(source: string, file = 'm.sql'): string[] {
  const result = extractFromSource(file, source, 'postgres');
  const byId = new Map(result.nodes.map((n) => [n.id, n.qualifiedName]));
  return result.unresolvedReferences.map((r) => {
    const { op, qualifiedName } = splitOpReferenceName(r.referenceName);
    return `${byId.get(r.fromNodeId)} ${r.referenceKind} ${qualifiedName} ${r.line}:${r.column}${op ? ` ${op}` : ''}`;
  });
}

describe('PostgreSQL routine bodies', () => {
  beforeAll(async () => {
    await loadGrammarsForLanguages(['postgres']);
  });

  it('reads the tables a PL/pgSQL body selects, inserts, and updates, and the functions it calls', () => {
    const source = [
      'CREATE FUNCTION app.place_order(p_customer uuid) RETURNS int',
      'LANGUAGE plpgsql AS $body$',
      'DECLARE',
      '  n int;',
      '  v_total bigint;',
      'BEGIN',
      '  SELECT count(*) INTO n FROM app.carts WHERE customer = p_customer;',
      '  INSERT INTO orders (customer_id) VALUES (p_customer) RETURNING id INTO v_total;',
      '  UPDATE customers SET last_order = now() WHERE id = p_customer;',
      '  PERFORM notify_order(p_customer);',
      '  v_total := customer_total(p_customer);',
      '  RETURN n;',
      'END',
      '$body$;',
    ].join('\n');
    expect(refs(source)).toEqual([
      'app::place_order calls public::count 7:9',
      'app::place_order references app::carts 7:30 select',
      'app::place_order references public::orders 8:14 insert',
      'app::place_order references public::customers 9:9 update',
      'app::place_order calls public::now 9:36',
      'app::place_order calls public::notify_order 10:10',
      'app::place_order calls public::customer_total 11:13',
    ]);
  });

  it('never names a variable, parameter, record, NEW / OLD, or CTE as a table', () => {
    const source = [
      'CREATE FUNCTION audit() RETURNS trigger LANGUAGE plpgsql AS $$',
      'DECLARE',
      '  r record;',
      '  total int;',
      'BEGIN',
      '  SELECT a, b INTO STRICT total, r FROM ledger;',
      '  FOR r IN SELECT * FROM items LOOP',
      '    DELETE FROM items WHERE id = r.id;',
      '  END LOOP;',
      '  WITH recent AS (SELECT * FROM events) INSERT INTO archive SELECT * FROM recent;',
      '  NEW.updated_at := now();',
      '  RETURN NEW;',
      'END $$;',
    ].join('\n');
    expect(refs(source)).toEqual([
      'public::audit references public::ledger 6:40 select',
      'public::audit references public::items 7:25 select',
      'public::audit references public::items 8:16 delete',
      'public::audit references public::events 10:32 select',
      'public::audit references public::archive 10:52 insert',
      'public::audit calls public::now 11:20',
    ]);
  });

  it('reads a table whose name a variable or parameter shares wherever a table is written', () => {
    const source = [
      'CREATE FUNCTION sync_orders(items int) RETURNS void LANGUAGE plpgsql AS $$',
      'DECLARE',
      '  orders int;',
      'BEGIN',
      '  SELECT count(*) INTO orders FROM orders;',
      '  INSERT INTO orders (n) VALUES (orders);',
      '  UPDATE items SET n = orders;',
      '  DELETE FROM orders WHERE n = items;',
      'END $$;',
    ].join('\n');
    expect(refs(source)).toEqual([
      'public::sync_orders calls public::count 5:9',
      'public::sync_orders references public::orders 5:35 select',
      'public::sync_orders references public::orders 6:14 insert',
      'public::sync_orders references public::items 7:9 update',
      'public::sync_orders references public::orders 8:14 delete',
    ]);
  });

  it("reads a single-quoted body, '' escapes and all, at the file's lines and columns", () => {
    const source = [
      "CREATE FUNCTION touch(p int) RETURNS void LANGUAGE plpgsql AS '",
      'BEGIN',
      "  UPDATE orders SET note = ''it''''s'' WHERE id = p;",
      "  INSERT INTO audit (msg) VALUES (''touched'');",
      "END';",
      "CREATE FUNCTION paid_count() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM orders WHERE status = ''paid''';",
    ].join('\n');
    expect(refs(source)).toEqual([
      'public::touch references public::orders 3:9 update',
      'public::touch references public::audit 4:14 insert',
      'public::paid_count calls public::count 6:68',
      'public::paid_count references public::orders 6:82 select',
    ]);
  });

  it('invents nothing for dynamic SQL', () => {
    const source = [
      'CREATE FUNCTION purge(tbl text) RETURNS void LANGUAGE plpgsql AS $$',
      'BEGIN',
      "  EXECUTE format('DELETE FROM %I', tbl);",
      "  EXECUTE 'DELETE FROM sessions' USING tbl;",
      "  RETURN QUERY EXECUTE 'SELECT * FROM sessions';",
      'END $$;',
    ].join('\n');
    expect(refs(source)).toEqual([]);
  });

  it('reads a LANGUAGE sql body, a BEGIN ATOMIC body, and a MERGE', () => {
    const source = [
      'CREATE FUNCTION open_count() RETURNS bigint LANGUAGE sql AS $$',
      "  SELECT count(*) FROM orders WHERE status = 'pending';",
      '$$;',
      'CREATE PROCEDURE restock() LANGUAGE sql BEGIN ATOMIC',
      '  MERGE INTO stock s USING deliveries d ON s.sku = d.sku',
      '    WHEN MATCHED THEN UPDATE SET qty = s.qty + d.qty;',
      'END;',
    ].join('\n');
    expect(refs(source)).toEqual([
      'public::open_count calls public::count 2:9',
      'public::open_count references public::orders 2:23 select',
      'public::restock references public::stock 5:13 merge',
      'public::restock references public::deliveries 5:27 select',
    ]);
  });

  it('attributes a DO block to its file', () => {
    const source = [
      'DO $do$',
      'BEGIN',
      '  IF NOT EXISTS (SELECT 1 FROM app.settings) THEN',
      "    INSERT INTO app.settings (k) VALUES ('init');",
      '  END IF;',
      'END',
      '$do$;',
    ].join('\n');
    expect(refs(source, 'seed.sql')).toEqual([
      'seed.sql references app::settings 3:31 select',
      'seed.sql references app::settings 4:16 insert',
    ]);
  });

  it('ends a body at its own closing tag, not at an inner $$', () => {
    const source = [
      'CREATE FUNCTION tagged() RETURNS text LANGUAGE plpgsql AS $fn$',
      'BEGIN',
      '  RETURN $$ x $$ || (SELECT name FROM labels LIMIT 1);',
      'END',
      '$fn$;',
    ].join('\n');
    expect(refs(source)).toEqual(['public::tagged references public::labels 3:38 select']);
  });

  it('places every reference at the line and column where its name is written', () => {
    const source = fs.readFileSync(path.join(FIXTURE, 'migrations', '002_functions.sql'), 'utf8');
    const lines = source.split(/\r?\n/);
    const result = extractFromSource('migrations/002_functions.sql', source, 'postgres');
    const fromBodies = result.unresolvedReferences.filter((r) => splitOpReferenceName(r.referenceName).op || r.referenceKind === 'calls');
    const written = fromBodies.map((r) => {
      const name = r.referenceName.split('::').pop()!;
      return `${name} ${lines[r.line - 1]!.slice(r.column, r.column + name.length)}`;
    });
    expect(written).toEqual([
      'now now',
      'touch_updated_at touch_updated_at',
      'sum sum',
      'orders orders',
      'orders orders',
      'customer_total customer_total',
      'orders orders',
    ]);
  });

  it('gives two functions with the same body their own source and lines', () => {
    const body = (name: string) => [
      `CREATE FUNCTION ${name}() RETURNS int LANGUAGE plpgsql AS $$`,
      'DECLARE',
      '  v int;',
      'BEGIN',
      '  SELECT count(*) INTO v FROM orders;',
      '  RETURN v;',
      'END $$;',
    ];
    const result = extractFromSource('two.sql', [...body('first'), ...body('second')].join('\n'), 'postgres');
    const fns = result.nodes.filter((n) => n.kind === 'function');
    expect(fns.map((n) => `${n.qualifiedName} :${n.startLine}`)).toEqual(['public::first :1', 'public::second :8']);
    expect(new Set(fns.map((n) => n.id)).size).toBe(2);
    const byId = new Map(fns.map((n) => [n.id, n.name]));
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'references').map((r) => `${byId.get(r.fromNodeId)} ${r.line}`))
      .toEqual(['first 5', 'second 12']);
  });
});

describe('indexing the shop schema bodies', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sql-bodies-'));
    fs.cpSync(FIXTURE, dir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('connects create_order to the orders table it inserts into and the function it calls', async () => {
    const cg = await CodeGraph.init(dir, { silent: true });
    try {
      await cg.indexAll();
      const createOrder = cg.searchNodes('create_order').map((r) => r.node).find((n) => n.qualifiedName === 'app::create_order')!;
      expect(cg.getCallees(createOrder.id).map((c) => `${c.edge.kind} ${c.node.qualifiedName} :${c.edge.line}`).sort()).toEqual([
        'calls public::customer_total :25',
        'references public::orders :23',
      ]);
    } finally {
      cg.destroy();
    }
  });
});
