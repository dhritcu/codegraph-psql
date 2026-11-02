/**
 * A file over the size limit (a pg_dump `structure.sql`, a generated bundle)
 * is stored without symbols. `codegraph index` and `codegraph status` name it,
 * so an empty schema is not read as an empty project (fork issue #6).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../src/file-limits';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(cwd: string, args: string[]): { status: number | null; out: string; stdout: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
  });
  return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? ''), stdout: result.stdout ?? '' };
}

describe('files skipped for size', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-size-limit-'));
    fs.mkdirSync(path.join(dir, 'db'));
    fs.writeFileSync(path.join(dir, 'db', 'small.sql'), 'CREATE TABLE orders (id int);\n');
    const row = 'CREATE TABLE t (id int);\n';
    fs.writeFileSync(path.join(dir, 'db', 'structure.sql'), row.repeat(Math.ceil((MAX_SOURCE_FILE_SIZE_BYTES + 1) / row.length)));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('are named by index health, by codegraph index, and by codegraph status', async () => {
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    expect(cg.getIndexHealth()).toEqual({ needsReindex: [], parseErrors: [], skippedForSize: ['db/structure.sql'] });
    cg.destroy();

    const line = '1 file was skipped for size (over 1 MiB), so its symbols are missing: db/structure.sql';
    const index = run(dir, ['index']);
    expect(index.status, index.out).toBe(0);
    expect(index.out).toContain(line);

    const status = run(dir, ['status']);
    expect(status.status, status.out).toBe(0);
    expect(status.out).toContain(line);
    expect(status.out).toContain('Index is up to date');

    const json = run(dir, ['status', '--json']);
    expect(JSON.parse(json.stdout).index.filesSkippedForSize).toBe(1);
  });
});
