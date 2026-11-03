import { describe, expect, it } from 'vitest';
import { DDL_READINGS, migrationSeries, readSqlDdl, sqlClients, type SqlDdl } from '../src/resolution/sql-model';

const MIGRATION = [
  'DROP FUNCTION IF EXISTS app.f(integer, text), g CASCADE;',
  'ALTER EXTENSION ext DROP FUNCTION app.h(bigint);',
  'DROP TYPE app.mood;',
  'DROP TRIGGER t ON app.orders;',
  'ALTER TABLE app.orders DISABLE TRIGGER t;',
].join('\n');

function read(reading: keyof typeof DDL_READINGS): Record<string, string[]> {
  const ddl: SqlDdl = new Map();
  readSqlDdl('migrations/0002_x.sql', MIGRATION, DDL_READINGS[reading], ddl);
  return Object.fromEntries([...ddl].map(([key, events]) => [key, events.map((e) => `${e.kind}@${e.at.line}`)]));
}

describe('sql-model', () => {
  it('places a file in its migration series, or outside one as asked', () => {
    expect(migrationSeries('supabase/migrations/20240101_init.sql')).toBe('supabase/migrations');
    expect(migrationSeries('prisma/migrations/20240101_init/migration.sql')).toBe('prisma/migrations');
    expect(migrationSeries('db/migrations/init.sql')).toBe('db/migrations');
    expect(migrationSeries('sql/schema.sql')).toBeNull();
    expect(migrationSeries('sql/schema.sql', 'file')).toBe('sql/schema.sql');
    expect(migrationSeries('sql/schema.sql', 'directory')).toBe('sql');
  });

  it('reads DDL as the resolver does: statement starts, names only, trigger switches', () => {
    expect(read('resolver')).toEqual({
      'routine:app::f': ['drop@1'],
      'routine:public::g': ['drop@1'],
      'type:app::mood': ['drop@3'],
      'trigger:app::orders::t': ['drop@4', 'disable@5'],
    });
  });

  it('reads DDL as the query-time surfaces do: any DROP keyword, routines by signature', () => {
    expect(read('surface')).toEqual({
      'routine:app::f(int4,text)': ['drop@1'],
      'routine:public::g': ['drop@1'],
      'routine:app::h(int8)': ['drop@2'],
      'trigger:app::orders::t': ['drop@4'],
    });
  });

  it('knows which imports make a client, by what the client runs', () => {
    const builders = sqlClients('builder');
    const text = sqlClients('text');
    expect([...builders.keys()]).toEqual(['supabase', 'knex', 'kysely']);
    expect([...text.keys()]).toEqual(['knex', 'slonik', 'drizzle', 'kysely', 'postgres', 'pg']);
    expect(builders.get('kysely')!.packages).toEqual({ kysely: ['Kysely'] });
    expect(text.get('kysely')!.packages).toEqual({ kysely: ['sql'] });
    expect(text.get('knex')!.methods).toEqual(['raw']);
  });
});
