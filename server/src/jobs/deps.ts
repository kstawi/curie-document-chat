import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import type { Model } from '../model.js';

export interface JobDeps {
  db: Kysely<Database>;
  model: Model;
  log: Logger;
  config: Config;
}

export interface JobContext {
  // Aborted when the worker shuts down or the job passes its time limit; `shutdown` tells the two apart.
  signal: AbortSignal;
  shutdown: AbortSignal;
  // On the last attempt a temporary failure is recorded on the row instead of retried.
  lastAttempt: boolean;
  log: Logger;
  // Tells open progress streams that the row changed. Best effort: a stream also re-reads its row on a timer.
  progress: (stage: string) => void;
}

// Thrown by a handler cut off by shutdown: the job goes back to the queue without spending an attempt.
export class ShutdownAbort extends Error {}

// Touches a row while a long job runs, so the sweeper can tell a live job from a lost one. A failed touch is only
// logged: the job itself decides how the row ends.
export function startHeartbeat(touch: () => Promise<unknown>, everyMs: number, log: Logger) {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    touch()
      .catch((err: Error) => log.warn({ err: err.message }, 'heartbeat failed'))
      .finally(() => (busy = false));
  }, everyMs);
  return () => clearInterval(timer);
}
