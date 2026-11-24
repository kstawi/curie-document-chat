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

// Hybrid search within one document. Full-text rank and vector distance each pick their top candidates, merged by
// reciprocal rank fusion. The keyword query ORs the question's words; Postgres builds it from the raw text, so no
// tsquery syntax is ever assembled here. A question with only stop words gives an empty keyword list, and the vector
// ranking decides alone. Passages fill the token budget best-first, then come back in document order.
export async function searchDocument(
  db: Kysely<Database>,
  documentId: string,
  question: string,
  questionEmbedding: number[],
  budgetTokens: number,
): Promise<Passage[]> {
  const { rows } = await sql<Passage & { score: number }>`
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
      coalesce(1.0 / (${RRF_K} + k.rank), 0) + coalesce(1.0 / (${RRF_K} + s.rank), 0) as score
    from chunks c
    left join keyword k on k.id = c.id
    left join semantic s on s.id = c.id
    where c.document_id = ${documentId} and (k.id is not null or s.id is not null)
    order by score desc, c.ordinal
  `.execute(db);

  const picked: Passage[] = [];
  let used = 0;
  for (const passage of rows) {
    const tokens = estimateTokens(passage.text);
    if (picked.length > 0 && used + tokens > budgetTokens) continue;
    picked.push(passage);
    used += tokens;
  }
  return picked.sort((a, b) => a.ordinal - b.ordinal);
}
