import { Worker } from 'bullmq';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { answerQuestion } from './jobs/answer.js';
import { prepareDocument, type JobDeps } from './jobs/prepare.js';
import { migrateToLatest } from './migrate.js';
import { createModel } from './model.js';
import { QUEUE_NAMES, type AnswerJob, type PrepareJob } from './queue.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const db = createDb(config.DATABASE_URL, (err) =>
  log.warn({ err: err.message }, 'postgres dropped a connection'),
);
const deps: JobDeps = { db, model: createModel(config), log, config };

// BullMQ gives workers a connection that retries forever, so they resume by themselves after a Redis outage.
const options = {
  connection: { url: config.REDIS_URL },
  prefix: config.QUEUE_PREFIX,
  autorun: false,
};
// One job at a time per queue: both queues call the same model server, which works on one request at a time.
const workers = [
  new Worker<PrepareJob>(QUEUE_NAMES.prepare, (job) => prepareDocument(deps, job.data), {
    ...options,
    concurrency: 1,
  }),
  new Worker<AnswerJob>(QUEUE_NAMES.answer, (job) => answerQuestion(deps, job.data), {
    ...options,
    concurrency: 1,
  }),
];
for (const worker of workers) {
  worker.on('error', (err) => log.warn({ queue: worker.name, err: err.message }, 'queue error'));
}

let stopping = false;
async function shutdown(reason: string, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  log.info({ reason }, 'shutting down');
  // Waits for the job in hand up to 20 s (Compose allows 30). A job cut off here is picked up again as stalled
  // when a worker next starts. shortcut: step 3 aborts the model call and puts the job back straight away.
  await Promise.race([
    Promise.allSettled(workers.map((w) => w.close())),
    new Promise((resolve) => setTimeout(resolve, 20_000)),
  ]);
  await db.destroy().catch(() => {});
  process.exit(exitCode);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await migrateToLatest(db);
  for (const worker of workers) void worker.run();
  log.info('worker started');
} catch (err) {
  if (!stopping) {
    const { message, cause } = err as Error;
    log.error({ err: message, cause: (cause as Error | undefined)?.message }, 'start-up failed');
    await shutdown('start-up failed', 1);
  }
}
