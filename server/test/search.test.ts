import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { rankPassages, searchDocument, toVector } from '../src/search.js';

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
    // Nearest to this vector, Delta (about 400 tokens) ranks third, after Alpha and Gamma (which have the word), and
    // doesn't fit within 40 tokens; Beta, ranked after it, still does.
    const picked = await searchDocument(db, documentId, 'lighthouse', [0.8, 0.2, 0], 40);
    // Picked best-first (Gamma, then Alpha and Beta), sent in document order.
    expect(picked.map(firstWord)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
  it('returns the passages in document order, and a short document whole', async () => {
    const all = await searchDocument(db, documentId, 'lighthouse', [1, 0, 0], 4_000);
    expect(all.map(firstWord)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  it('sends a short document whole even when it has more passages than either ranking keeps', async () => {
    const doc = await db
      .insertInto('documents')
      .values({
        title: 'many',
        format: 'text',
        content: '',
        status: 'ready',
        embedding_model: 'test',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    try {
      await db
        .insertInto('chunks')
        .values(
          // Stored last passage first; they must still come back in document order. (The query reads them through
          // the (document, ordinal) index, which gives that order too, so this can't show a missing order by.)
          Array.from({ length: 30 }, (_, ordinal) => ({
            document_id: doc.id,
            ordinal,
            start_offset: ordinal * 40,
            end_offset: ordinal * 40 + 30,
            text: `Passage number ${ordinal} of the list.`,
            embedding: toVector([1, ordinal, 0]),
          })).reverse(),
        )
        .execute();
      // No passage has the word, and the vector ranking keeps only its top 20. A budget of exactly the
      // document's size still takes it whole; one token less leaves ranking to choose.
      const total = Array.from({ length: 30 }, (_, n) =>
        Math.ceil(`Passage number ${n} of the list.`.length / 4),
      ).reduce((a, b) => a + b, 0);
      const whole = await searchDocument(db, doc.id, 'zebra', [1, 0, 0], total);
      expect(whole.map((p) => p.ordinal)).toEqual([...Array(30).keys()]);
      expect(await searchDocument(db, doc.id, 'zebra', [1, 0, 0], total - 1)).toHaveLength(20);
    } finally {
      await db.deleteFrom('documents').where('id', '=', doc.id).execute();
    }
  });
});

describe('rankPassages', () => {
  it('gives each passage its keyword and meaning ranks next to the fused order', async () => {
    const ranked = await rankPassages(db, documentId, 'lighthouse', [1, 0, 0]);
    const byWord = Object.fromEntries(ranked.map((p) => [firstWord(p), p]));
    expect(byWord.Gamma).toMatchObject({ meaningRank: 1 });
    expect(byWord.Gamma!.keywordRank).not.toBeNull();
    expect(byWord.Beta).toMatchObject({ keywordRank: null, meaningRank: 2 });
    expect(firstWord(ranked[0]!)).toBe('Gamma');
  });

  it('ranks the passage matching more of the question first by keyword', async () => {
    // Only Gamma has both words.
    const ranked = await rankPassages(db, documentId, 'lighthouse keeper', [0, 0, 1]);
    const byWord = Object.fromEntries(ranked.map((p) => [firstWord(p), p]));
    expect(byWord.Gamma!.keywordRank).toBe(1);
    expect(byWord.Alpha!.keywordRank).toBe(2);
  });
});
