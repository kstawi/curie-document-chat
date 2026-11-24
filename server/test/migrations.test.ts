import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrateToLatest } from '../src/migrate.js';

const db = createDb(loadConfig().DATABASE_URL);

afterAll(() => db.destroy());
beforeEach(() => sql`truncate documents cascade`.execute(db));

// A unit vector pointing along one axis, written in pgvector's text form.
const axis = (dims: number, index: number) =>
  `[${Array.from({ length: dims }, (_, i) => (i === index ? 1 : 0)).join(',')}]`;

describe('migrations', () => {
  it('can run again without applying anything twice', async () => {
    const applied = () =>
      sql<{ n: number }>`select count(*)::int as n from kysely_migration`.execute(db);
    const before = (await applied()).rows[0]?.n;
    await migrateToLatest(db);
    expect((await applied()).rows[0]?.n).toBe(before);
    expect(before).toBeGreaterThan(0);
  });

  it('stores embeddings of different sizes and searches within one document', async () => {
    // Sizes of the models the app may be configured with: nomic (768), OpenAI small (1536), Gemini (3072).
    for (const dims of [768, 1536, 3072]) {
      const { id } = await db
        .insertInto('documents')
        .values({
          title: `doc-${dims}`,
          format: 'text',
          content: 'alpha beta',
          embedding_model: `m-${dims}`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('chunks')
        .values([
          {
            document_id: id,
            ordinal: 0,
            start_offset: 0,
            end_offset: 5,
            text: 'alpha',
            embedding: axis(dims, 0),
          },
          {
            document_id: id,
            ordinal: 1,
            start_offset: 6,
            end_offset: 10,
            text: 'beta',
            embedding: axis(dims, 1),
          },
        ])
        .execute();

      const nearest = await db
        .selectFrom('chunks')
        .select('text')
        .where('document_id', '=', id)
        .orderBy(sql`embedding <=> ${axis(dims, 1)}::vector`)
        .executeTakeFirstOrThrow();
      expect(nearest.text).toBe('beta');
    }
  });

  it('fills the full-text column from the heading and the text', async () => {
    const text = 'Keyword search returned a relevant passage.';
    const { id } = await db
      .insertInto('documents')
      .values({ title: 'ft', format: 'markdown', content: text })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('chunks')
      .values({
        document_id: id,
        ordinal: 0,
        start_offset: 0,
        end_offset: text.length,
        heading_path: 'Results',
        text,
      })
      .execute();

    const hit = await sql<{ n: number }>`
      select count(*)::int as n from chunks
      where document_id = ${id} and tsv @@ plainto_tsquery('english', 'results keywords')
    `.execute(db);
    expect(hit.rows[0]?.n).toBe(1);
  });
});
