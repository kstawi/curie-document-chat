import { sql } from 'kysely';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrateToLatest } from '../src/migrate.js';

// Creates the test database on first use, then brings it to the latest migration.
export default async function setup() {
  const { DATABASE_URL } = loadConfig();
  const url = new URL(DATABASE_URL);
  const name = url.pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${name}": the database name must end in _test`);
  }

  const admin = new pg.Client({
    connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).href,
  });
  await admin.connect();
  const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name]);
  if (!rowCount) await admin.query(`create database "${name}"`);
  await admin.end();

  const db = createDb(DATABASE_URL);
  await migrateToLatest(db);
  // Each run starts from empty tables, so rows that earlier runs left unfinished don't build up for the sweeper.
  await sql`truncate documents cascade`.execute(db);
  await db.destroy();
}
