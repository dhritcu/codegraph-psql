import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

let dir: string;

const STORAGE: Record<string, string> = {
  'migrations/tenant/0001-objects.sql':
    'CREATE SCHEMA storage;\n' +
    'CREATE TABLE storage.objects (id uuid, name text, level int);\n',
  'migrations/tenant/0002-prefixes.sql':
    'CREATE FUNCTION storage.delete_leaf_prefixes(names text[]) RETURNS void LANGUAGE plpgsql AS $$\n' +
    'BEGIN\n' +
    '  PERFORM 1 FROM storage.objects WHERE name = ANY(names);\n' +
    'END\n' +
    '$$;\n' +
    'CREATE FUNCTION storage.objects_delete_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$\n' +
    'BEGIN\n' +
    '  PERFORM storage.delete_leaf_prefixes(ARRAY[]::text[]);\n' +
    '  RETURN NULL;\n' +
    'END\n' +
    '$$;\n' +
    'CREATE TRIGGER objects_delete_cleanup AFTER DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.objects_delete_cleanup();\n',
  'migrations/tenant/0003-redefine-prefixes.sql':
    'CREATE OR REPLACE FUNCTION storage.delete_leaf_prefixes(names text[]) RETURNS void LANGUAGE plpgsql AS $$\n' +
    'BEGIN\n' +
    '  PERFORM 2 FROM storage.objects WHERE name = ANY(names);\n' +
    'END\n' +
    '$$;\n',
  'migrations/tenant/0004-rollback.sql':
    'DROP TRIGGER IF EXISTS objects_delete_cleanup ON storage.objects;\n' +
    'DROP FUNCTION IF EXISTS storage.objects_delete_cleanup();\n',
  'migrations/tenant/0005-levels.sql':
    '-- backfill\n' +
    'DO $$\n' +
    'BEGIN\n' +
    '  UPDATE storage.objects SET level = 1;\n' +
    'END\n' +
    '$$;\n',
  'migrations/tenant/0006-protect.sql':
    'CREATE FUNCTION storage.protect_delete() RETURNS trigger LANGUAGE plpgsql AS $$\n' +
    'BEGIN\n' +
    "  IF current_setting('storage.allow_delete_query', true) <> 'true' THEN\n" +
    "    RAISE EXCEPTION 'direct delete';\n" +
    '  END IF;\n' +
    '  RETURN NULL;\n' +
    'END\n' +
    '$$;\n' +
    'CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();\n',
  'migrations/tenant/0007-drop-unused.sql':
    'DROP FUNCTION IF EXISTS storage.delete_leaf_prefixes(text[]);\n',
  'migrations/tenant/0008-lifecycle.sql':
    'CREATE FUNCTION storage.delete_lifecycle_objects(ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$\n' +
    'BEGIN\n' +
    "  PERFORM set_config('storage.allow_delete_query', 'true', true);\n" +
    '  DELETE FROM storage.objects WHERE id = ANY(ids);\n' +
    'END\n' +
    '$$;\n',
};

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

async function explore(cg: CodeGraph, query: string): Promise<string> {
  const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
  return res.content[0]!.text;
}

/** `**\`path\`**` file headers of the Source Code section, in order. */
function sourceFiles(text: string): string[] {
  const source = text.slice(text.indexOf('**Source Code**'));
  return [...source.matchAll(/^\*\*`([^`]+)`\*\*/gm)].map((m) => m[1]!);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sql-sufficiency-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a SQL table\'s write path, complete enough to stop reading migrations', () => {
  it('marks every hop of a dropped chain in Flow instead of presenting it as live', async () => {
    const cg = await indexed(STORAGE);
    try {
      const text = await explore(cg, 'objects_delete_cleanup trigger on storage.objects delete');
      expect(text.slice(0, text.indexOf('\n\n> Full source'))).toBe([
        '**Flow (call path among the symbols you queried)**',
        '',
        '> This path no longer runs once every migration applies: the hops marked below were dropped or redefined by a later migration.',
        '',
        '1. objects_delete_cleanup (migrations/tenant/0002-prefixes.sql:12) — dropped in migrations/tenant/0004-rollback.sql:1',
        '   ↓ calls',
        '2. objects_delete_cleanup (migrations/tenant/0002-prefixes.sql:6) — dropped in migrations/tenant/0004-rollback.sql:2',
        '   ↓ calls',
        '3. delete_leaf_prefixes (migrations/tenant/0002-prefixes.sql:1) — dropped in migrations/tenant/0007-drop-unused.sql:1',
        '   ↓ select from `objects`',
        '4. objects (migrations/tenant/0001-objects.sql:2)',
      ].join('\n'));
    } finally {
      cg.destroy();
    }
  });

  it('prefers a chain that still runs over a longer one through dropped hops', async () => {
    const cg = await indexed(STORAGE);
    try {
      const text = await explore(cg, 'objects_delete_cleanup delete_lifecycle_objects protect_delete storage.objects');
      expect(text.slice(0, text.indexOf('\n\n> Full source'))).toBe([
        '**Flow (call path among the symbols you queried)**',
        '',
        '1. delete_lifecycle_objects (migrations/tenant/0008-lifecycle.sql:1)',
        '   ↓ delete from `objects`',
        '2. objects (migrations/tenant/0001-objects.sql:2)',
        '   ↓ dynamic: trigger `protect_objects_delete` BEFORE DELETE ON `objects` FOR EACH STATEMENT @migrations/tenant/0006-protect.sql:9',
        '3. protect_delete (migrations/tenant/0006-protect.sql:1)',
      ].join('\n'));
    } finally {
      cg.destroy();
    }
  });

  it('states the trigger list is complete and names a DO block writer as one', async () => {
    const cg = await indexed(STORAGE);
    try {
      expect(await explore(cg, 'storage.objects delete trigger')).toContain([
        '**SQL table `storage::objects`** (migrations/tenant/0001-objects.sql:2): 3 columns',
        '- Triggers (1, all live triggers as of the last migration, migrations/tenant/0008-lifecycle.sql):',
        '  - protect_objects_delete BEFORE DELETE FOR EACH STATEMENT → protect_delete (migrations/tenant/0006-protect.sql:1), declared migrations/tenant/0006-protect.sql:9',
        '- update: DO block in migrations/tenant/0005-levels.sql:4',
        '- delete: delete_lifecycle_objects (migrations/tenant/0008-lifecycle.sql:1) fires protect_objects_delete',
        '- Dropped triggers: objects_delete_cleanup (declared migrations/tenant/0002-prefixes.sql:12, dropped migrations/tenant/0004-rollback.sql:1)',
      ].join('\n'));
    } finally {
      cg.destroy();
    }
  });

  it('says a table has no live trigger left once the last one is dropped', async () => {
    const cg = await indexed({
      ...STORAGE,
      'migrations/tenant/0009-unprotect.sql': 'DROP TRIGGER protect_objects_delete ON storage.objects;\n',
    });
    try {
      expect(await explore(cg, 'storage.objects delete trigger')).toContain(
        '- Triggers: none live as of the last migration, migrations/tenant/0009-unprotect.sql\n',
      );
    } finally {
      cg.destroy();
    }
  });

  it('spends the source budget on the live trigger function and its writer, and only names dropped bodies', async () => {
    const cg = await indexed({
      ...STORAGE,
      'src/storage/objects.ts':
        'export function deleteObjects(ids: string[]) {\n  return remove(ids);\n}\n' +
        'export function remove(ids: string[]) {\n  return ids.length;\n}\n',
    });
    try {
      const text = await explore(cg, 'objects_delete_cleanup trigger on storage.objects delete');
      expect(sourceFiles(text)).toEqual([
        'migrations/tenant/0001-objects.sql',
        'migrations/tenant/0006-protect.sql',
        'migrations/tenant/0008-lifecycle.sql',
        'src/storage/objects.ts',
      ]);
      expect(text).toContain([
        '> Not printed, because a later migration dropped or redefined them and their bodies no longer run:',
        '> - delete_leaf_prefixes: `storage.delete_leaf_prefixes(names text[]) RETURNS void`, declared migrations/tenant/0002-prefixes.sql:1, dropped in migrations/tenant/0007-drop-unused.sql:1',
        '> - objects_delete_cleanup: `storage.objects_delete_cleanup() RETURNS trigger`, declared migrations/tenant/0002-prefixes.sql:6, dropped in migrations/tenant/0004-rollback.sql:2',
        '> - objects_delete_cleanup: `objects_delete_cleanup AFTER DELETE ON storage.objects FOR EACH STATEMENT EXECUTE`, declared migrations/tenant/0002-prefixes.sql:12, dropped in migrations/tenant/0004-rollback.sql:1',
      ].join('\n'));
      expect(text).toContain("3\t  IF current_setting('storage.allow_delete_query', true) <> 'true' THEN");
      expect(text).toContain('4\t  DELETE FROM storage.objects WHERE id = ANY(ids);');
      expect(text).not.toContain('8\t  PERFORM storage.delete_leaf_prefixes(ARRAY[]::text[]);');
    } finally {
      cg.destroy();
    }
  });
});
