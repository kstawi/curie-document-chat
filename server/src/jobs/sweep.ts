import type { Queue } from 'bullmq';
import { ERROR_MESSAGES } from '../errors.js';
import { enqueue, jobId, withTimeout, type Queues } from '../queue.js';
import type { JobDeps } from './deps.js';

// States in which a job will still run, or is running.
const LIVE = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);
const BATCH = 100;

async function isLive(queue: Queue, id: string) {
  const job = await withTimeout(queue.getJob(id));
  return job ? LIVE.has(await withTimeout(job.getState())) : false;
}

// Finds rows left unfinished without a live job: the API stopped between saving a row and adding its job, Redis
// lost a job, BullMQ failed a job that stalled twice (without running the handler), or a result couldn't be
// written. Each is queued again under a new attempt, at most MAX_REQUEUES times, then failed with max_attempts.
// While Redis can't be read the whole sweep stops at the first lookup, and a row whose new job can't be added gets
// its requeue back, so an outage never uses them up.
export async function sweep({ db, config }: Pick<JobDeps, 'db' | 'config'>, queues: Queues) {
  const cutoff = new Date(Date.now() - config.SWEEP_STALE_MS);
  const counts = { requeued: 0, failed: 0, keysPurged: 0 };

  // First, as it needs no Redis: an outage mustn't keep expired keys around.
  const purged = await db
    .deleteFrom('idempotency_keys')
    .where('expires_at', '<', new Date())
    .executeTakeFirst();
  counts.keysPurged = Number(purged.numDeletedRows);

  const documents = await db
    .selectFrom('documents')
    .select(['id', 'attempt', 'requeues'])
    .where('status', 'in', ['queued', 'processing'])
    .where('updated_at', '<', cutoff)
    .where((eb) => eb.or([eb('heartbeat_at', 'is', null), eb('heartbeat_at', '<', cutoff)]))
    .orderBy('updated_at')
    .limit(BATCH)
    .execute();
  for (const doc of documents) {
    if (await isLive(queues.prepare, jobId(doc.id, doc.attempt))) continue;
    if (doc.requeues >= config.MAX_REQUEUES) {
      const res = await db
        .updateTable('documents')
        .set({
          status: 'failed',
          error_code: 'max_attempts',
          error_message: ERROR_MESSAGES.max_attempts,
          updated_at: new Date(),
        })
        .where('id', '=', doc.id)
        .where('attempt', '=', doc.attempt)
        .where('status', 'in', ['queued', 'processing'])
        .executeTakeFirst();
      counts.failed += Number(res.numUpdatedRows);
      continue;
    }
    const next = doc.attempt + 1;
    // The row change is committed before the job is added: a worker that takes the job at once must find the new
    // attempt, since Postgres doesn't wait for an uncommitted change to a row that doesn't match the claim yet.
    const res = await db
      .updateTable('documents')
      .set({
        status: 'queued',
        attempt: next,
        requeues: doc.requeues + 1,
        heartbeat_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', doc.id)
      .where('attempt', '=', doc.attempt)
      .where('status', 'in', ['queued', 'processing'])
      .executeTakeFirst();
    if (!res.numUpdatedRows) continue;
    try {
      await enqueue(queues.prepare, { documentId: doc.id, attempt: next }, jobId(doc.id, next));
    } catch (err) {
      // The attempt stays new: an add that timed out may still land, and its job must find its attempt. If it never
      // lands, the next sweep finds no live job for this attempt and moves on to the one after.
      await db
        .updateTable('documents')
        .set({ requeues: doc.requeues })
        .where('id', '=', doc.id)
        .where('attempt', '=', next)
        .execute();
      throw err;
    }
    counts.requeued++;
  }

  const turns = await db
    .selectFrom('turns')
    .select(['id', 'attempt', 'requeues'])
    .where('status', '=', 'pending')
    .where('updated_at', '<', cutoff)
    .where((eb) => eb.or([eb('heartbeat_at', 'is', null), eb('heartbeat_at', '<', cutoff)]))
    .orderBy('updated_at')
    .limit(BATCH)
    .execute();
  for (const turn of turns) {
    if (await isLive(queues.answer, jobId(turn.id, turn.attempt))) continue;
    if (turn.requeues >= config.MAX_REQUEUES) {
      const res = await db
        .updateTable('turns')
        .set({ status: 'failed', stage: null, error_code: 'max_attempts', updated_at: new Date() })
        .where('id', '=', turn.id)
        .where('attempt', '=', turn.attempt)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      counts.failed += Number(res.numUpdatedRows);
      continue;
    }
    const next = turn.attempt + 1;
    const res = await db
      .updateTable('turns')
      .set({
        attempt: next,
        requeues: turn.requeues + 1,
        stage: null,
        heartbeat_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', turn.id)
      .where('attempt', '=', turn.attempt)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (!res.numUpdatedRows) continue;
    try {
      await enqueue(queues.answer, { turnId: turn.id, attempt: next }, jobId(turn.id, next));
    } catch (err) {
      await db
        .updateTable('turns')
        .set({ requeues: turn.requeues })
        .where('id', '=', turn.id)
        .where('attempt', '=', next)
        .execute();
      throw err;
    }
    counts.requeued++;
  }

  return counts;
}
