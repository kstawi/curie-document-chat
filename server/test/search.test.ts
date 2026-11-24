import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { searchDocument, toVector } from '../src/search.js';

const db = createDb(loadConfig().DATABASE_URL);
let documentId: string;

// Three-dimensional embeddings keep the expected order easy to see. The question below is "lighthouse" with the
// embedding [1, 0, 0]:
//   keyword ranking: only "alpha" and "gamma" contain the word
//   vector ranking:  gamma (1,0,0), then beta (0.9,0.1,0), then alpha (0,1,0)
const chunks = [
  { text: 'Alpha mentions the lighthouse once, in passing.', embedding: [0, 1, 0] },
  { text: 'Beta talks about something else entirely.', embedding: [0.9, 0.1, 0] },
  { text: 'Gamma is the lighthouse keeper story.', embedding: [1, 0, 0] },
  {
    text: `Delta is long. ${'Filler words without the search term. '.repeat(40)}`,
    embedding: [0.8, 0.2, 0],
  },
];

beforeAll(async () => {
  const doc = await db
    .insertInto('documents')
    .values({
      title: 'search',
      format: 'text',
      content: '',
      status: 'ready',
      embedding_model: 'test',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  documentId = doc.id;
  let offset = 0;
  await db
    .insertInto('chunks')
    .values(
      chunks.map((c, ordinal) => {
        const start = offset;
        offset += c.text.length + 2;
        return {
          document_id: documentId,
          ordinal,
          start_offset: start,
          end_offset: start + c.text.length,
          text: c.text,
          embedding: toVector(c.embedding),
        };
      }),
    )
    .execute();
});

afterAll(async () => {
  await db.deleteFrom('documents').where('id', '=', documentId).execute();
  await db.destroy();
});

const firstWord = (p: { text: string }) => p.text.split(' ')[0];

describe('searchDocument', () => {
  it('ranks a passage found by both searches first', async () => {
    // A one-token budget keeps only the best-ranked passage.
    const top = await searchDocument(db, documentId, 'lighthouse', [1, 0, 0], 1);
    expect(top.map(firstWord)).toEqual(['Gamma']);
  });

  it('ranks a keyword match above the nearest vector', async () => {
    // Beta is the nearest by vector but lacks the word; Gamma, second by vector, has it.
    const top = await searchDocument(db, documentId, 'lighthouse', [0.9, 0.1, 0], 1);
    expect(top.map(firstWord)).toEqual(['Gamma']);
  });

  it('falls back to the vector ranking for a question with only stop words', async () => {
    const top = await searchDocument(db, documentId, 'what is the', [0, 1, 0], 1);
    expect(top.map(firstWord)).toEqual(['Alpha']);
  });

  it('skips a passage that would overflow the budget and keeps filling with smaller ones', async () => {
    // Delta (about 400 tokens) ranks above Alpha by vector but doesn't fit next to Gamma within 40 tokens.
    const picked = await searchDocument(db, documentId, 'lighthouse', [1, 0, 0], 40);
    expect(picked.map(firstWord)).not.toContain('Delta');
    expect(picked.map(firstWord)).toEqual(expect.arrayContaining(['Gamma', 'Alpha', 'Beta']));
  });

  it('returns the passages in document order, and a short document whole', async () => {
    const all = await searchDocument(db, documentId, 'lighthouse', [1, 0, 0], 4_000);
    expect(all.map(firstWord)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });
});
