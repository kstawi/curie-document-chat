import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { embeddingIdentity, loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrateToLatest } from './migrate.js';
import { createQueues } from './queue.js';

const config = loadConfig();

// Without an offline queue, commands fail fast while Redis is down instead of piling up in memory.
const redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
const db = createDb(config.DATABASE_URL, (err) =>
  app.log.warn({ err: err.message }, 'postgres dropped a connection'),
);

const queues = createQueues(config.REDIS_URL, config.QUEUE_PREFIX);
for (const queue of Object.values(queues)) {
  queue.on('error', (err) => app.log.warn({ queue: queue.name, err: err.message }, 'queue error'));
}

const app = buildApp({
  db,
  redis,
  queues,
  embeddingModel: embeddingIdentity(config),
  logger: { level: config.LOG_LEVEL },
});
// ioredis reconnects by itself; log the outage, /ready reports it.
redis.on('error', (err: Error) => app.log.warn({ err: err.message }, 'redis error'));

let stopping = false;
async function shutdown(reason: string, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  app.log.info({ reason }, 'shutting down');
  await app.close();
  await Promise.allSettled([
    db.destroy(),
    redis.quit(),
    ...Object.values(queues).map((q) => q.close()),
  ]);
  process.exit(exitCode);
}
// Registered before migrating, so a stop request during start-up takes effect once the statement in flight ends.
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await migrateToLatest(db);
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  // A stop requested during start-up can make start-up fail on its way out; that isn't worth reporting.
  if (!stopping) {
    // Messages only: pg-pool attaches the whole client to idle-connection errors, and some pg errors carry row data
    // in `detail`.
    const { message, cause } = err as Error;
    app.log.error(
      { err: message, cause: (cause as Error | undefined)?.message },
      'start-up failed',
    );
    await shutdown('start-up failed', 1);
  }
}
