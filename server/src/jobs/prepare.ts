import { ERROR_MESSAGES, type ErrorCode } from '../errors.js';
import { ModelError } from '../model.js';
import type { PrepareJob } from '../queue.js';
import { toVector } from '../search.js';
import { extractPdf, ParserUnavailable, PdfFailure } from '../pdf/client.js';
import { chunkPages, chunkText } from '../text/chunk.js';
import { forModel, isBlank } from '../text/clean.js';
import { ShutdownAbort, startHeartbeat, type JobContext, type JobDeps } from './deps.js';

// Keeps each insert statement, and the vector text built for it, to a modest size.
const INSERT_BATCH = 500;
// Enough context for the embedding without letting a deep or long heading path crowd out the passage itself.
const MAX_EMBEDDED_PATH_CHARS = 300;
// With a 1 MB upload or a 100-page PDF and small sections packed together, real documents stay well under this;
// past it something is odd about the file, and it is refused rather than embedded for minutes.
const MAX_CHUNKS = 5_000;

class StaleJob extends Error {}

class PrepareError extends Error {
  constructor(readonly code: 'empty_document' | 'too_many_passages') {
    super(ERROR_MESSAGES[code]);
  }
}

// Chunks and embeds a document, then marks it ready, all or nothing; a PDF's text is extracted first. Every update is
// guarded by status and attempt: a stale job (deleted row, newer attempt) changes nothing, and a job run again after
// a crash redoes the same work.
export async function prepareDocument(
  { db, model, config }: JobDeps,
  { documentId, attempt }: PrepareJob,
  { signal, shutdown, lastAttempt, log }: JobContext,
) {
  const doc = await db
    .updateTable('documents')
    .set({ status: 'processing', heartbeat_at: new Date(), updated_at: new Date() })
    .where('id', '=', documentId)
    .where('attempt', '=', attempt)
    .where('status', 'in', ['queued', 'processing'])
    .returning(['content', 'format', 'page_map'])
    .executeTakeFirst();
  if (!doc) {
    log.info({ documentId, attempt }, 'skipped a stale preparation job');
    return;
  }
  const stopHeartbeat = startHeartbeat(
    () =>
      db
        .updateTable('documents')
        .set({ heartbeat_at: new Date() })
        .where('id', '=', documentId)
        .where('attempt', '=', attempt)
        .where('status', '=', 'processing')
        .execute(),
    config.HEARTBEAT_MS,
    log,
  );

  // Set while the PDF is with the parser, so a run cut off then is labelled as such.
  let reading = false;
  try {
    let content = doc.content ?? '';
    let pages = doc.page_map;
    // Extracted once: a PDF that already has text (re-embedded after a model change) keeps it, so the offsets of
    // earlier answers' quotes stay valid.
    const extract = doc.format === 'pdf' && doc.content === null;
    if (extract) {
      reading = true;
      const file = await db
        .selectFrom('document_files')
        .select('bytes')
        .where('document_id', '=', documentId)
        .executeTakeFirstOrThrow();
      ({ content, pages } = await extractPdf(
        config.PDF_PARSER_URL,
        file.bytes,
        signal,
        config.PDF_PARSER_TIMEOUT_MS,
      ));
      reading = false;
    }
    // Indexed and embedded as the chat model reads it; the offsets still point into the stored text. A chunk with
    // nothing visible left is skipped.
    const chunks = (pages ? chunkPages(content, pages) : chunkText(content))
      .map((c) => ({ ...c, text: forModel(c.text), headingPath: forModel(c.headingPath) }))
      .filter((c) => !isBlank(c.text));
    if (chunks.length === 0) throw new PrepareError('empty_document');
    if (chunks.length > MAX_CHUNKS) throw new PrepareError('too_many_passages');
    // The heading path goes into what is embedded, so a passage carries the context of its section.
    const vectors = await model.embed(
      chunks.map((c) =>
        c.headingPath
          ? `${[...c.headingPath].slice(0, MAX_EMBEDDED_PATH_CHARS).join('')}\n\n${c.text}`
          : c.text,
      ),
      'document',
      signal,
    );
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('chunks').where('document_id', '=', documentId).execute();
      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        await trx
          .insertInto('chunks')
          .values(
            chunks.slice(i, i + INSERT_BATCH).map((c, j) => ({
              document_id: documentId,
              ordinal: c.ordinal,
              start_offset: c.start,
              end_offset: c.end,
              heading_path: c.headingPath,
              text: c.text,
              embedding: toVector(vectors[i + j]!),
            })),
          )
          .execute();
      }
      const ready = await trx
        .updateTable('documents')
        .set({
          status: 'ready',
          ...(extract ? { content, page_map: JSON.stringify(pages) } : {}),
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
    if (shutdown.aborted && (err instanceof ModelError ? err.kind === 'aborted' : signal.aborted)) {
      throw new ShutdownAbort();
    }
    // A server that is down, overloaded or stuck: BullMQ runs the job again after a backoff.
    const temporary =
      err instanceof ParserUnavailable ||
      (err instanceof ModelError && (err.kind === 'unavailable' || err.kind === 'timeout'));
    if (temporary && !lastAttempt) {
      log.warn({ documentId, err: err.message }, 'preparation will be retried');
      throw err;
    }
    // A passage too long for the embedding model is a chunking bug, not something the model got wrong.
    const code: ErrorCode =
      err instanceof ModelError
        ? err.kind === 'context'
          ? 'internal_error'
          : err.code
        : err instanceof PrepareError || err instanceof PdfFailure
          ? err.code
          : err instanceof ParserUnavailable
            ? 'pdf_parser_unavailable'
            : // Cut off by the job's own time limit while the PDF was being read.
              reading && signal.aborted
              ? 'pdf_parse_timeout'
              : 'internal_error';
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
  } finally {
    stopHeartbeat();
  }
}
