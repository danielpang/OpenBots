import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, type Db } from './client.js';
import { migrate } from './migrate.js';
import { createTestDb, type TestDb } from './test-db.js';

// A differential test: PGlite, which the server tests run on, against the
// real Postgres in DATABASE_URL, which production runs on. The same
// migrations and the same queries go to both, and any difference in the
// answers is either a bug or belongs in APPROVED below with its reason.
// It needs both databases, so it runs where DATABASE_URL is set (CI's
// `server-postgres` job, or docs/CONTRIBUTING.md's local Postgres).

/**
 * Differences that are expected, by catalog query. Add one only with the
 * reason it cannot matter to a test that passed on PGlite.
 */
const APPROVED: Record<string, (row: Record<string, unknown>) => boolean> = {
  // PGlite is a newer Postgres than the pg16 the images ship, and from 18 a
  // NOT NULL column is also listed as a constraint. The columns query still
  // compares `is_nullable` for every column.
  constraints: (row) => row.kind === 'n',
};

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);

const CATALOG = {
  columns: sql`
    select table_name, column_name, udt_name, is_nullable, column_default,
           character_maximum_length, is_generated, generation_expression
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, column_name`,
  indexes: sql`
    select tablename, indexname, indexdef from pg_indexes
    where schemaname = 'public' order by tablename, indexname`,
  constraints: sql`
    select rel.relname as table_name, con.conname, con.contype::text as kind,
           pg_get_constraintdef(con.oid) as definition
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
    order by rel.relname, con.conname`,
  rowSecurity: sql`
    select relname, relrowsecurity, relforcerowsecurity from pg_class rel
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public' and rel.relkind = 'r' order by relname`,
  policies: sql`
    select tablename, policyname, cmd, qual, with_check from pg_policies
    where schemaname = 'public' order by tablename, policyname`,
  enums: sql`
    select t.typname, e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
    order by t.typname, e.enumsortorder`,
} as const;

describe.skipIf(!process.env.DATABASE_URL)('PGlite against Postgres', () => {
  let real: TestDb;
  let lite: PGlite;
  let liteDb: Db;

  beforeAll(async () => {
    real = await createTestDb();
    lite = new PGlite({ extensions: { vector } });
    liteDb = drizzle(lite, { schema }) as unknown as Db;
    await migrate(liteDb);
  }, 120_000);

  afterAll(async () => {
    await real?.close();
    await lite?.close();
  });

  it('runs the comparison against a real server', () => {
    expect(real.kind).toBe('postgres');
  });

  for (const [name, query] of Object.entries(CATALOG)) {
    it(`the migrations build the same ${name} on both`, async () => {
      const keep = (row: Record<string, unknown>) => !APPROVED[name]?.(row);
      const onLite = rowsOf(await liteDb.execute(query)).filter(keep);
      const onReal = rowsOf(await real.db.execute(query)).filter(keep);
      expect(onLite).toEqual(onReal);
    });
  }

  // The same generated values through expressions the server's queries rely
  // on. A difference here is one a PGlite test cannot see: an ordering or a
  // comparison that changes with the server's collation or version.
  const literal = (values: string[]) =>
    sql.raw(`array[${values.map((v) => `'${v.replaceAll("'", "''")}'`).join(',')}]::text[]`);
  // No NUL (Postgres text refuses it) and no backslash, so the literal reads
  // the same with either setting of standard_conforming_strings.
  const safe = (v: string) => !v.includes('\0') && !v.includes('\\');

  it('measures, hashes and orders any generated text the same way', async () => {
    const run = async (db: Db, values: string[]) =>
      rowsOf(
        await db.execute(sql`
          select v, length(v) as chars, octet_length(v) as bytes, md5(v) as digest
          from unnest(${literal(values)}) as t(v)
          order by v collate "C"`),
      );
    const text = fc.string({ unit: 'grapheme', maxLength: 12 }).filter(safe);
    await fc.assert(
      fc.asyncProperty(fc.array(text, { minLength: 1, maxLength: 20 }), async (values) => {
        expect(await run(liteDb, values)).toEqual(await run(real.db, values));
      }),
      { numRuns: 40 },
    );
  }, 120_000);

  // Known difference, found by this test: PGlite folds case for ASCII only
  // (lower('\u24B6') stays as it is), where a server with a UTF-8 locale
  // folds every letter. So a PGlite test cannot show that lower() or ILIKE
  // treats non-ASCII text as the server will; compare such text in code, or
  // test it on real Postgres. ASCII text must agree.
  it('folds and matches the case of ASCII text the same way', async () => {
    const run = async (db: Db, values: string[]) =>
      rowsOf(
        await db.execute(sql`
          select v, lower(v) as lowered, upper(v) as raised, v ilike 'a%' as starts_with_a
          from unnest(${literal(values)}) as t(v)
          order by v collate "C"`),
      );
    const text = fc.string({ unit: 'binary-ascii', maxLength: 12 }).filter(safe);
    await fc.assert(
      fc.asyncProperty(fc.array(text, { minLength: 1, maxLength: 20 }), async (values) => {
        expect(await run(liteDb, values)).toEqual(await run(real.db, values));
      }),
      { numRuns: 40 },
    );
  }, 120_000);

  it('rounds, divides and compares generated numbers and times the same way', async () => {
    const run = async (db: Db, a: number, b: number, at: string) =>
      rowsOf(
        await db.execute(sql`
          select (${a}::int / ${b}::int) as quotient,
                 (${a}::int % ${b}::int) as remainder,
                 round(${a}::numeric / ${b}::numeric, 6)::text as ratio,
                 date_trunc('minute', ${at}::timestamptz at time zone 'UTC')::text as minute,
                 extract(epoch from ${at}::timestamptz)::bigint::text as epoch,
                 (${at}::timestamptz + make_interval(mins => ${b}::int))::timestamptz at time zone 'UTC' as later`),
      ).map((row) => ({ ...row, later: String(new Date(String(row.later)).getTime()) }));
    const whole = fc.integer({ min: -1_000_000, max: 1_000_000 });
    const moment = fc
      .date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true })
      .map((d) => d.toISOString());
    await fc.assert(
      fc.asyncProperty(
        whole,
        whole.filter((n) => n !== 0),
        moment,
        async (a, b, at) => {
          expect(await run(liteDb, a, b, at)).toEqual(await run(real.db, a, b, at));
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);
});
