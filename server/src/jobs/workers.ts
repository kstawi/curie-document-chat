import { DelayedError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { QUEUE_NAMES, type AnswerJob, type PrepareJob } from '../queue.js';
import { answerQuestion } from './answer.js';
import { ShutdownAbort, type JobContext, type JobDeps } from './deps.js';
import { prepareDocument } from './prepare.js';

type Handler<T> = (deps: JobDeps, data: T, ctx: JobContext) => Promise<void>;

// Both queues' workers. The worker process and the tests share this, so the retry and shutdown handling the tests
// exercise is the real one.
export function createWorkers(deps: JobDeps, connection: ConnectionOptions, prefix: string) {
  const shutdown = new AbortController();

  const processor =
    <T>(handler: Handler<T>, timeoutMs: number) =>
    async (job: Job<T>, token?: string) => {
      const ctx: JobContext = {
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)]),
        shutdown: shutdown.signal,
        // BullMQ counts an attempt once it has failed, so during the last one attemptsMade is attempts - 1.
        lastAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
        log: deps.log.child({ queue: job.queueName, jobId: job.id }),
      };
      try {
        await handler(deps, job.data, ctx);
      } catch (err) {
        if (!(err instanceof ShutdownAbort)) throw err;
        // Back to the queue without spending an attempt (BullMQ's delay-and-DelayedError pattern). The row is left
        // as it was, so the next start runs the job again.
        await job.moveToDelayed(Date.now(), token);
        throw new DelayedError();
      }
    };

  // One job at a time per queue: both call the same model server, which works on one request at a time.
  const options = { connection, prefix, autorun: false, concurrency: 1 };
  const workers = [
    new Worker<PrepareJob>(
      QUEUE_NAMES.prepare,
      processor(prepareDocument, deps.config.PREPARE_JOB_TIMEOUT_MS),
      options,
    ),
    new Worker<AnswerJob>(
      QUEUE_NAMES.answer,
      processor(answerQuestion, deps.config.ANSWER_JOB_TIMEOUT_MS),
      options,
    ),
  ];
  for (const worker of workers) {
    worker.on('error', (err) =>
      deps.log.warn({ queue: worker.name, err: err.message }, 'queue error'),
    );
    // Handlers record final failures on the row; this logs attempts that will be retried, and a handler that threw
    // before or while recording.
    worker.on('failed', (job, err) =>
      deps.log.warn(
        { queue: worker.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message },
        'job attempt failed',
      ),
    );
  }

  return {
    run() {
      for (const worker of workers) void worker.run();
    },
    // Stops taking jobs first, then cancels the model calls in flight, so their jobs go back to the queue at once
    // instead of running to the end of the stop grace period.
    async close() {
      const closing = workers.map((w) => w.close());
      shutdown.abort();
      await Promise.allSettled(closing);
    },
  };
}
