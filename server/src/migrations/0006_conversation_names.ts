import { sql, type Kysely } from 'kysely';

// A conversation's name: its first question until the model names it, or the name a user gave it. `title_source`
// says which, so the model never overwrites a user's name and names a conversation only once.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table conversations
      add column title text,
      add column title_source text check (title_source in ('question', 'model', 'user')),
      add constraint conversations_title_check check ((title is null) = (title_source is null))
  `.execute(db);
  await nameFromFirstQuestions(db);
}

// Conversations from before: their first question (stored on one line already), cut as `nameFromQuestion` cuts.
export async function nameFromFirstQuestions(db: Kysely<any>): Promise<void> {
  await sql`
    update conversations c
    set title = case when char_length(t.question) > 60 then rtrim(left(t.question, 59)) || '…' else t.question end,
      title_source = 'question'
    from turns t
    where t.conversation_id = c.id and t.sequence = 1 and c.title is null
  `.execute(db);
}
