import { Redis } from 'ioredis';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import type { JobDeps } from './jobs/deps.js';
import { sweep } from './jobs/sweep.js';
import { createWorkers } from './jobs/workers.js';
import { migrateToLatest } from './migrate.js';
import { createModel } from './model.js';
import { createQueues, modelStatusKey, withTimeout } from './queue.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const db = createDb(config.DATABASE_URL, (err) =>
  log.warn({ err: err.message }, 'postgres dropped a connection'),
);
const deps: JobDeps = { db, model: createModel(config), log, config };

// BullMQ gives workers a connection that retries forever, so they resume by themselves after a Redis outage. The
// sweeper and the model check use queues that fail fast instead, so a sweep skips a round rather than waiting.
const workers = createWorkers(deps, { url: config.REDIS_URL }, config.QUEUE_PREFIX);
const queues = createQueues(config.REDIS_URL, config.QUEUE_PREFIX, config);
for (const queue of Object.values(queues)) {
  queue.on('error', (err) => log.warn({ queue: queue.name, err: err.message }, 'queue error'));
}
// For the model check's result; commands wait for a reconnect, bounded by withTimeout.
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error'));

// Never two sweeps at once, and a failed one only logs: the next round tries again.
let sweeping: Promise<void> | undefined;
function sweepNow() {
  sweeping ??= sweep(deps, queues)
    .then((counts) => {
      if (counts.requeued || counts.failed) log.info(counts, 'sweep');
    })
    .catch((err: Error) => log.warn({ err: err.message }, 'sweep skipped'))
    .finally(() => (sweeping = undefined));
}

// A wrong model name or a rejected setting shows up in the logs and on /ready at start, not at the first upload.
async function checkModels() {
  const result = { ...(await deps.model.check()), checkedAt: new Date().toISOString() };
  const states = [result.chat, result.embedding];
  if (states.includes('misconfigured')) log.error(result, 'model check: check the model settings');
  else if (states.includes('unavailable'))
    log.warn(result, 'model check: model server unavailable');
  else log.info(result, 'model check passed');
  await withTimeout(redis.set(modelStatusKey(config.QUEUE_PREFIX), JSON.stringify(result))).catch(
    (err: Error) => log.warn({ err: err.message }, 'could not store the model check'),
  );
}

let timer: NodeJS.Timeout | undefined;
let stopping = false;
async function shutdown(reason: string, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  log.info({ reason }, 'shutting down');
  // Model calls in flight are cancelled and their jobs put back, so this is quick; 20 s bounds it (Compose allows 30).
  const limit = new Promise((resolve) => setTimeout(resolve, 20_000));
  await Promise.race([Promise.all([workers.close(), sweeping]), limit]);
  await Promise.allSettled([...Object.values(queues).map((q) => q.close()), redis.quit()]);
  await db.destroy().catch(() => {});
  process.exit(exitCode);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await migrateToLatest(db);
  if (!stopping) {
    workers.run();
    sweepNow();
    timer = setInterval(sweepNow, config.SWEEP_INTERVAL_MS);
    if (config.MODEL_STARTUP_CHECK) void checkModels();
    // With the check off, a result left by an earlier run would be out of date, so /ready shows none.
    else
      void withTimeout(redis.del(modelStatusKey(config.QUEUE_PREFIX))).catch((err: Error) =>
        log.warn({ err: err.message }, 'could not clear the old model check'),
      );
    log.info('worker started');
  }
} catch (err) {
  if (!stopping) {
    const { message, cause } = err as Error;
    log.error({ err: message, cause: (cause as Error | undefined)?.message }, 'start-up failed');
    await shutdown('start-up failed', 1);
  }
}
