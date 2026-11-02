import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { detectLanguage, getLanguageDisplayName, getParser, loadGrammarsForLanguages } from '../src/extraction/grammars';

describe('PostgreSQL grammars', () => {
  beforeAll(async () => {
    await loadGrammarsForLanguages(['postgres']);
  });

  it('detects .sql, .psql and .pgsql as postgres', () => {
    expect(['a.sql', 'b.psql', 'c.pgsql', 'D.SQL'].map((f) => detectLanguage(f))).toEqual([
      'postgres',
      'postgres',
      'postgres',
      'postgres',
    ]);
    expect(getLanguageDisplayName('postgres')).toBe('PostgreSQL');
    expect(getLanguageDisplayName('plpgsql')).toBe('PL/pgSQL');
  });

  it('parses a MERGE without a WHEN condition', () => {
    const tree = getParser('postgres')!.parse('MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE;')!;
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('MergeStmt').map((n) => n.text)).toEqual([
      'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE',
    ]);
  });

  it('loads the PL/pgSQL grammar alongside postgres and parses a quoted COLLATE declaration', () => {
    const body = ['DECLARE', '  last_name TEXT COLLATE "C" := NULL;', 'BEGIN', '  RETURN last_name;', 'END'].join('\n');
    const tree = getParser('plpgsql')!.parse(body)!;
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('decl_collate').map((n) => n.text)).toEqual(['COLLATE "C"']);
  });

  it('parses PL/pgSQL %TYPE[] declarations and label-qualified FOR targets', () => {
    const body = [
      '<<lbl>>declare v int; a v%type[]; r pg_class%rowtype[1][3];',
      'begin',
      "  for lbl.v in execute 'select 1' loop null; end loop;",
      'end',
    ].join('\n');
    const tree = getParser('plpgsql')!.parse(body)!;
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType('qualified_identifier').map((n) => n.text)).toEqual(['lbl.v']);
  });
});

describe('indexing .sql files', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-grammar-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records every SQL file as postgres', async () => {
    fs.writeFileSync(path.join(dir, '001_init.sql'), 'CREATE TABLE orders (id bigint PRIMARY KEY);\n');
    fs.writeFileSync(path.join(dir, 'fn.pgsql'), 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n');
    const cg = await CodeGraph.init(dir, { silent: true });
    try {
      await cg.indexAll();
      const rows = (cg as any).db.db.prepare('SELECT path, language FROM files ORDER BY path').all();
      expect(rows).toEqual([
        { path: '001_init.sql', language: 'postgres' },
        { path: 'fn.pgsql', language: 'postgres' },
      ]);
    } finally {
      cg.destroy();
    }
  });
});
