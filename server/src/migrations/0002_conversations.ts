import { sql, type Kysely } from 'kysely';

// One row per question and its answer: a single status, and a retry stays on the same row.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table conversations (
      id uuid primary key default gen_random_uuid(),
      document_id uuid not null references documents (id) on delete cascade,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index conversations_document_idx on conversations (document_id, created_at)`.execute(
    db,
  );

  await sql`
    create table turns (
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid not null references conversations (id) on delete cascade,
      sequence integer not null,
      question text not null,
      status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
      stage text,
      outcome text check (outcome in ('answered', 'not_in_document', 'unsupported')),
      answer text,
      note text,
      quotes jsonb not null default '[]',
      search_question text,
      answer_path text,
      chat_model text,
      error_code text,
      debug jsonb,
      attempt integer not null default 1,
      heartbeat_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (conversation_id, sequence)
    )
  `.execute(db);
  // At most one unanswered question per conversation; a second one gets a 409 without a race.
  await sql`create unique index turns_one_pending_idx on turns (conversation_id) where status = 'pending'`.execute(
    db,
  );
}
