import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { TurnsTable } from '../db.js';
import { ERROR_MESSAGES, HttpError, type ErrorCode } from '../errors.js';
import { withIdempotencyKey } from '../idempotency.js';
import { checkBackPressure, enqueue, jobId, queueUnavailable } from '../queue.js';

const idParams = z.object({ id: z.uuid() });

const conversationView = z.object({ id: z.uuid(), documentId: z.uuid(), createdAt: z.date() });

const quoteView = z.object({
  text: z.string(),
  start: z.number().int(),
  end: z.number().int(),
  line: z.number().int(),
  section: z.string(),
});

const turnView = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  sequence: z.number().int(),
  question: z.string(),
  status: z.enum(['pending', 'completed', 'failed']),
  stage: z.string().nullable(),
  outcome: z.enum(['answered', 'not_in_document', 'unsupported']).nullable(),
  answer: z.string().nullable(),
  // Only for "not_in_document": the model's own explanation, not backed by a quote.
  note: z.string().nullable(),
  quotes: z.array(quoteView),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  model: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const turnColumns = [
  'id',
  'conversation_id',
  'sequence',
  'question',
  'status',
  'stage',
  'outcome',
  'answer',
  'note',
  'quotes',
  'error_code',
  'chat_model',
  'created_at',
  'updated_at',
] as const;

type TurnRow = Pick<Selectable<TurnsTable>, (typeof turnColumns)[number]>;

const toTurnView = (t: TurnRow) => ({
  id: t.id,
  conversationId: t.conversation_id,
  sequence: t.sequence,
  question: t.question,
  status: t.status,
  stage: t.stage,
  outcome: t.outcome,
  answer: t.answer,
  note: t.note,
  quotes: t.quotes,
  error: t.error_code
    ? { code: t.error_code, message: ERROR_MESSAGES[t.error_code as ErrorCode] ?? '' }
    : null,
  model: t.chat_model,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
});

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';
const answerPending = () =>
  new HttpError(409, 'answer_pending', 'This conversation is still waiting for an answer.');

// The same refusals for asking a question and for retrying an answer.
function checkDocument(status: string, model: string | null, embeddingModel: string) {
  if (status === 'failed') {
    throw new HttpError(409, 'document_failed', ERROR_MESSAGES.document_failed);
  }
  if (status !== 'ready') {
    throw new HttpError(409, 'document_not_ready', ERROR_MESSAGES.document_not_ready);
  }
  if (model !== embeddingModel) {
    throw new HttpError(409, 'embedding_model_changed', ERROR_MESSAGES.embedding_model_changed);
  }
}

export const conversationRoutes: FastifyPluginAsyncZod<AppDeps> = async (
  app,
  { db, queues, embeddingModel, settings },
) => {
  app.post(
    '/documents/:id/conversations',
    { schema: { params: idParams, response: { 201: conversationView } } },
    async (request, reply) =>
      withIdempotencyKey(
        { db, settings, request, reply },
        { params: request.params },
        async (claim) => {
          const doc = await db
            .selectFrom('documents')
            .select('id')
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!doc) throw new HttpError(404, 'not_found', 'No document with that id.');
          const view = await db.transaction().execute(async (trx) => {
            const c = await trx
              .insertInto('conversations')
              .values({ document_id: doc.id })
              .returning(['id', 'document_id', 'created_at'])
              .executeTakeFirstOrThrow();
            const body = { id: c.id, documentId: c.document_id, createdAt: c.created_at };
            await claim.record(trx, 201, body);
            return body;
          });
          return { status: 201, body: view };
        },
      ),
  );

  app.get(
    '/documents/:id/conversations',
    {
      schema: {
        params: idParams,
        response: { 200: z.object({ items: z.array(conversationView) }) },
      },
    },
    async (request) => {
      const doc = await db
        .selectFrom('documents')
        .select('id')
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!doc) throw new HttpError(404, 'not_found', 'No document with that id.');
      const rows = await db
        .selectFrom('conversations')
        .select(['id', 'document_id', 'created_at'])
        .where('document_id', '=', request.params.id)
        .orderBy('created_at', 'desc')
        .execute();
      return {
        items: rows.map((c) => ({ id: c.id, documentId: c.document_id, createdAt: c.created_at })),
      };
    },
  );

  app.post(
    '/conversations/:id/messages',
    {
      schema: {
        params: idParams,
        body: z.strictObject({
          question: z
            .string()
            .trim()
            .min(1)
            .max(2_000)
            .refine((q) => !q.includes('\u0000'), 'The question contains a NUL character.'),
        }),
        response: { 202: turnView },
      },
    },
    async (request, reply) =>
      withIdempotencyKey(
        { db, settings, request, reply },
        { params: request.params, body: request.body },
        async (claim) => {
          const conversation = await db
            .selectFrom('conversations')
            .innerJoin('documents', 'documents.id', 'conversations.document_id')
            .select(['conversations.id', 'documents.status', 'documents.embedding_model'])
            .where('conversations.id', '=', request.params.id)
            .executeTakeFirst();
          if (!conversation) {
            throw new HttpError(404, 'not_found', 'No conversation with that id.');
          }
          checkDocument(conversation.status, conversation.embedding_model, embeddingModel);
          await checkBackPressure(queues.answer, settings.MAX_WAITING_ANSWERS);

          let turn: TurnRow;
          try {
            turn = await db.transaction().execute(async (trx) => {
              // The next sequence number and the insert in one statement. Two questions at once collide on a unique
              // index (one pending answer per conversation, one row per sequence) and the second gets a 409.
              const { rows } = await sql<TurnRow>`
                insert into turns (conversation_id, sequence, question)
                select ${conversation.id}, coalesce(max(sequence), 0) + 1, ${request.body.question}
                from turns where conversation_id = ${conversation.id}
                returning ${sql.join(turnColumns.map((c) => sql.ref(c)))}
              `.execute(trx);
              await claim.record(trx, 202, toTurnView(rows[0]!));
              return rows[0]!;
            });
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            throw answerPending();
          }
          try {
            await enqueue(queues.answer, { turnId: turn.id, attempt: 1 }, jobId(turn.id, 1));
          } catch {
            // `enqueue` only fails when the queue is unavailable. A pending row would lock the conversation (one
            // pending answer at a time), so it is removed.
            await db.transaction().execute(async (trx) => {
              await trx.deleteFrom('turns').where('id', '=', turn.id).execute();
              await claim.release(trx);
            });
            throw queueUnavailable();
          }
          return { status: 202, body: toTurnView(turn) };
        },
      ),
  );

  // Answers a failed question again. Only the conversation's latest question, so its answer never skips a later one.
  app.post(
    '/messages/:id/retry',
    { schema: { params: idParams, response: { 202: turnView } } },
    async (request, reply) =>
      withIdempotencyKey(
        { db, settings, request, reply },
        { params: request.params },
        async (claim) => {
          const turn = await db
            .selectFrom('turns')
            .innerJoin('conversations', 'conversations.id', 'turns.conversation_id')
            .innerJoin('documents', 'documents.id', 'conversations.document_id')
            .select([
              'turns.id',
              'turns.status',
              'turns.attempt',
              'turns.error_code',
              'documents.status as documentStatus',
              'documents.embedding_model as documentModel',
            ])
            .where('turns.id', '=', request.params.id)
            .executeTakeFirst();
          if (!turn) throw new HttpError(404, 'not_found', 'No message with that id.');
          const notRetryable = () =>
            new HttpError(
              409,
              'not_retryable',
              'Only the latest question of a conversation can be retried, and only after it failed.',
            );
          if (turn.status !== 'failed') throw notRetryable();
          checkDocument(turn.documentStatus, turn.documentModel, embeddingModel);
          await checkBackPressure(queues.answer, settings.MAX_WAITING_ANSWERS);

          const next = turn.attempt + 1;
          let updated: TurnRow;
          try {
            updated = await db.transaction().execute(async (trx) => {
              const row = await trx
                .updateTable('turns')
                .set({
                  status: 'pending',
                  attempt: next,
                  requeues: 0,
                  stage: null,
                  outcome: null,
                  answer: null,
                  note: null,
                  quotes: '[]',
                  search_question: null,
                  answer_path: null,
                  chat_model: null,
                  error_code: null,
                  debug: null,
                  heartbeat_at: null,
                  updated_at: new Date(),
                })
                .where('id', '=', turn.id)
                .where('attempt', '=', turn.attempt)
                .where('status', '=', 'failed')
                // Checked in the same statement, so a question asked in the meantime counts.
                .where(({ not, exists, selectFrom }) =>
                  not(
                    exists(
                      selectFrom('turns as later')
                        .select('later.id')
                        .whereRef('later.conversation_id', '=', 'turns.conversation_id')
                        .whereRef('later.sequence', '>', 'turns.sequence'),
                    ),
                  ),
                )
                .returning(turnColumns)
                .executeTakeFirst();
              if (!row) throw notRetryable();
              await claim.record(trx, 202, toTurnView(row));
              return row;
            });
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            throw answerPending();
          }
          try {
            await enqueue(queues.answer, { turnId: turn.id, attempt: next }, jobId(turn.id, next));
          } catch {
            // Back to failed, on the new attempt: a job that lands late finds the row not pending and does nothing.
            await db.transaction().execute(async (trx) => {
              await trx
                .updateTable('turns')
                .set({ status: 'failed', error_code: turn.error_code })
                .where('id', '=', turn.id)
                .where('attempt', '=', next)
                .where('status', '=', 'pending')
                .execute();
              await claim.release(trx);
            });
            throw queueUnavailable();
          }
          return { status: 202, body: toTurnView(updated) };
        },
      ),
  );

  app.get(
    '/conversations/:id/messages',
    { schema: { params: idParams, response: { 200: z.object({ items: z.array(turnView) }) } } },
    async (request) => {
      const conversation = await db
        .selectFrom('conversations')
        .select('id')
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!conversation) throw new HttpError(404, 'not_found', 'No conversation with that id.');
      const rows = await db
        .selectFrom('turns')
        .select(turnColumns)
        .where('conversation_id', '=', request.params.id)
        .orderBy('sequence')
        .execute();
      return { items: rows.map(toTurnView) };
    },
  );

  app.get(
    '/messages/:id',
    { schema: { params: idParams, response: { 200: turnView } } },
    async (request) => {
      const turn = await db
        .selectFrom('turns')
        .select(turnColumns)
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!turn) throw new HttpError(404, 'not_found', 'No message with that id.');
      return toTurnView(turn);
    },
  );
};
