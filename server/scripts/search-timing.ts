// Times search on a document at the 5,000-passage cap, with random vectors of the local model's size (768) and
// Gemini's (3,072). Everything happens in one transaction that is rolled back, so no rows are left behind.
// Usage: npm run timing -w server   (DATABASE_URL from .env)
import { sql } from 'kysely';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { rankPassages, searchDocument, toVector } from '../src/search.js';

const PASSAGES = 5_000;
const RUNS = 7;
const words =
  'harbor archive pilot search station tide salinity sensor battery radio gateway'.split(' ');
const db = createDb(loadConfig().DATABASE_URL);

class RollBack extends Error {}

const median = async (run: () => Promise<unknown>) => {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    await run();
    times.push(performance.now() - started);
  }
  return Math.round(times.sort((a, b) => a - b)[RUNS >> 1]!);
};

try {
  await db.transaction().execute(async (trx) => {
    for (const dims of [768, 3_072]) {
      const { id } = await trx
        .insertInto('documents')
        .values({
          title: 'timing',
          format: 'text',
          content: '',
          status: 'ready',
          embedding_model: 'x',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (let from = 0; from < PASSAGES; from += 250) {
        await trx
          .insertInto('chunks')
          .values(
            Array.from({ length: 250 }, (_, i) => {
              const n = from + i;
              const text = Array.from(
                { length: 200 },
                (_, k) => words[(n * 7 + k * 3) % words.length],
              ).join(' ');
              return {
                document_id: id,
                ordinal: n,
                start_offset: n * 2_000,
                end_offset: n * 2_000 + text.length,
                text,
                embedding: toVector(Array.from({ length: dims }, () => Math.random() - 0.5)),
              };
            }),
          )
          .execute();
      }
      await sql`analyze chunks`.execute(trx);
      const question = Array.from({ length: dims }, () => Math.random() - 0.5);
      const rank = await median(() => rankPassages(trx, id, 'tide sensor battery', question));
      const search = await median(() =>
        searchDocument(trx, id, 'tide sensor battery', question, 4_000),
      );
      console.log(
        `${PASSAGES} passages, ${dims} dimensions: rankPassages ${rank} ms, searchDocument ${search} ms (median of ${RUNS})`,
      );
    }
    throw new RollBack();
  });
} catch (err) {
  if (!(err instanceof RollBack)) throw err;
} finally {
  await db.destroy();
}
