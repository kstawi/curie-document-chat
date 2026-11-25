import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { buildApp } from '../../src/app.js';
import { embeddingIdentity, loadConfig, type Config } from '../../src/config.js';
import { createDb } from '../../src/db.js';
import { createAnswerEvents } from '../../src/events.js';
import type { JobContext, JobDeps } from '../../src/jobs/deps.js';
import { createWorkers } from '../../src/jobs/workers.js';
import { createModel } from '../../src/model.js';
import { createPdfParser } from '../../src/pdf/server.js';
import { createQueues, modelStatusKey } from '../../src/queue.js';
import { FakeModel } from './fake-model.js';

// The API, both job handlers, the PDF parser (with its real child processes) and a fake model server, wired as in
// production but in one process. Each stack gets its own queue prefix, so test files never see each other's jobs.
// `queueRedisUrl` points only the API's queues somewhere else, e.g. at a closed port to stand in for Redis being down.
export async function startStack(overrides: Partial<Config> = {}, queueRedisUrl?: string) {
  const fake = await new FakeModel().start();
  const parser = createPdfParser({
    timeoutMs: 20_000,
    heapMb: 256,
    log: pino({ level: 'silent' }),
  });
  await new Promise<void>((resolve) => parser.listen(0, '127.0.0.1', resolve));
  const config: Config = {
    ...loadConfig(),
    QUEUE_PREFIX: `test-${randomUUID()}`,
    MODEL_BASE_URL: fake.url,
    PDF_PARSER_URL: `http://127.0.0.1:${(parser.address() as AddressInfo).port}`,
    MODEL_TIMEOUT_MS: 5_000,
    CHAT_RETRY_TIMEOUT_MS: 5_000,
    REWRITE_TIMEOUT_MS: 5_000,
    // Job retries a few milliseconds apart, so a test doesn't wait out the real backoff.
    JOB_BACKOFF_MS: 50,
    // Every test request comes from one address; the rate limits have their own tests.
    RATE_LIMIT_UPLOADS_PER_MINUTE: 100_000,
    RATE_LIMIT_QUESTIONS_PER_MINUTE: 100_000,
    CHAT_MODEL: 'fake-chat',
    EMBEDDING_MODEL: 'fake-embed',
    ...overrides,
  };
  const db = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  await redis.connect();
  const queues = createQueues(queueRedisUrl ?? config.REDIS_URL, config.QUEUE_PREFIX, config);
  // As in api.ts; for a queue pointed at a closed port, the connection errors are the point.
  for (const queue of Object.values(queues)) queue.on('error', () => {});
  const answerEvents = createAnswerEvents(config.REDIS_URL, config.QUEUE_PREFIX, () => {});
  const deps: JobDeps = { db, model: createModel(config), log: pino({ level: 'silent' }), config };
  const startWorkers = () => {
    const w = createWorkers(deps, { url: config.REDIS_URL }, config.QUEUE_PREFIX);
    w.run();
    return w;
  };
  let workers = startWorkers();
  const app = buildApp({
    db,
    redis,
    queues,
    answerEvents,
    embeddingModel: embeddingIdentity(config),
    modelStatusKey: modelStatusKey(config.QUEUE_PREFIX),
    settings: config,
  });

  return {
    app,
    db,
    redis,
    fake,
    parser,
    deps,
    queues,
    answerEvents,
    // Stops the workers as a shutdown would (calls in flight cancelled, their jobs put back).
    stopWorkers: () => workers.close(),
    restartWorkers() {
      workers = startWorkers();
    },
    async stop() {
      await app.close();
      await workers.close();
      // Bounded: queues pointed at an unreachable Redis would otherwise wait for it forever.
      await Promise.race([
        (async () => {
          if (!queueRedisUrl) {
            await Promise.allSettled(
              Object.values(queues).map((q) => q.obliterate({ force: true })),
            );
          }
          await Promise.allSettled([
            answerEvents.close(),
            ...Object.values(queues).map((q) => q.close()),
          ]);
        })(),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      await Promise.allSettled([redis.quit(), db.destroy()]);
      await fake.stop();
      parser.closeAllConnections();
      await new Promise((resolve) => parser.close(resolve));
    },
  };
}

export function multipart(
  file: { content: string | Buffer; filename?: string },
  fields: Record<string, string> = {},
) {
  const boundary = `----test${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename ?? 'doc.md'}"\r\n` +
        'Content-Type: text/markdown\r\n\r\n',
    ),
    Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// For calling a job handler directly: never cancelled, and on its last attempt, so failures are recorded at once.
export function jobContext(overrides: Partial<JobContext> = {}): JobContext {
  return {
    signal: new AbortController().signal,
    shutdown: new AbortController().signal,
    lastAttempt: true,
    log: pino({ level: 'silent' }),
    progress: () => {},
    ...overrides,
  };
}
