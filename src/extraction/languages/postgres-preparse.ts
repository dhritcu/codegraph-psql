/**
 * psql preparse for `.sql` files.
 *
 * Migration and test files are often psql scripts rather than plain SQL:
 * `\set` and `\i` meta-commands, `:name` / `:'name'` / `:"name"` variable
 * interpolation, and `COPY ... FROM stdin;` followed by raw data rows ending
 * at `\.`. None of that is SQL, so the grammar would turn it into error nodes
 * that swallow the statements around it.
 *
 * Every change keeps byte offsets and newlines so line numbers stay true:
 * a meta-command runs to the end of its line and becomes spaces, COPY data
 * rows become spaces, and an interpolation loses only its colon, which
 * leaves `'name'` as a string literal and `"name"` or `name` as an
 * identifier: the same token class psql substitutes there.
 *
 * A file in another dialect (a MySQL dump, a SQLite or D1 schema) carries
 * syntax Postgres never accepts. In such a file the statements the grammar
 * cannot read become spaces too, so it indexes what Postgres also reads
 * without a parse warning; a file with no such marker keeps its errors.
 */

import { getParser } from '../grammars';

const QUICK_CHECK = /\\|(?<!:):(?![:=])["'A-Za-z_]|\bstdin\b/i;
const COPY_FROM_STDIN = /\bCOPY\b[\s\S]*\bFROM\s+STDIN\b/i;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/;

export function preParsePostgres(source: string): string {
  return blankForeignStatements(preParsePsql(source));
}

/** Syntax of MySQL or SQLite that no Postgres statement contains outside a literal or comment. */
const FOREIGN_DIALECT = /`|\bAUTO_?INCREMENT\b|\bENGINE\s*=|\bWITHOUT\s+ROWID\b|^\s*PRAGMA\b/im;
const LITERAL_OR_COMMENT = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g;

function blankForeignStatements(source: string): string {
  if (!FOREIGN_DIALECT.test(source) || !FOREIGN_DIALECT.test(source.replace(LITERAL_OR_COMMENT, ' '))) return source;
  const parser = getParser('postgres');
  if (!parser) return source;
  const out = source.split('');
  let start = 0;
  const check = (end: number): void => {
    const tree = parser.parse(source.slice(start, end));
    for (const c of tree?.rootNode.hasError ? tree.rootNode.children : []) {
      if (!c || (!c.hasError && c.type !== 'ERROR')) continue;
      for (let k = start + c.startIndex; k < start + c.endIndex; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
    tree?.delete();
    start = end;
  };
  const token = new RegExp(`${LITERAL_OR_COMMENT.source}|;`, 'g');
  for (let m = token.exec(source); m; m = token.exec(source)) {
    if (m[0] === ';') check(m.index + 1);
  }
  check(source.length);
  return out.join('');
}

function preParsePsql(source: string): string {
  if (!QUICK_CHECK.test(source)) return source;

  const out = source.split('');
  let changed = false;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') {
        out[k] = ' ';
        changed = true;
      }
    }
  };
  const lineEnd = (from: number): number => {
    const nl = source.indexOf('\n', from);
    return nl < 0 ? source.length : nl;
  };

  const n = source.length;
  let stmtStart = 0;
  let i = 0;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '-' && next === '-') {
      i = lineEnd(i);
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') { depth++; i += 2; }
        else if (source[i] === '*' && source[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
    } else if (ch === "'") {
      const escapes = /[eE]/.test(source[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(source[i - 2] ?? '');
      i++;
      while (i < n) {
        if (escapes && source[i] === '\\') { i += 2; continue; }
        if (source[i] === "'") {
          if (source[i + 1] === "'") { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
    } else if (ch === '"') {
      const close = source.indexOf('"', i + 1);
      i = close < 0 ? n : close + 1;
    } else if (ch === '$' && !/[A-Za-z0-9_]/.test(source[i - 1] ?? '')) {
      const tag = DOLLAR_TAG.exec(source.slice(i, i + 64))?.[0];
      if (tag) {
        const close = source.indexOf(tag, i + tag.length);
        i = close < 0 ? n : close + tag.length;
      } else {
        i++;
      }
    } else if (ch === '\\') {
      const end = lineEnd(i);
      blank(i, end);
      i = end;
    } else if (ch === ':') {
      if (next === ':') {
        i += 2;
      } else {
        if (next !== undefined && /["'A-Za-z_]/.test(next)) blank(i, i + 1);
        i++;
      }
    } else if (ch === ';') {
      if (COPY_FROM_STDIN.test(source.slice(stmtStart, i))) {
        const dataStart = lineEnd(i) + 1;
        let j = dataStart;
        while (j < n) {
          const end = lineEnd(j);
          const isTerminator = source.slice(j, end).replace(/\r$/, '') === '\\.';
          j = end + 1;
          if (isTerminator) break;
        }
        blank(dataStart, Math.min(j, n));
        i = j;
      } else {
        i++;
      }
      stmtStart = i;
    } else {
      i++;
    }
  }

  return changed ? out.join('') : source;
}
