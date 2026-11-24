import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { ERROR_MESSAGES, type ErrorCode } from '../errors.js';
import { ModelError, type Model } from '../model.js';
import type { PrepareJob } from '../queue.js';
import { toVector } from '../search.js';
import { chunkText } from '../text/chunk.js';

export interface JobDeps {
  db: Kysely<Database>;
  model: Model;
  log: Logger;
  config: Config;
}

class StaleJob extends Error {}

class PrepareError extends Error {
  constructor(readonly code: 'empty_document') {
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
    // The heading path goes into what is embedded, so a passage carries the context of its section.
    const vectors = await model.embed(
      chunks.map((c) => (c.headingPath ? `${c.headingPath}\n\n${c.text}` : c.text)),
      'document',
    );
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('chunks').where('document_id', '=', documentId).execute();
      await trx
        .insertInto('chunks')
        .values(
          chunks.map((c, i) => ({
            document_id: documentId,
            ordinal: c.ordinal,
            start_offset: c.start,
            end_offset: c.end,
            heading_path: c.headingPath,
            text: c.text,
            embedding: toVector(vectors[i]!),
          })),
        )
        .execute();
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
