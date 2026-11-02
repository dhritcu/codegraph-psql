/**
 * Interactive `codegraph install`, driven through the built binary by pressing
 * Enter at every prompt: the fork must never run `npm install -g` (that would
 * put upstream's release on PATH over the fork's `npm link`), and the
 * usage-stats prompt must default to No.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function pressEnterThroughInstall(home: string, binDir: string): Promise<{ code: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    CODEGRAPH_TELEMETRY_ENDPOINT: 'http://127.0.0.1:9/',
    CODEGRAPH_NO_DAEMON: '1',
    NO_COLOR: '1',
  };
  delete env.CODEGRAPH_TELEMETRY;
  delete env.DO_NOT_TRACK;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'install', '--target', 'claude', '--location', 'global'], {
      cwd: home,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.includes('Done!')) child.stdin.end();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const enter = setInterval(() => {
      if (child.stdin.writable) child.stdin.write('\r');
    }, 200);
    const kill = setTimeout(() => child.kill(), 60_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearInterval(enter);
      clearTimeout(kill);
      resolve({ code, out });
    });
  });
}

describe.runIf(process.platform !== 'win32')('interactive codegraph install in the fork', () => {
  let home: string;
  let binDir: string;
  let npmLog: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-install-interactive-'));
    binDir = path.join(home, 'fake-bin');
    npmLog = path.join(home, 'npm-argv.log');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\necho "$@" >> '${npmLog}'\n`, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('never runs npm and leaves telemetry off when every prompt takes its default', async () => {
    const { code, out } = await pressEnterThroughInstall(home, binDir);
    expect(code, out).toBe(0);

    expect(fs.existsSync(npmLog)).toBe(false);
    expect(out).toContain(
      'Put the fork there by running `npm link` in your codegraph-psql checkout (see FORK.md).',
    );

    const telemetry = JSON.parse(fs.readFileSync(path.join(home, '.codegraph', 'telemetry.json'), 'utf8'));
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.consent_source).toBe('installer');
    expect(out).toContain('Telemetry disabled — nothing will be collected or sent.');
  }, 90_000);
});
