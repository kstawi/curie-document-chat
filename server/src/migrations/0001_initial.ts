import { sql, type Kysely } from 'kysely';

// Written as SQL rather than with the schema builder: generated columns, checks and pgvector read more clearly here.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`create extension if not exists vector`.execute(db);

  await sql`
    create table documents (
      id uuid primary key default gen_random_uuid(),
      title text not null,
      format text not null check (format in ('markdown', 'text', 'pdf')),
      content text,
      status text not null default 'queued'
        check (status in ('queued', 'processing', 'ready', 'failed')),
      error_code text,
      error_message text,
      attempt integer not null default 1,
      heartbeat_at timestamptz,
      embedding_model text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);

  // The embedding column has no fixed size, so documents embedded by different models (768, 1536 or 3072
  // dimensions) can live side by side. Search is exact and scoped to one document, so no vector index is needed.
  await sql`
    create table chunks (
      id bigint generated always as identity primary key,
      document_id uuid not null references documents (id) on delete cascade,
      ordinal integer not null,
      start_offset integer not null,
      end_offset integer not null check (end_offset > start_offset),
      heading_path text not null default '',
      text text not null,
      tsv tsvector generated always as (to_tsvector('english', heading_path || ' ' || text)) stored,
      embedding vector,
      unique (document_id, ordinal)
    )
  `.execute(db);
  await sql`create index chunks_tsv_idx on chunks using gin (tsv)`.execute(db);
}
