import { createHash } from 'node:crypto';
import multipart, { type MultipartFile } from '@fastify/multipart';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { DocumentsTable } from '../db.js';
import { HttpError } from '../errors.js';
import { withIdempotencyKey } from '../idempotency.js';
import { checkBackPressure, enqueue, jobId, queueUnavailable } from '../queue.js';
import { cleanTitle, decodeUpload, looksLikeMarkdown } from '../text/decode.js';

const MAX_TEXT_BYTES = 1024 * 1024;

const documentView = z.object({
  id: z.uuid(),
  title: z.string(),
  format: z.enum(['markdown', 'text', 'pdf']),
  status: z.enum(['queued', 'processing', 'ready', 'failed']),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const idParams = z.object({ id: z.uuid() });

const columns = [
  'id',
  'title',
  'format',
  'status',
  'error_code',
  'error_message',
  'created_at',
  'updated_at',
] as const;

const toView = (d: Pick<Selectable<DocumentsTable>, (typeof columns)[number]>) => ({
  id: d.id,
  title: d.title,
  format: d.format,
  status: d.status,
  error: d.error_code ? { code: d.error_code, message: d.error_message ?? '' } : null,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
});

export const documentRoutes: FastifyPluginAsyncZod<AppDeps> = async (
  app,
  { db, queues, embeddingModel, settings },
) => {
  await app.register(multipart, {
    // Enforced while the upload streams in; nothing beyond the limit is buffered.
    limits: {
      fileSize: MAX_TEXT_BYTES,
      files: 1,
      fields: 2,
      parts: 3,
      fieldSize: 1_000,
      headerPairs: 100,
    },
  });

  app.post(
    '/documents',
    { schema: { response: { 202: documentView } } },
    async (request, reply) => {
      let file: MultipartFile;
      let bytes: Buffer;
      try {
        const part = await request.file();
        if (!part)
          throw new HttpError(400, 'no_file', 'Send the document as a multipart "file" field.');
        file = part;
        bytes = await file.toBuffer();
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err instanceof app.multipartErrors.RequestFileTooLargeError) {
          throw new HttpError(
            413,
            'file_too_large',
            `The file is larger than ${MAX_TEXT_BYTES / 1024 / 1024} MB.`,
          );
        }
        if (err instanceof app.multipartErrors.InvalidMultipartContentTypeError) {
          throw new HttpError(415, 'unsupported_type', 'Send the document as multipart form data.');
        }
        // The parser's errors for a malformed or cut-off body carry no status code; they are the client's.
        if ((err as { statusCode?: number }).statusCode === undefined) {
          throw new HttpError(
            400,
            'invalid_request',
            'The upload is not valid multipart form data.',
          );
        }
        throw err;
      }
      const text = decodeUpload(bytes);
      const titleField = file.fields.title;
      const givenTitle =
        titleField && 'value' in titleField ? String(titleField.value) : file.filename;
      const title = cleanTitle(givenTitle, 'Untitled document');

      const fingerprint = {
        file: createHash('sha256').update(bytes).digest('hex'),
        name: file.filename,
        title: givenTitle,
      };
      return withIdempotencyKey({ db, settings, request, reply }, fingerprint, async (claim) => {
        await checkBackPressure(queues.prepare, settings.MAX_WAITING_DOCUMENTS);
        const doc = await db.transaction().execute(async (trx) => {
          const row = await trx
            .insertInto('documents')
            .values({ title, format: looksLikeMarkdown(text) ? 'markdown' : 'text', content: text })
            .returning(columns)
            .executeTakeFirstOrThrow();
          await claim.done(trx, 202, toView(row));
          return row;
        });
        try {
          await enqueue(queues.prepare, { documentId: doc.id, attempt: 1 }, jobId(doc.id, 1));
        } catch {
          // `enqueue` only fails when the queue is unavailable. Without a job the document would sit in "queued"
          // until the sweeper found it, so it is removed and the client told to retry.
          await db.deleteFrom('documents').where('id', '=', doc.id).execute();
          throw queueUnavailable();
        }
        return { status: 202, body: toView(doc) };
      });
    },
  );

  // Prepares a document again: one that failed, or one indexed with an embedding model other than the configured one.
  app.post(
    '/documents/:id/retry',
    { schema: { params: idParams, response: { 202: documentView } } },
    async (request, reply) =>
      withIdempotencyKey(
        { db, settings, request, reply },
        { params: request.params },
        async (claim) => {
          const doc = await db
            .selectFrom('documents')
            .select(['id', 'status', 'attempt', 'embedding_model', 'error_code', 'error_message'])
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!doc) throw new HttpError(404, 'not_found', 'No document with that id.');
          const notRetryable = () =>
            new HttpError(
              409,
              'not_retryable',
              'Only a failed document, or one indexed with another embedding model, can be prepared again.',
            );
          const otherModel = doc.status === 'ready' && doc.embedding_model !== embeddingModel;
          if (doc.status !== 'failed' && !otherModel) throw notRetryable();
          await checkBackPressure(queues.prepare, settings.MAX_WAITING_DOCUMENTS);

          const next = doc.attempt + 1;
          const updated = await db.transaction().execute(async (trx) => {
            const row = await trx
              .updateTable('documents')
              .set({
                status: 'queued',
                attempt: next,
                requeues: 0,
                error_code: null,
                error_message: null,
                heartbeat_at: null,
                updated_at: new Date(),
              })
              .where('id', '=', doc.id)
              .where('attempt', '=', doc.attempt)
              .where('status', '=', doc.status)
              .returning(columns)
              .executeTakeFirst();
            if (!row) throw notRetryable();
            await claim.done(trx, 202, toView(row));
            return row;
          });
          try {
            await enqueue(
              queues.prepare,
              { documentId: doc.id, attempt: next },
              jobId(doc.id, next),
            );
          } catch {
            // Back as it was, but on the new attempt: a job that lands late finds the row not queued and does nothing.
            await db
              .updateTable('documents')
              .set({
                status: doc.status,
                error_code: doc.error_code,
                error_message: doc.error_message,
              })
              .where('id', '=', doc.id)
              .where('attempt', '=', next)
              .where('status', '=', 'queued')
              .execute();
            throw queueUnavailable();
          }
          return { status: 202, body: toView(updated) };
        },
      ),
  );

  app.get(
    '/documents',
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.object({ items: z.array(documentView) }) },
      },
    },
    async (request) => {
      const rows = await db
        .selectFrom('documents')
        .select(columns)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(request.query.limit)
        .offset(request.query.offset)
        .execute();
      return { items: rows.map(toView) };
    },
  );

  app.get(
    '/documents/:id',
    { schema: { params: idParams, response: { 200: documentView } } },
    async (request) => {
      const doc = await db
        .selectFrom('documents')
        .select(columns)
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!doc) throw new HttpError(404, 'not_found', 'No document with that id.');
      return toView(doc);
    },
  );

  app.get(
    '/documents/:id/content',
    {
      schema: {
        params: idParams,
        response: {
          200: z.object({ id: z.uuid(), format: documentView.shape.format, content: z.string() }),
        },
      },
    },
    async (request) => {
      const doc = await db
        .selectFrom('documents')
        .select(['id', 'format', 'content'])
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!doc) throw new HttpError(404, 'not_found', 'No document with that id.');
      return { id: doc.id, format: doc.format, content: doc.content ?? '' };
    },
  );
};
