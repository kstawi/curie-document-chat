import multipart from '@fastify/multipart';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { DocumentsTable } from '../db.js';
import { HttpError } from '../errors.js';
import { enqueue, jobId } from '../queue.js';
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

export const documentRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, { db, queues }) => {
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
      const file = await request.file();
      if (!file)
        throw new HttpError(400, 'no_file', 'Send the document as a multipart "file" field.');
      let bytes: Buffer;
      try {
        bytes = await file.toBuffer();
      } catch (err) {
        if (err instanceof app.multipartErrors.RequestFileTooLargeError) {
          throw new HttpError(
            413,
            'file_too_large',
            `The file is larger than ${MAX_TEXT_BYTES / 1024 / 1024} MB.`,
          );
        }
        throw err;
      }
      const text = decodeUpload(bytes);
      const titleField = file.fields.title;
      const title = cleanTitle(
        titleField && 'value' in titleField ? String(titleField.value) : file.filename,
        'Untitled document',
      );

      const doc = await db
        .insertInto('documents')
        .values({ title, format: looksLikeMarkdown(text) ? 'markdown' : 'text', content: text })
        .returning(columns)
        .executeTakeFirstOrThrow();
      try {
        await enqueue(queues.prepare, { documentId: doc.id, attempt: 1 }, jobId(doc.id, 1));
      } catch {
        // `enqueue` only fails when the queue is unavailable. Without a job the document would sit in "queued" for
        // good, so it is removed and the client told to retry.
        await db.deleteFrom('documents').where('id', '=', doc.id).execute();
        throw new HttpError(
          503,
          'queue_unavailable',
          'The job queue is unavailable. Try again shortly.',
        );
      }
      return reply.code(202).send(toView(doc));
    },
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
