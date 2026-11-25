import { sql, type Kysely } from 'kysely';

// Uploaded PDFs are kept, so a failed extraction can be run again; they are never served back. The page map holds
// where each page starts and ends in the stored text.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table document_files (
      document_id uuid primary key references documents (id) on delete cascade,
      bytes bytea not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`alter table documents add column page_map jsonb`.execute(db);
}
