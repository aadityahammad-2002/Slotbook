import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type DB = Pick<PoolClient, 'query'>;
export const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL missing. Set your local PostgreSQL credentials in .env.');
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error('DATABASE_URL is malformed. Check .env and URL-encode special characters in the password.'); }
  if(!['postgresql:','postgres:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username)
    throw new Error('DATABASE_URL must contain a PostgreSQL host, username and database path.');
  const actualName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  // The integration suite overrides DATABASE_URL with TEST_DATABASE_URL; don't allow
  // the normal development database guard to reject the isolated test database.
  if(process.env.NODE_ENV==='test' && !actualName.endsWith('_test'))
    throw new Error('DATABASE SAFETY: tests must use a database ending with _test');
  const expectedName = process.env.NODE_ENV === 'test'
    ? process.env.EXPECTED_TEST_DATABASE_NAME
    : process.env.EXPECTED_DATABASE_NAME;
  if (expectedName && actualName !== expectedName) {
    throw new Error(`DATABASE SAFETY: expected database \"${expectedName}\" but DATABASE_URL selects \"${actualName}\". Refusing to connect or migrate.`);
  }
  if (value.includes('REPLACE_WITH_REAL_PASSWORD')) throw new Error('Replace the password placeholder in your local .env before starting.');
  return value;
};
export const pool = new pg.Pool({ connectionString: databaseUrl(), max: 20, connectionTimeoutMillis: 8000 });
export async function tx<T>(work: (db: PoolClient) => Promise<T>, p: pg.Pool = pool): Promise<T> {
  const c = await p.connect();
  try { await c.query('BEGIN'); const result = await work(c); await c.query('COMMIT'); return result; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
export async function migrate(p: pg.Pool = pool) {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    // Catch connections to a database left behind by an unrelated Slotbook implementation.
    // This check is read-only; it never drops or changes an existing legacy table.
    const legacy = await c.query<{type: string}>(`SELECT format_type(a.atttypid,a.atttypmod) AS type
      FROM pg_attribute a JOIN pg_class cls ON cls.oid=a.attrelid
      JOIN pg_namespace ns ON ns.oid=cls.relnamespace
      WHERE ns.nspname=current_schema() AND cls.relname='hosts' AND a.attname='id'
        AND a.attnum>0 AND NOT a.attisdropped`);
    if (legacy.rows.length && legacy.rows[0].type !== 'uuid') {
      throw new Error(`DATABASE SAFETY: existing hosts.id is ${legacy.rows[0].type}, but this TypeScript application requires uuid. Refusing to run migrations. Check DATABASE_URL database name.`);
    }
    await c.query('SELECT pg_advisory_xact_lock(228930, 1)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())');
    const applied = await c.query('SELECT version FROM schema_migrations WHERE version=$1', ['001_initial']);
    if (!applied.rowCount) {
      const sql = readFileSync(resolve(process.cwd(), 'server/sql/001_initial.sql'), 'utf8');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(version) VALUES($1)', ['001_initial']);
    }
    const upgrade = await c.query('SELECT version FROM schema_migrations WHERE version=$1', ['002_booking_integrity']);
    if (!upgrade.rowCount) {
      const sql = readFileSync(resolve(process.cwd(), 'server/sql/002_booking_integrity.sql'), 'utf8');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(version) VALUES($1)', ['002_booking_integrity']);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
export async function one<T extends QueryResultRow = QueryResultRow>(db: DB, query: string, values: unknown[] = []): Promise<T | null> {
  const r = await db.query<T>(query, values); return r.rows[0] ?? null;
}
export async function dbNow(db: DB): Promise<Date> { const r = await one<{now: Date}>(db,'SELECT clock_timestamp() AS now'); return new Date(r!.now); }
export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export const invalid = (message: string): never => { throw new ApiError(400,'INVALID_REQUEST',message); };
export const conflict = (message: string): never => { throw new ApiError(409,'SLOT_UNAVAILABLE',message); };
export function pgError(e: unknown): ApiError | null {
  const code = (e as {code?:string}).code;
  if (code === '23P01' || code === '23505') return new ApiError(409,'CONFLICT','This slot or resource is no longer available. Refresh and choose another time.');
  if (code === '23514' || code === '23503') return new ApiError(409,'CONSTRAINT_VIOLATION','The requested change violates a booking constraint.');
  return null;
}
