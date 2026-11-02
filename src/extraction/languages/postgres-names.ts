/**
 * PostgreSQL identifier folding.
 *
 * Postgres folds an unquoted identifier to lower case and keeps a quoted one
 * as written, so `Orders` and `orders` name one table and `"Orders"` another.
 * An object written without a schema lands in `public` (the default
 * search_path). Qualified names join the folded parts with `::`:
 * `public::orders`, and a column `public::orders::status`.
 */

export const DEFAULT_SCHEMA = 'public';

/** A schema-level object name after folding. */
export interface SqlName {
  schema: string;
  name: string;
}

/**
 * Split an identifier path such as `app."Line Items"` into folded parts:
 * `['app', 'Line Items']`. Whitespace and comments between parts are skipped.
 */
export function splitIdentifierPath(text: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      let part = '';
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            part += '"';
            j += 2;
            continue;
          }
          break;
        }
        part += text[j];
        j++;
      }
      parts.push(part);
      i = j + 1;
    } else if (ch === '.' || /\s/.test(ch)) {
      i++;
    } else if (ch === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      let j = i;
      while (j < text.length && !/[\s."]/.test(text[j]!)) j++;
      parts.push(text.slice(i, j).toLowerCase());
      i = j;
    }
  }
  return parts;
}

/**
 * The object a folded identifier path names. A three-part `db.schema.name`
 * keeps the last two parts; a bare name gets `defaultSchema`.
 */
export function objectFromParts(parts: readonly string[], defaultSchema = DEFAULT_SCHEMA): SqlName | null {
  const name = parts[parts.length - 1];
  if (!name) return null;
  return { schema: parts.length > 1 ? parts[parts.length - 2]! : defaultSchema, name };
}

/** Fold a possibly qualified object name as written: `App."Orders"` → app / Orders. */
export function foldObjectName(text: string, defaultSchema = DEFAULT_SCHEMA): SqlName | null {
  return objectFromParts(splitIdentifierPath(text), defaultSchema);
}

/** `schema::name`, then any member parts: `public::orders::status`. */
export function qualify(object: SqlName, ...members: string[]): string {
  return [object.schema, object.name, ...members].join('::');
}
