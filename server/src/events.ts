import { QueueEvents } from 'bullmq';
import { QUEUE_NAMES } from './queue.js';

export type AnswerEvents = ReturnType<typeof createAnswerEvents>;

// One BullMQ event listener per API process for the answer queue, fanned out to open progress streams by message
// id. An event only means "this message changed": each stream re-reads its row, so no answer text goes through Redis.
export function createAnswerEvents(
  redisUrl: string,
  prefix: string,
  onError: (err: Error) => void,
) {
  // BullMQ gives this a blocking connection of its own, with the retry settings that need.
  const events = new QueueEvents(QUEUE_NAMES.answer, { connection: { url: redisUrl }, prefix });
  events.on('error', onError);
  const listeners = new Map<string, Set<() => void>>();
  // Job ids are `${messageId}-${attempt}` (queue.ts), so every attempt of a message reaches the same streams. The
  // global `failed` event isn't sent for an attempt that will be retried, hence the wide list.
  const changed = ({ jobId }: { jobId: string }) =>
    listeners.get(jobId.slice(0, jobId.lastIndexOf('-')))?.forEach((listener) => listener());
  for (const name of [
    'waiting',
    'active',
    'progress',
    'delayed',
    'stalled',
    'completed',
    'failed',
  ] as const) {
    events.on(name, changed);
  }
  return {
    subscribe(messageId: string, listener: () => void) {
      let set = listeners.get(messageId);
      if (!set) listeners.set(messageId, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(messageId);
      };
    },
    // Messages with a stream open in this process.
    watching: () => listeners.size,
    close: () => events.close(),
  };
}
