import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';

const url = new URL(loadConfig().DATABASE_URL);
url.searchParams.set('application_name', 'drop-test');

const errors: Error[] = [];
const db = createDb(url.href, (err) => errors.push(err));
afterAll(() => db.destroy());

// Watches and kills the pool's connections from outside the pool, as a Postgres restart or the OOM killer would.
async function admin<T>(query: string): Promise<pg.QueryResult<T & pg.QueryResultRow>> {
  const client = new pg.Client({ connectionString: loadConfig().DATABASE_URL });
  await client.connect();
  try {
    return await client.query<T & pg.QueryResultRow>(query);
  } finally {
    await client.end();
  }
}

const terminateAppConnections = async () =>
  (
    await admin(
      `select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'drop-test'`,
    )
  ).rowCount ?? 0;

// A query sent before the pool has heard about every dropped connection can still land on one of them, so each
// test waits until the pool has reported all of them.
const allReported = async (before: number, terminated: number) => {
  expect(terminated).toBeGreaterThan(0);
  await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(before + terminated));
};

describe('database pool', () => {
  it('survives Postgres dropping an idle connection', async () => {
    const before = errors.length;
    await sql`select 1`.execute(db); // leaves an idle client in the pool
    await allReported(before, await terminateAppConnections());
    const { rows } = await sql<{ ok: number }>`select 1 as ok`.execute(db);
    expect(rows[0]?.ok).toBe(1);
  });

  it('survives Postgres dropping a connection the app is holding', async () => {
    const before = errors.length;
    await db.connection().execute(async (conn) => {
      await sql`select 1`.execute(conn);
      await allReported(before, await terminateAppConnections());
    });
    const { rows } = await sql<{ ok: number }>`select 1 as ok`.execute(db);
    expect(rows[0]?.ok).toBe(1);
  });

  it('fails the query in flight, not the process, when its connection drops', async () => {
    const before = errors.length;
    const slow = sql`select pg_sleep(5)`.execute(db);
    slow.catch(() => {}); // asserted below; this only stops an early rejection counting as unhandled
    await vi.waitFor(async () => {
      const { rows } = await admin<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
         where application_name = 'drop-test' and query like '%pg_sleep(5)%' and state = 'active'`,
      );
      expect(rows[0]?.n).toBe(1);
    });
    const terminated = await terminateAppConnections();

    await expect(slow).rejects.toThrow();
    await allReported(before, terminated);
    const { rows } = await sql<{ ok: number }>`select 1 as ok`.execute(db);
    expect(rows[0]?.ok).toBe(1);
  });
});
