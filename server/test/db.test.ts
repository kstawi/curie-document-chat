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

// What a Postgres restart, or the OOM killer taking a backend, looks like from the app's side.
async function terminateAppConnections() {
  const admin = new pg.Client({ connectionString: loadConfig().DATABASE_URL });
  await admin.connect();
  await admin.query(
    `select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'drop-test'`,
  );
  await admin.end();
}

describe('database pool', () => {
  it('survives Postgres dropping an idle connection', async () => {
    const before = errors.length;
    await sql`select 1`.execute(db); // leaves an idle client in the pool
    await terminateAppConnections();

    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(before));
    const { rows } = await sql<{ ok: number }>`select 1 as ok`.execute(db);
    expect(rows[0]?.ok).toBe(1);
  });

  it('survives Postgres dropping a connection the app is holding', async () => {
    const before = errors.length;
    await db.connection().execute(async (conn) => {
      await sql`select 1`.execute(conn);
      await terminateAppConnections();
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(before));
    });

    const { rows } = await sql<{ ok: number }>`select 1 as ok`.execute(db);
    expect(rows[0]?.ok).toBe(1);
  });

  it('fails the query in flight, not the process, when its connection drops', async () => {
    const before = errors.length;
    const slow = sql`select pg_sleep(5)`.execute(db);
    slow.catch(() => {}); // asserted below; this only stops an early rejection counting as unhandled
    await vi.waitFor(async () => {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from pg_stat_activity
        where application_name = 'drop-test' and query like '%pg_sleep%' and state = 'active'
          and pid <> pg_backend_pid()
      `.execute(db);
      expect(rows[0]?.n).toBe(1);
    });
    await terminateAppConnections();

    await expect(slow).rejects.toThrow();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(before));
    const { rows } = await sql<{ ok: number }>`select 1 as ok`.execute(db);
    expect(rows[0]?.ok).toBe(1);
  });
});
