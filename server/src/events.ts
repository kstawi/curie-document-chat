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
  // Job ids are `${messageId}-${attempt}` (queue.ts), so every attempt of a message reaches the same streams.
  const changed = ({ jobId }: { jobId: string }) =>
    listeners.get(jobId.slice(0, jobId.lastIndexOf('-')))?.forEach((listener) => listener());
  // The two events that follow a change to the row: a new stage, and the end of a run (the handler records
  // answers and failures itself, so a job that ends one way or the other completes). Every other row change (the
  // sweeper's, or a stage reset at shutdown) waits for a stream's heartbeat.
  events.on('progress', changed);
  events.on('completed', changed);
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
