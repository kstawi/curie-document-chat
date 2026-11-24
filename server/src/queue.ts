import { Queue, type ConnectionOptions, type DefaultJobOptions } from 'bullmq';

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

// Finished jobs are kept long enough to inspect, then removed so Redis doesn't grow without bound.
const defaultJobOptions: DefaultJobOptions = {
  attempts: 1,
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5_000 },
};

export type Queues = ReturnType<typeof createQueues>;

// For the API. Without an offline queue, adding a job fails at once while Redis is down instead of waiting.
export function createQueues(redisUrl: string, prefix: string) {
  const connection: ConnectionOptions = {
    url: redisUrl,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  };
  return {
    prepare: new Queue<PrepareJob>(QUEUE_NAMES.prepare, { connection, prefix, defaultJobOptions }),
    answer: new Queue<AnswerJob>(QUEUE_NAMES.answer, { connection, prefix, defaultJobOptions }),
  };
}

const ENQUEUE_TIMEOUT_MS = 2_000;

// Throws if the job can't be added within two seconds; callers treat that as the queue being unavailable. If Redis was down when the API started, BullMQ waits for it rather than failing, and
// the job may still be added later; the job handlers ignore a job whose row is gone.
export async function enqueue<T>(queue: Queue<T>, data: T, id: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out adding a job')), ENQUEUE_TIMEOUT_MS);
  });
  const add = (queue as Queue).add(queue.name, data, { jobId: id });
  add.catch(() => {}); // a late failure after the timeout has already been answered
  try {
    await Promise.race([add, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
