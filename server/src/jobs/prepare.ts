import { ERROR_MESSAGES, type ErrorCode } from '../errors.js';
import { ModelError } from '../model.js';
import type { PrepareJob } from '../queue.js';
import { toVector } from '../search.js';
import { chunkText } from '../text/chunk.js';
import type { JobDeps } from './deps.js';

// Keeps each insert statement, and the vector text built for it, to a modest size.
const INSERT_BATCH = 500;
// Enough context for the embedding without letting a deep or long heading path crowd out the passage itself.
const MAX_EMBEDDED_PATH_CHARS = 300;
// With a 1 MB upload and small sections packed together, real documents stay well under this; past it something
// is odd about the file, and it is refused rather than embedded for minutes.
const MAX_CHUNKS = 5_000;

class StaleJob extends Error {}

class PrepareError extends Error {
  constructor(readonly code: 'empty_document' | 'too_many_passages') {
    super(ERROR_MESSAGES[code]);
  }
}

// Chunks and embeds a document, then marks it ready, all or nothing. Every update is guarded by status and attempt:
// a stale job (deleted row, newer attempt) changes nothing, and a job run again after a crash redoes the same work.
export async function prepareDocument(
  { db, model, log }: JobDeps,
  { documentId, attempt }: PrepareJob,
) {
  const doc = await db
    .updateTable('documents')
    .set({ status: 'processing', heartbeat_at: new Date(), updated_at: new Date() })
    .where('id', '=', documentId)
    .where('attempt', '=', attempt)
    .where('status', 'in', ['queued', 'processing'])
    .returning(['content'])
    .executeTakeFirst();
  if (!doc) {
    log.info({ documentId, attempt }, 'skipped a stale preparation job');
    return;
  }

  try {
    const chunks = chunkText(doc.content ?? '');
    if (chunks.length === 0) throw new PrepareError('empty_document');
    if (chunks.length > MAX_CHUNKS) throw new PrepareError('too_many_passages');
    // The heading path goes into what is embedded, so a passage carries the context of its section.
    const vectors = await model.embed(
      chunks.map((c) =>
        c.headingPath ? `${c.headingPath.slice(0, MAX_EMBEDDED_PATH_CHARS)}\n\n${c.text}` : c.text,
      ),
      'document',
    );
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('chunks').where('document_id', '=', documentId).execute();
      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        await trx
          .insertInto('chunks')
          .values(
            chunks.slice(i, i + INSERT_BATCH).map((c) => ({
              document_id: documentId,
              ordinal: c.ordinal,
              start_offset: c.start,
              end_offset: c.end,
              heading_path: c.headingPath,
              text: c.text,
              embedding: toVector(vectors[c.ordinal]!),
            })),
          )
          .execute();
      }
      const ready = await trx
        .updateTable('documents')
        .set({
          status: 'ready',
          embedding_model: model.embeddingModel,
          error_code: null,
          error_message: null,
          updated_at: new Date(),
        })
        .where('id', '=', documentId)
        .where('attempt', '=', attempt)
        .where('status', '=', 'processing')
        .executeTakeFirst();
      if (!ready.numUpdatedRows) throw new StaleJob();
    });
    log.info({ documentId, chunks: chunks.length }, 'document ready');
  } catch (err) {
    if (err instanceof StaleJob) return;
    const code: ErrorCode =
      err instanceof ModelError || err instanceof PrepareError ? err.code : 'internal_error';
    log.warn({ documentId, code, err: (err as Error).message }, 'preparation failed');
    await db
      .updateTable('documents')
      .set({
        status: 'failed',
        error_code: code,
        error_message: ERROR_MESSAGES[code],
        updated_at: new Date(),
      })
      .where('id', '=', documentId)
      .where('attempt', '=', attempt)
      .where('status', '=', 'processing')
      .execute();
  }
}
