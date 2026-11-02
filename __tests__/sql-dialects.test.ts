import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';

const REPO = path.join(__dirname, '..');

function extract(file: string, source: string): { tables: string[]; parseErrors: string[] } {
  const result = extractFromSource(file, source, 'postgres');
  return {
    tables: result.nodes.filter((n) => n.kind === 'class').map((n) => n.qualifiedName),
    parseErrors: result.errors.filter((e) => e.code === 'parse_error').map((e) => e.message),
  };
}

describe('.sql files in another dialect', () => {
  beforeAll(async () => {
    await loadGrammarsForLanguages(['postgres']);
  });

  it('indexes a MySQL dump quietly, keeping the statements Postgres also reads', () => {
    const source = [
      'CREATE TABLE `users` (',
      '  `id` int NOT NULL AUTO_INCREMENT,',
      '  `name` varchar(255) NOT NULL,',
      '  PRIMARY KEY (`id`)',
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
      'CREATE TABLE audit (id int, note text);',
      'CREATE TABLE `posts` (',
      '  `id` int NOT NULL AUTO_INCREMENT,',
      '  KEY `user_id` (`user_id`)',
      ') ENGINE=InnoDB;',
    ].join('\n');
    expect(extract('mysql.sql', source)).toEqual({ tables: ['public::audit'], parseErrors: [] });
  });

  it('indexes a MySQL file with no statement Postgres reads as a file node with no parse warning', () => {
    const source = 'CREATE TABLE `users` (\n  `id` int(11) NOT NULL AUTO_INCREMENT\n) ENGINE=InnoDB;\n';
    const result = extractFromSource('only-mysql.sql', source, 'postgres');
    expect(result.nodes.map((n) => n.kind)).toEqual(['file']);
    expect(result.errors).toEqual([]);
  });

  it("indexes this repo's SQLite schema and D1 migrations quietly", () => {
    const schema = extract('src/db/schema.sql', fs.readFileSync(path.join(REPO, 'src/db/schema.sql'), 'utf8'));
    expect(schema.parseErrors).toEqual([]);
    expect(schema.tables).toContain('public::nodes');
    const d1 = extract(
      'telemetry-worker/migrations/0003_usage_daily.sql',
      fs.readFileSync(path.join(REPO, 'telemetry-worker/migrations/0003_usage_daily.sql'), 'utf8')
    );
    expect(d1).toEqual({ tables: ['public::usage_daily'], parseErrors: [] });
  });

  it('still warns about a PostgreSQL file nothing in which parses', () => {
    const source = 'CREATE TABLE orders (id bigserial PRIMARY KEY, total numeric NOT NULL;\nCREATE TABLE ( broken;\n';
    expect(extract('broken.sql', source).parseErrors).toEqual([
      'broken.sql: parse produced no symbols (tree has errors) — the file is indexed but contributes nothing to the graph',
    ]);
  });

  it('reads a dialect marker inside a comment or string as text, so a broken file still warns', () => {
    const source = "-- was `legacy` with ENGINE=InnoDB\nCREATE TABLE ( broken DEFAULT 'AUTOINCREMENT';\n";
    expect(extract('notes.sql', source).parseErrors).toHaveLength(1);
  });
});
