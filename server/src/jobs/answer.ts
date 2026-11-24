import type { AnswerStage } from '../db.js';
import { ERROR_MESSAGES, type ErrorCode } from '../errors.js';
import { ModelError, type ModelAnswer } from '../model.js';
import { answerPrompt, rewritePrompt, type EarlierTurn } from '../prompt.js';
import type { AnswerJob } from '../queue.js';
import { searchDocument } from '../search.js';
import { sectionIndex } from '../text/chunk.js';
import { verifyQuotes } from '../text/quotes.js';
import { ShutdownAbort, startHeartbeat, type JobContext, type JobDeps } from './deps.js';

// Earlier answered turns go to the model as data, so a follow-up like "and the hybrid one?" has its context.
const EARLIER_TURNS = 3;
const NOTE_MAX_CHARS = 300;

class AnswerError extends Error {
  constructor(readonly code: 'document_not_ready' | 'embedding_model_changed') {
    super(ERROR_MESSAGES[code]);
  }
}

const isRetryable = (err: unknown): err is ModelError =>
  err instanceof ModelError && (err.kind === 'unavailable' || err.kind === 'timeout');

// Answers one question: rewrite a follow-up for search, search, ask the model, verify its quotes, record the result.
// Every update is guarded by status and attempt, so a stale job (deleted row, newer attempt) changes nothing. What
// each model failure leads to is the failure table in DESIGN.md.
export async function answerQuestion(
  { db, model, config }: JobDeps,
  { turnId, attempt }: AnswerJob,
  { signal, shutdown, lastAttempt, log, progress }: JobContext,
) {
  const touch = (stage?: AnswerStage) =>
    db
      .updateTable('turns')
      .set(
        stage
          ? { stage, heartbeat_at: new Date(), updated_at: new Date() }
          : { heartbeat_at: new Date() },
      )
      .where('id', '=', turnId)
      .where('attempt', '=', attempt)
      .where('status', '=', 'pending')
      .executeTakeFirst();
  // The row first, then the event, so a stream that re-reads on the event finds the new stage.
  const setStage = async (stage: AnswerStage) => {
    await touch(stage);
    progress(stage);
  };

  const started = await touch();
  if (!started.numUpdatedRows) {
    log.info({ turnId, attempt }, 'skipped a stale answer job');
    return;
  }
  const stopHeartbeat = startHeartbeat(() => touch(), config.HEARTBEAT_MS, log);
  // Known once the turn is read, so every later log line names the document too.
  let documentId: string | undefined;
  // What happened on the way (rewrite, shrinking, a first call that failed), kept in the debug column either way.
  const trail: Record<string, unknown> = {};

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
    documentId = turn.documentId;
    if (turn.documentStatus !== 'ready') throw new AnswerError('document_not_ready');
    if (turn.embeddingModel !== model.embeddingModel)
      throw new AnswerError('embedding_model_changed');

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

    // A follow-up like "and the hybrid one?" finds nothing on its own words, so search uses a standalone version.
    let searchQuestion = turn.question;
    if (history.length) {
      await setStage('rewriting');
      try {
        searchQuestion = await model.rewrite(rewritePrompt(turn.question, history), signal);
      } catch (err) {
        // A server that is down or overloaded is retried with the job; any other failure of the rewrite falls back
        // to searching with the last two questions together.
        if (!(err instanceof ModelError) || err.kind === 'unavailable' || err.kind === 'aborted') {
          throw err;
        }
        trail.rewriteFailed = { error: err.message, detail: err.detail };
        searchQuestion = `${history.at(-1)!.question} ${turn.question}`;
      }
    }

    await setStage('searching');
    const [questionVector] = await model.embed([searchQuestion], 'query', signal);
    const search = (budget: number) =>
      searchDocument(db, turn.documentId, searchQuestion, questionVector!, budget);
    let passages = await search(config.PASSAGE_TOKEN_BUDGET);

    await setStage('writing');
    let shrunk = false;
    const ask = async (thinking: boolean): Promise<ModelAnswer> => {
      try {
        return await model.answer(answerPrompt(passages, turn.question, history), {
          thinking,
          signal,
        });
      } catch (err) {
        // Once per job: half the passages, then give up with context_too_long.
        if (thinking && !shrunk && err instanceof ModelError && err.kind === 'context') {
          shrunk = true;
          trail.shrunk = true;
          passages = await search(Math.floor(config.PASSAGE_TOKEN_BUDGET / 2));
          return ask(thinking);
        }
        throw err;
      }
    };

    let answerPath: 'thinking' | 'thinking_off_retry' = 'thinking';
    let reply: ModelAnswer;
    try {
      reply = await ask(true);
    } catch (err) {
      // A runaway (token cap), an unusable reply or a stuck call gets one more try with thinking off.
      if (!(err instanceof ModelError) || !(err.kind === 'bad_output' || err.kind === 'timeout')) {
        throw err;
      }
      trail.firstCall = { error: err.message, detail: err.detail };
      answerPath = 'thinking_off_retry';
      reply = await ask(false);
    }

    await setStage('checking');
    // Checked against the passages sent with the reply kept, which are the smaller set after shrinking.
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
        search_question: searchQuestion,
        answer_path: answerPath,
        chat_model: model.chatModel,
        debug: JSON.stringify({ ...trail, draft: reply, rejectedQuotes: check.rejected }),
        updated_at: new Date(),
      })
      .where('id', '=', turnId)
      .where('attempt', '=', attempt)
      .where('status', '=', 'pending')
      .execute();
    log.info(
      { turnId, documentId, outcome, answerPath, passages: passages.length },
      'question answered',
    );
  } catch (err) {
    if (err instanceof ModelError && err.kind === 'aborted' && shutdown.aborted) {
      throw new ShutdownAbort();
    }
    if (isRetryable(err) && !lastAttempt) {
      log.warn({ turnId, documentId, err: err.message }, 'answer will be retried');
      await setStage('retrying');
      throw err;
    }
    const code: ErrorCode =
      err instanceof ModelError || err instanceof AnswerError ? err.code : 'internal_error';
    log.warn({ turnId, documentId, code, err: (err as Error).message }, 'answer failed');
    await db
      .updateTable('turns')
      .set({
        status: 'failed',
        stage: null,
        error_code: code,
        debug: JSON.stringify({
          ...trail,
          error: (err as Error).message,
          detail: err instanceof ModelError ? err.detail : undefined,
        }),
        updated_at: new Date(),
      })
      .where('id', '=', turnId)
      .where('attempt', '=', attempt)
      .where('status', '=', 'pending')
      .execute();
  } finally {
    stopHeartbeat();
  }
}
