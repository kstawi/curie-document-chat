import { Queue, type ConnectionOptions, type DefaultJobOptions } from 'bullmq';
import type { Config } from './config.js';

export interface PrepareJob {
  documentId: string;
  attempt: number;
}

export interface AnswerJob {
  turnId: string;
  attempt: number;
}

export const QUEUE_NAMES = { prepare: 'prepare', answer: 'answer' } as const;

// BullMQ ignores an add whose id already exists, failed jobs included, so a retry must use a new attempt number.
export const jobId = (rowId: string, attempt: number) => `${rowId}-${attempt}`;

// Where the worker leaves the result of its start-up model check, for /ready.
export const modelStatusKey = (prefix: string) => `${prefix}:model-status`;

export type Queues = ReturnType<typeof createQueues>;

// Without an offline queue, adding a job fails at once while Redis is down instead of waiting. A failed attempt is
// retried with exponential backoff (5, 10 s by default); the handler decides which failures are worth it.
export function createQueues(
  redisUrl: string,
  prefix: string,
  { JOB_ATTEMPTS, JOB_BACKOFF_MS }: Pick<Config, 'JOB_ATTEMPTS' | 'JOB_BACKOFF_MS'>,
) {
  const connection: ConnectionOptions = {
    url: redisUrl,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  };
  // Finished jobs are kept long enough to inspect, and for the sweeper to read, then removed so Redis doesn't grow.
  const defaultJobOptions: DefaultJobOptions = {
    attempts: JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: JOB_BACKOFF_MS },
    removeOnComplete: { age: 24 * 3600, count: 1_000 },
    removeOnFail: { age: 7 * 24 * 3600, count: 5_000 },
  };
  return {
    prepare: new Queue<PrepareJob>(QUEUE_NAMES.prepare, { connection, prefix, defaultJobOptions }),
    answer: new Queue<AnswerJob>(QUEUE_NAMES.answer, { connection, prefix, defaultJobOptions }),
  };
}

const REDIS_TIMEOUT_MS = 2_000;

// If Redis was down when the process started, BullMQ waits for it rather than failing, so every queue call that a
// request or the sweeper waits on is raced against a timeout.
export async function withTimeout<T>(call: Promise<T>, ms = REDIS_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out waiting for Redis')), ms);
  });
  call.catch(() => {}); // a late failure after the timeout has already been answered
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Throws if the job can't be added within two seconds; callers treat that as the queue being unavailable. A job
// added late anyway either finds its row gone and does nothing (uploads and questions remove the row) or runs as
// intended (the sweeper keeps the row on the new attempt).
export async function enqueue<T>(queue: Queue<T>, data: T, id: string): Promise<void> {
  await withTimeout((queue as Queue).add(queue.name, data, { jobId: id }));
}
