import { sql, type Kysely } from 'kysely';

// One row per Idempotency-Key and route. `claim` names the request that holds the key, so a request that was taken
// over can't record its response on top of the one that took it.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table idempotency_keys (
      scope text not null,
      key text not null,
      request_hash text not null,
      claim uuid not null,
      state text not null check (state in ('in_flight', 'done')),
      status_code integer,
      response text,
      created_at timestamptz not null,
      expires_at timestamptz not null,
      primary key (scope, key)
    )
  `.execute(db);
  await sql`create index idempotency_keys_expires_idx on idempotency_keys (expires_at)`.execute(db);
}
