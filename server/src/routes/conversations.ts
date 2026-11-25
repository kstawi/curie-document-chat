import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import { SECURITY_HEADERS, type AppDeps } from '../app.js';
import { ANSWER_STAGES, type TurnsTable } from '../db.js';
import { ERROR_MESSAGES, HttpError, type ErrorCode } from '../errors.js';
import { withIdempotencyKey } from '../idempotency.js';
import { cleanQuestion } from '../text/clean.js';
import { checkBackPressure, enqueue, jobId, queueUnavailable } from '../queue.js';

const idParams = z.object({ id: z.uuid() });

const conversationView = z.object({ id: z.uuid(), documentId: z.uuid(), createdAt: z.date() });

const quoteView = z.object({
  text: z.string(),
  start: z.number().int(),
  end: z.number().int(),
  line: z.number().int(),
  section: z.string(),
  // PDFs only.
  startPage: z.number().int().optional(),
  endPage: z.number().int().optional(),
});

const turnView = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  sequence: z.number().int(),
  question: z.string(),
  status: z.enum(['pending', 'completed', 'failed']),
  stage: z.enum(ANSWER_STAGES).nullable(),
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
  { db, queues, answerEvents, embeddingModel, settings },
) => {
  const readTurn = (id: string) =>
    db.selectFrom('turns').select(turnColumns).where('id', '=', id).executeTakeFirst();

  // Open progress streams hold their connections, which would keep app.close() waiting; shutting down ends them.
  const openStreams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const end of openStreams) end();
  });

  // Questions and answer retries share one limit a minute, with one limiter for both routes.
  const questionLimit = app.rateLimit({
    max: settings.RATE_LIMIT_QUESTIONS_PER_MINUTE,
    timeWindow: 60_000,
  });

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
          request.log.info({ conversationId: view.id, documentId: doc.id }, 'conversation started');
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
      preHandler: questionLimit,
      schema: {
        params: idParams,
        body: z.strictObject({
          // Hidden characters removed, composed and on one line, then checked for length.
          question: z.string().overwrite(cleanQuestion).min(1).max(2_000),
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
          request.log.info(
            { turnId: turn.id, conversationId: conversation.id },
            'question accepted',
          );
          return { status: 202, body: toTurnView(turn) };
        },
      ),
  );

  // Answers a failed question again. Only the conversation's latest question, so its answer never skips a later one.
  app.post(
    '/messages/:id/retry',
    { preHandler: questionLimit, schema: { params: idParams, response: { 202: turnView } } },
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
              'turns.debug',
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
                .set({
                  status: 'failed',
                  error_code: turn.error_code,
                  debug: turn.debug === null ? null : JSON.stringify(turn.debug),
                })
                .where('id', '=', turn.id)
                .where('attempt', '=', next)
                .where('status', '=', 'pending')
                .execute();
              await claim.release(trx);
            });
            throw queueUnavailable();
          }
          request.log.info({ turnId: turn.id, attempt: next }, 'answer retry accepted');
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
      const turn = await readTurn(request.params.id);
      if (!turn) throw new HttpError(404, 'not_found', 'No message with that id.');
      return toTurnView(turn);
    },
  );

  // An answer's progress as server-sent events: `progress` while it is pending, then one `final` with id "final",
  // then the stream closes. Every event carries the message as GET /messages/:id returns it, read from the row, so
  // a draft is never sent. Queue events only prompt a re-read; the heartbeat re-reads too, which catches what no
  // job reports (the sweeper failing or requeueing a lost answer, events missed while Redis was away).
  app.get(
    '/messages/:id/events',
    { exposeHeadRoute: false, schema: { params: idParams } },
    async (request, reply) => {
      // EventSource reconnects whenever a stream closes, the last one included; 204 tells it to stop. Sent without
      // a lookup: the client already had the final event.
      if (request.headers['last-event-id'] === 'final') return reply.code(204).send();
      const id = request.params.id;
      let done = false;
      let streaming = false;
      // Set once the stream starts; end() may run before that.
      let heartbeat: NodeJS.Timeout | undefined = undefined;
      // One read at a time, so events are sent in order and nothing follows the final one. A change that arrives
      // during a read is picked up by another read straight after.
      let reading = true;
      let dirty = false;
      let lastStage: string | null | undefined;

      // Ends the stream, or, before it has started, marks the request as abandoned. Registered before the first
      // read, so a client leaving or a shutdown starting during that read is not missed.
      function end() {
        if (done) return;
        done = true;
        clearInterval(heartbeat);
        unsubscribe();
        openStreams.delete(end);
        if (streaming) reply.raw.end();
      }
      // JSON never contains a raw line break, so each event is a single data line.
      const send = (turn: TurnRow) => {
        const data = JSON.stringify(turnView.parse(toTurnView(turn)));
        if (turn.status !== 'pending') {
          reply.raw.write(`id: final\nevent: final\ndata: ${data}\n\n`);
          end();
        } else if (turn.stage !== lastStage) {
          lastStage = turn.stage;
          reply.raw.write(`event: progress\ndata: ${data}\n\n`);
        }
      };
      const refresh = async () => {
        dirty = true;
        if (reading || done) return;
        reading = true;
        try {
          while (dirty && !done) {
            dirty = false;
            const turn = await readTurn(id);
            if (done) break;
            if (turn) send(turn);
            else end();
          }
        } catch (err) {
          // The next heartbeat reads again.
          request.log.warn({ turnId: id, err: (err as Error).message }, 'progress read failed');
        } finally {
          reading = false;
        }
      };

      // Listening starts before the first read, so a change in between is not missed.
      const unsubscribe = answerEvents.subscribe(id, () => void refresh());
      openStreams.add(end);
      // Fires when the client goes away, at any point, as well as after the response ends.
      reply.raw.on('close', end);
      let first: TurnRow | undefined;
      try {
        first = await readTurn(id);
      } catch (err) {
        end();
        throw err;
      }
      if (!first) {
        end();
        throw new HttpError(404, 'not_found', 'No message with that id.');
      }
      // The client left or the server began shutting down during the read; a client still there gets a 503.
      if (done) {
        throw new HttpError(
          503,
          'shutting_down',
          'The server is shutting down. Try again shortly.',
        );
      }

      reply.hijack();
      streaming = true;
      // Hijacked replies skip the onSend hook, so the security headers are set here. Buffering off for nginx.
      reply.raw.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      });
      heartbeat = setInterval(() => {
        reply.raw.write(': heartbeat\n\n');
        void refresh();
      }, settings.STREAM_HEARTBEAT_MS);
      try {
        send(first);
      } catch (err) {
        request.log.error({ turnId: id, err: (err as Error).message }, 'progress stream failed');
        end();
        return reply;
      }
      reading = false;
      if (dirty) void refresh();
      return reply;
    },
  );
};
