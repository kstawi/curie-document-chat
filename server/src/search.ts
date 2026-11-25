import { sql, type Kysely } from 'kysely';
import type { Database } from './db.js';
import { estimateTokens } from './text/chunk.js';

export interface Passage {
  id: string;
  ordinal: number;
  start: number;
  end: number;
  headingPath: string;
  text: string;
}

const CANDIDATES = 20;
// The usual constant for reciprocal rank fusion; it damps the difference between first and second place.
const RRF_K = 60;

export const toVector = (values: number[]) => `[${values.join(',')}]`;

export interface RankedPassage extends Passage {
  keywordRank: number | null;
  meaningRank: number | null;
  score: number;
}

// Hybrid ranking within one document. Full-text rank and vector distance each pick their top candidates, merged by
// reciprocal rank fusion; each passage keeps its two ranks too, so the benchmark can compare the three. The keyword
// query ORs the question's words; Postgres builds it from the raw text, so no tsquery syntax is ever assembled here.
// A question with only stop words gives an empty keyword list, and the vector ranking decides alone.
export async function rankPassages(
  db: Kysely<Database>,
  documentId: string,
  question: string,
  questionEmbedding: number[],
): Promise<RankedPassage[]> {
  const { rows } = await sql<RankedPassage>`
    with query as (
      select replace(plainto_tsquery('english', ${question})::text, '&', '|')::tsquery as q
    ),
    keyword as (
      select c.id, row_number() over (order by ts_rank_cd(c.tsv, query.q) desc, c.ordinal) as rank
      from chunks c, query
      where c.document_id = ${documentId} and c.tsv @@ query.q
      order by rank
      limit ${CANDIDATES}
    ),
    semantic as (
      select id, row_number() over (order by embedding <=> ${toVector(questionEmbedding)}::vector, ordinal) as rank
      from chunks
      where document_id = ${documentId}
      order by rank
      limit ${CANDIDATES}
    )
    select c.id, c.ordinal, c.start_offset as start, c.end_offset as "end",
      c.heading_path as "headingPath", c.text,
      k.rank::int as "keywordRank", s.rank::int as "meaningRank",
      (coalesce(1.0 / (${RRF_K} + k.rank), 0) + coalesce(1.0 / (${RRF_K} + s.rank), 0))::float8 as score
    from chunks c
    left join keyword k on k.id = c.id
    left join semantic s on s.id = c.id
    where c.document_id = ${documentId} and (k.id is not null or s.id is not null)
    order by score desc, c.ordinal
  `.execute(db);
  return rows;
}

// The passages sent with a question: best-first up to the token budget, then in document order. A document that
// fits the budget whole goes in whole; ranking alone could leave out a passage neither method put in its top
// candidates.
export async function searchDocument(
  db: Kysely<Database>,
  documentId: string,
  question: string,
  questionEmbedding: number[],
  budgetTokens: number,
): Promise<Passage[]> {
  // estimateTokens summed in SQL, where a character outside the basic plane (an emoji) counts once rather than
  // twice, so text full of them can go whole at up to twice the budget; the too-long fallback covers that.
  const { tokens } = await db
    .selectFrom('chunks')
    .select(sql<number>`coalesce(sum(ceil(char_length(text) / 4.0)), 0)::int`.as('tokens'))
    .where('document_id', '=', documentId)
    .executeTakeFirstOrThrow();
  if (tokens <= budgetTokens) {
    return db
      .selectFrom('chunks')
      .select([
        'id',
        'ordinal',
        'start_offset as start',
        'end_offset as end',
        'heading_path as headingPath',
        'text',
      ])
      .where('document_id', '=', documentId)
      .orderBy('ordinal')
      .execute();
  }

  const picked: Passage[] = [];
  let used = 0;
  for (const passage of await rankPassages(db, documentId, question, questionEmbedding)) {
    const tokens = estimateTokens(passage.text);
    if (picked.length > 0 && used + tokens > budgetTokens) continue;
    picked.push(passage);
    used += tokens;
  }
  return picked.sort((a, b) => a.ordinal - b.ordinal);
}
