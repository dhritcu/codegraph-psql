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

/** Every edge but `contains`, as `source@file:line -kind-> target@file:line op`, sorted. */
function edges(cg: CodeGraph): string[] {
  const at = (id: string): string => {
    const n = cg.getNode(id)!;
    return `${n.qualifiedName}@${n.filePath}:${n.startLine}`;
  };
  const out: string[] = [];
  for (const file of cg.getFiles()) {
    for (const node of cg.getNodesInFile(file.path)) {
      for (const e of cg.getOutgoingEdges(node.id)) {
        if (e.kind === 'contains') continue;
        out.push(`${at(e.source)} -${e.kind}-> ${at(e.target)}${e.metadata?.op ? ` ${e.metadata.op}` : ''}`);
      }
    }
  }
  return out.sort();
}

const fn = (name: string, body: string): string =>
  `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  ${body}\n  RETURN NEW;\nEND;\n$$;\n`;

describe('PostgreSQL name resolution', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sql-resolution-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('binds a function redefined in three migrations to the last definition', async () => {
    const cg = await indexed({
      'supabase/migrations/20240101000000_init.sql':
        'CREATE TABLE t (id int);\n' + fn('touch', 'NULL;') +
        'CREATE TRIGGER t_touch BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION touch();\n',
      'supabase/migrations/20240201000000_fix.sql': fn('touch', 'NULL;'),
      'supabase/migrations/20240301000000_fix_again.sql': '\n\n' + fn('touch', 'NULL;'),
    });
    try {
      expect(edges(cg).filter((e) => e.includes('-calls->'))).toEqual([
        'public::t::t_touch@supabase/migrations/20240101000000_init.sql:8 -calls-> public::touch@supabase/migrations/20240301000000_fix_again.sql:3',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('orders numbered migrations by number, not by text', async () => {
    const cg = await indexed({
      'migrations/0002-first.sql': 'CREATE TABLE t (id int);\n' + fn('f', 'NULL;'),
      'migrations/00010-second.sql': fn('f', 'NULL;'),
      'migrations/0003-trigger.sql': 'CREATE TRIGGER t_f BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();\n',
    });
    try {
      expect(edges(cg).filter((e) => e.includes('-calls->'))).toEqual([
        'public::t::t_f@migrations/0003-trigger.sql:1 -calls-> public::f@migrations/00010-second.sql:1',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('binds a table dropped and created again to the recreation', async () => {
    const cg = await indexed({
      'prisma/migrations/20240101_init/migration.sql': 'CREATE TABLE "Account" (id int);\n',
      'prisma/migrations/20240201_rebuild/migration.sql': 'DROP TABLE "Account";\nCREATE TABLE "Account" (id int, name text);\n',
      'prisma/migrations/20240301_reader/migration.sql': 'CREATE VIEW names AS SELECT name FROM "Account";\n',
    });
    try {
      expect(edges(cg)).toEqual([
        'public::names@prisma/migrations/20240301_reader/migration.sql:1 -references-> public::Account@prisma/migrations/20240201_rebuild/migration.sql:2',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('binds a reference to a dropped object only while a definition is in force', async () => {
    const cg = await indexed({
      'drizzle/0000_init.sql': 'CREATE TABLE legacy (id int);\nCREATE VIEW before_drop AS SELECT id FROM legacy;\n',
      'drizzle/0001_drop.sql': 'DROP VIEW IF EXISTS before_drop;\nDROP TABLE IF EXISTS public.legacy CASCADE;\n',
      'drizzle/0002_after.sql': 'CREATE VIEW after_drop AS SELECT id FROM legacy;\n',
    });
    try {
      expect(edges(cg)).toEqual([
        'public::before_drop@drizzle/0000_init.sql:2 -references-> public::legacy@drizzle/0000_init.sql:1',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('counts a DROP a DO block runs as the migration applies, and not one in a routine body', async () => {
    const cg = await indexed({
      'drizzle/0000_init.sql': 'CREATE TABLE legacy (id int);\nCREATE TABLE kept (id int);\n',
      'drizzle/0001_drop.sql':
        'DO $$\nBEGIN\n  IF true THEN\n    DROP TABLE legacy;\n  END IF;\nEND;\n$$;\n' +
        'CREATE FUNCTION purge() RETURNS void LANGUAGE plpgsql AS $f$\nBEGIN\n  DROP TABLE kept;\nEND;\n$f$;\n',
      'drizzle/0002_after.sql': 'CREATE VIEW after_drop AS SELECT legacy.id FROM legacy, kept;\n',
    });
    try {
      expect(edges(cg)).toEqual([
        'public::after_drop@drizzle/0002_after.sql:1 -references-> public::kept@drizzle/0000_init.sql:2',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('gives a call to a built-in function no edge, even when the project declares one of that name', async () => {
    const cg = await indexed({
      'schema.sql': 'CREATE TABLE t (id int);\n' + fn('stamp', 'NEW.at := now(); PERFORM count(*) FROM t;') +
        'CREATE FUNCTION public.now() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n',
    });
    try {
      expect(edges(cg)).toEqual(['public::stamp@schema.sql:2 -references-> public::t@schema.sql:1 select']);
    } finally {
      cg.destroy();
    }
  });

  it('records the operation of each table reference on its edge', async () => {
    const cg = await indexed({
      'schema.sql': [
        'CREATE TABLE app.orders (id int, n int);',
        'CREATE FUNCTION app.work() RETURNS void LANGUAGE plpgsql AS $$',
        'BEGIN',
        '  INSERT INTO app.orders (id) VALUES (1);',
        '  UPDATE app.orders SET n = 2;',
        '  DELETE FROM app.orders WHERE id = 3;',
        '  PERFORM 1 FROM app.orders;',
        'END;',
        '$$;',
      ].join('\n'),
    });
    try {
      expect(edges(cg)).toEqual([
        'app::work@schema.sql:2 -references-> app::orders@schema.sql:1 delete',
        'app::work@schema.sql:2 -references-> app::orders@schema.sql:1 insert',
        'app::work@schema.sql:2 -references-> app::orders@schema.sql:1 select',
        'app::work@schema.sql:2 -references-> app::orders@schema.sql:1 update',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('binds a qualified and an unqualified name of one table to the same node', async () => {
    const cg = await indexed({
      'db/schema.sql': 'CREATE TABLE users (id int);\n',
      'db/views.sql': 'CREATE VIEW a AS SELECT id FROM users;\nCREATE VIEW b AS SELECT id FROM public.users;\n',
    });
    try {
      expect(edges(cg)).toEqual([
        'public::a@db/views.sql:1 -references-> public::users@db/schema.sql:1',
        'public::b@db/views.sql:2 -references-> public::users@db/schema.sql:1',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('leaves a name two unordered files define unbound, except in the file that defines it', async () => {
    const cg = await indexed({
      'a.sql': 'CREATE TABLE t (id int);\nCREATE VIEW va AS SELECT id FROM t;\n',
      'b.sql': 'CREATE TABLE t (id int);\n',
      'c.sql': 'CREATE VIEW vc AS SELECT id FROM t;\n',
    });
    try {
      expect(edges(cg)).toEqual(['public::va@a.sql:2 -references-> public::t@a.sql:1']);
    } finally {
      cg.destroy();
    }
  });

  it('joins no Python symbol to a SQL symbol by name', async () => {
    const cg = await indexed({
      'app.py': 'def users():\n    return []\n\ndef main():\n    users()\n',
      'schema.sql': 'CREATE TABLE users (id int);\nCREATE FUNCTION main() RETURNS int LANGUAGE sql AS $$ SELECT count(*) FROM users $$;\n',
    });
    try {
      expect(edges(cg)).toEqual([
        'main@app.py:4 -calls-> users@app.py:1',
        'public::main@schema.sql:2 -references-> public::users@schema.sql:1 select',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('attaches columns and an unnamed foreign key added in another migration to their table', async () => {
    const cg = await indexed({
      'migrations/001_init.sql': 'CREATE TABLE orders (id int);\nCREATE TABLE products (sku text);\n',
      'migrations/002_more.sql':
        'ALTER TABLE orders ADD COLUMN note text, ADD COLUMN sku text, ADD FOREIGN KEY (sku) REFERENCES products (sku);\n',
    });
    try {
      expect(edges(cg)).toEqual([
        'public::orders::note@migrations/002_more.sql:1 -references-> public::orders@migrations/001_init.sql:1',
        'public::orders::orders_sku_fkey@migrations/002_more.sql:1 -references-> public::orders@migrations/001_init.sql:1',
        'public::orders::orders_sku_fkey@migrations/002_more.sql:1 -references-> public::products@migrations/001_init.sql:2',
        'public::orders::sku@migrations/002_more.sql:1 -references-> public::orders@migrations/001_init.sql:1',
      ]);
    } finally {
      cg.destroy();
    }
  });

  it('gives the same edges after a sync of one edited migration as a fresh index', async () => {
    const files = {
      'migrations/001_init.sql': 'CREATE TABLE t (id int);\n' + fn('f', 'NULL;') +
        'CREATE TRIGGER t_f BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();\n',
      'migrations/002_fix.sql': fn('f', 'NULL;'),
      'migrations/003_more.sql': 'CREATE VIEW v AS SELECT id FROM t;\n',
    };
    const cg = await indexed(files);
    const redefined = fn('f', 'INSERT INTO t VALUES (1);');
    try {
      fs.appendFileSync(path.join(dir, 'migrations/003_more.sql'), redefined);
      await cg.sync();
      const synced = edges(cg);
      expect(synced).toContain(
        'public::t::t_f@migrations/001_init.sql:8 -calls-> public::f@migrations/003_more.sql:2'
      );
      cg.destroy();
      fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
      const fresh = await CodeGraph.init(dir, { silent: true });
      try {
        await fresh.indexAll();
        expect(synced).toEqual(edges(fresh));
      } finally {
        fresh.destroy();
      }
    } catch (err) {
      cg.destroy();
      throw err;
    }
  });
});
