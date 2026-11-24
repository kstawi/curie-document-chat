import { ERROR_MESSAGES, type ErrorCode } from '../errors.js';
import { ModelError } from '../model.js';
import { answerPrompt, type EarlierTurn } from '../prompt.js';
import type { AnswerJob } from '../queue.js';
import { searchDocument } from '../search.js';
import { sectionIndex } from '../text/chunk.js';
import { verifyQuotes } from '../text/quotes.js';
import type { JobDeps } from './deps.js';

// Earlier answered turns go to the model as data, so a follow-up like "and the hybrid one?" has its context.
// shortcut: search still uses the follow-up as typed; step 3 rewrites it into a standalone question first.
const EARLIER_TURNS = 3;
const NOTE_MAX_CHARS = 300;

class AnswerError extends Error {
  constructor(readonly code: 'document_not_ready' | 'embedding_model_changed') {
    super(ERROR_MESSAGES[code]);
  }
}

export async function answerQuestion(
  { db, model, log, config }: JobDeps,
  { turnId, attempt }: AnswerJob,
) {
  const guard = { id: turnId, attempt };
  const setStage = (stage: string) =>
    db
      .updateTable('turns')
      .set({ stage, heartbeat_at: new Date(), updated_at: new Date() })
      .where('id', '=', guard.id)
      .where('attempt', '=', guard.attempt)
      .where('status', '=', 'pending')
      .executeTakeFirst();

  const started = await setStage('searching');
  if (!started.numUpdatedRows) {
    log.info({ turnId, attempt }, 'skipped a stale answer job');
    return;
  }

  try {
    const turn = await db
      .selectFrom('turns')
      .innerJoin('conversations', 'conversations.id', 'turns.conversation_id')
      .innerJoin('documents', 'documents.id', 'conversations.document_id')
      .select([
        'turns.question',
        'turns.sequence',
        'turns.conversation_id as conversationId',
        'documents.id as documentId',
        'documents.status as documentStatus',
        'documents.content',
        'documents.embedding_model as embeddingModel',
      ])
      .where('turns.id', '=', turnId)
      .executeTakeFirstOrThrow();
    if (turn.documentStatus !== 'ready') throw new AnswerError('document_not_ready');
    if (turn.embeddingModel !== model.embeddingModel)
      throw new AnswerError('embedding_model_changed');

    const [questionVector] = await model.embed([turn.question], 'query');
    const passages = await searchDocument(
      db,
      turn.documentId,
      turn.question,
      questionVector!,
      config.PASSAGE_TOKEN_BUDGET,
    );

    const earlier = await db
      .selectFrom('turns')
      .select(['question', 'answer', 'note'])
      .where('conversation_id', '=', turn.conversationId)
      .where('sequence', '<', turn.sequence)
      .where('outcome', 'in', ['answered', 'not_in_document'])
      .orderBy('sequence', 'desc')
      .limit(EARLIER_TURNS)
      .execute();
    const history: EarlierTurn[] = earlier
      .reverse()
      .map((t) => ({ question: t.question, answer: t.answer ?? t.note ?? '' }));

    await setStage('writing');
    const reply = await model.answer(answerPrompt(passages, turn.question, history));

    await setStage('checking');
    const content = turn.content ?? '';
    const check = verifyQuotes(content, reply.quotes, passages, sectionIndex(content));
    const outcome =
      reply.outcome === 'not_in_document'
        ? 'not_in_document'
        : check.verified.length > 0
          ? 'answered'
          : 'unsupported';

    await db
      .updateTable('turns')
      .set({
        status: 'completed',
        stage: null,
        outcome,
        answer: outcome === 'answered' ? reply.answer : null,
        // Cut by code point, so an emoji at the boundary isn't split in half.
        note:
          outcome === 'not_in_document'
            ? [...reply.answer].slice(0, NOTE_MAX_CHARS).join('')
            : null,
        quotes: JSON.stringify(outcome === 'answered' ? check.verified : []),
        search_question: turn.question,
        // Step 3 adds the second path, a retry with thinking off.
        answer_path: 'first_call',
        chat_model: model.chatModel,
        debug: JSON.stringify({ draft: reply, rejectedQuotes: check.rejected }),
        updated_at: new Date(),
      })
      .where('id', '=', guard.id)
      .where('attempt', '=', guard.attempt)
      .where('status', '=', 'pending')
      .execute();
    log.info({ turnId, outcome, passages: passages.length }, 'question answered');
  } catch (err) {
    const code: ErrorCode =
      err instanceof ModelError || err instanceof AnswerError ? err.code : 'internal_error';
    log.warn({ turnId, code, err: (err as Error).message }, 'answer failed');
    await db
      .updateTable('turns')
      .set({
        status: 'failed',
        stage: null,
        error_code: code,
        debug: JSON.stringify({
          error: (err as Error).message,
          detail: err instanceof ModelError ? err.detail : undefined,
        }),
        updated_at: new Date(),
      })
      .where('id', '=', guard.id)
      .where('attempt', '=', guard.attempt)
      .where('status', '=', 'pending')
      .execute();
  }
}
