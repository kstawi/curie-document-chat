import { sql, type Kysely } from 'kysely';

// How many times the sweeper has queued a row again since it was created or last retried by a user. It is kept
// apart from `attempt`, which also moves on a user's retry, so the sweeper's cap never blocks a retry.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table documents add column requeues integer not null default 0`.execute(db);
  await sql`alter table turns add column requeues integer not null default 0`.execute(db);
}
