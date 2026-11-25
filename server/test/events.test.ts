import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { multipart, startStack } from './helpers/stack.js';

type Stack = Awaited<ReturnType<typeof startStack>>;

const sample = readFileSync(
  new URL('../../samples/harbor-archive-pilot.md', import.meta.url),
  'utf8',
);
const ANSWER = JSON.stringify({
  outcome: 'answered',
  answer: 'Mira Chen.',
  quotes: ['Mira Chen owned the limited pilot.'],
});
const STAGE_ORDER = ['rewriting', 'searching', 'writing', 'checking'];

// A real listening server and fetch, since the point is what arrives over the connection and when.
async function listen(s: Stack) {
  await s.app.listen({ host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${(s.app.server.address() as AddressInfo).port}`;
}

async function readyDocument(s: Stack) {
  const res = await s.app.inject({
    method: 'POST',
    url: '/documents',
    ...multipart({ content: sample }, { title: 'Harbor Archive' }),
  });
  expect(res.statusCode).toBe(202);
  const id = res.json().id as string;
  await vi.waitFor(
    async () => expect((await s.app.inject(`/documents/${id}`)).json().status).toBe('ready'),
    { timeout: 10_000 },
  );
  return id;
}

async function ask(s: Stack, documentId: string, question: string, conversationId?: string) {
  const c =
    conversationId ??
    (await s.app.inject({ method: 'POST', url: `/documents/${documentId}/conversations` })).json()
      .id;
  const res = await s.app.inject({
    method: 'POST',
    url: `/conversations/${c}/messages`,
    payload: { question },
  });
  expect(res.statusCode).toBe(202);
  return { id: res.json().id as string, conversationId: c as string };
}

const state = async (s: Stack, id: string) => (await s.app.inject(`/messages/${id}`)).json();

const hold = () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
};

// Queries held up by a table lock, by how they start.
const waitingOnLock = async (s: Stack, start: string) =>
  (
    await sql<{ n: number }>`
      select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query like ${`${start}%`}
    `.execute(s.db)
  ).rows[0]!.n;

// A queue event for a message without touching its row: progress on a parked job of a made-up attempt (a number,
// as job ids end in one).
let nudges = 1_000;
async function nudge(s: Stack, id: string) {
  let heard = false;
  const stop = s.answerEvents.subscribe(id, () => (heard = true));
  const job = await s.queues.answer.add(
    'nudge',
    { turnId: id, attempt: 0 },
    { jobId: `${id}-${nudges++}`, delay: 600_000 },
  );
  await job.updateProgress('nudge');
  // Every listener for the message runs in the same pass, so the stream's has run too.
  await vi.waitFor(() => expect(heard).toBe(true));
  stop();
}

// Holds every read of the turns table behind a lock, so a test can line up a read, a signal during it and a change
// queued right behind it. Only a second read, straight after the held one, can see that change before the heartbeat.
function holdReads(s: Stack) {
  const lock = hold();
  const locked = hold();
  const first = s.db.transaction().execute(async (trx) => {
    await sql`lock table turns in access exclusive mode`.execute(trx);
    locked.release();
    await lock.wait;
  });
  let queued: Promise<unknown> = Promise.resolve();
  return {
    locked: locked.wait,
    async changeBehind(id: string, stage: 'writing') {
      queued = s.db.transaction().execute(async (trx) => {
        await sql`lock table turns in access exclusive mode`.execute(trx);
        await trx.updateTable('turns').set({ stage }).where('id', '=', id).execute();
      });
      await vi.waitFor(async () => expect(await waitingOnLock(s, 'lock table turns')).toBe(1));
    },
    async release() {
      lock.release();
      await first;
      await queued;
    },
  };
}

interface SseBlock {
  event?: string;
  id?: string;
  data?: string;
  comment?: string;
}

// Reads a stream block by block as it arrives. `closed` settles when the server ends it or the client goes away.
// Plain node:http on a connection of its own: after an abort, fetch opens a spare connection that would keep the
// server from closing.
async function openStream(base: string, id: string) {
  const req = get(`${base}/messages/${id}/events`, { agent: false });
  const res = await new Promise<IncomingMessage>((resolve, reject) =>
    req.on('response', resolve).on('error', reject),
  );
  const blocks: SseBlock[] = [];
  let buffer = '';
  res.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const block: SseBlock = {};
      for (const line of buffer.slice(0, at).split('\n')) {
        const colon = line.indexOf(':');
        const field = line.slice(0, colon) as keyof SseBlock | '';
        block[field || 'comment'] = line.slice(colon + 1).replace(/^ /, '');
      }
      blocks.push(block);
      buffer = buffer.slice(at + 2);
    }
  });
  const closed = new Promise<void>((resolve) => res.on('close', resolve));
  const events = () =>
    blocks
      .filter((b) => b.event)
      .map((b) => ({ event: b.event, eventId: b.id, ...JSON.parse(b.data!) }));
  return { res, blocks, events, closed, abort: () => req.destroy() };
}

describe('progress stream, delivered by queue events', () => {
  let s: Stack;
  let base: string;
  let documentId: string;
  beforeAll(async () => {
    // A heartbeat a minute away: anything a test sees sooner came through a queue event. Retries a second apart, so
    // the retrying stage lasts long enough to see.
    s = await startStack({ STREAM_HEARTBEAT_MS: 60_000, JOB_BACKOFF_MS: 1_000 });
    base = await listen(s);
    documentId = await readyDocument(s);
  });
  afterAll(() => s.stop());

  it('sends the stored stage first, then live progress, then the final answer once, and closes', async () => {
    const embedding = hold();
    const chat = hold();
    s.fake.embeddingWait = embedding.wait;
    s.fake.script({ wait: chat.wait, content: ANSWER });
    const { id } = await ask(s, documentId, 'Who owned the pilot?');
    await vi.waitFor(async () => expect((await state(s, id)).stage).toBe('searching'));

    const stream = await openStream(base, id);
    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers).toMatchObject({
      'content-type': 'text/event-stream; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    await vi.waitFor(() => expect(stream.events().map((e) => e.stage)).toEqual(['searching']));

    s.fake.embeddingWait = undefined;
    embedding.release();
    // The model call is still held, so only the job's progress event can bring this.
    await vi.waitFor(() => expect(stream.events().at(-1)?.stage).toBe('writing'));
    chat.release();
    await stream.closed;

    const events = stream.events();
    const progress = events.slice(0, -1);
    expect(progress.every((e) => e.event === 'progress' && e.eventId === undefined)).toBe(true);
    // Pending events carry no answer text: nothing unverified is sent.
    expect(progress.every((e) => e.status === 'pending' && e.answer === null)).toBe(true);
    const stages = progress.map((e) => e.stage as string);
    expect(stages).not.toContain('rewriting');
    expect(stages).toEqual(
      [...stages].sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b)),
    );
    expect(events.filter((e) => e.event === 'final')).toHaveLength(1);
    const { event, eventId, ...final } = events.at(-1)!;
    expect({ event, eventId }).toEqual({ event: 'final', eventId: 'final' });
    expect(final).toMatchObject({ status: 'completed', answer: 'Mira Chen.' });
    // The same message GET returns, field for field.
    expect(final).toEqual(await state(s, id));
  });

  it('shows a follow-up being rewritten before the search', async () => {
    s.fake.script({ content: ANSWER });
    const first = await ask(s, documentId, 'Who owned the pilot?');
    await vi.waitFor(async () => expect((await state(s, first.id)).status).toBe('completed'));

    const rewrite = hold();
    s.fake.script(
      { wait: rewrite.wait, content: JSON.stringify({ question: 'Who owned the pilot?' }) },
      { content: ANSWER },
    );
    const { id } = await ask(s, documentId, 'And who owned it?', first.conversationId);
    await vi.waitFor(async () => expect((await state(s, id)).stage).toBe('rewriting'));
    const stream = await openStream(base, id);
    await vi.waitFor(() => expect(stream.events()[0]?.stage).toBe('rewriting'));
    rewrite.release();
    await stream.closed;
    expect(stream.events().at(-1)).toMatchObject({ event: 'final', status: 'completed' });
  });

  it('gives a client arriving after the end the stored answer once, and a reconnect after it 204', async () => {
    s.fake.script({ content: ANSWER });
    const { id } = await ask(s, documentId, 'Who owned the pilot?');
    await vi.waitFor(async () => expect((await state(s, id)).status).toBe('completed'));

    const stream = await openStream(base, id);
    await stream.closed;
    expect(stream.blocks).toHaveLength(1);
    expect(stream.events()[0]).toMatchObject({
      event: 'final',
      eventId: 'final',
      answer: 'Mira Chen.',
    });

    // What EventSource sends when it reconnects after the final event.
    const again = await fetch(`${base}/messages/${id}/events`, {
      headers: { 'last-event-id': 'final' },
    });
    expect(again.status).toBe(204);
  });

  it('answers an unknown message with 404 and a malformed id with 400, as JSON', async () => {
    const missing = await fetch(`${base}/messages/${randomUUID()}/events`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'not_found' });
    const malformed = await fetch(`${base}/messages/not-an-id/events`);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: 'invalid_request' });
    expect(s.answerEvents.watching()).toBe(0);
  });

  it('shows a retry, then follows the next attempt to the answer', async () => {
    s.fake.script({ status: 503 }, { content: ANSWER });
    const { id } = await ask(s, documentId, 'Who owned the pilot?');
    const stream = await openStream(base, id);
    await stream.closed;
    const stages = stream.events().map((e) => e.stage);
    expect(stages).toContain('retrying');
    // The second attempt is followed too: a stage after the retry, then the answer.
    expect(stages.slice(stages.indexOf('retrying') + 1)).toContain('writing');
    expect(stream.events().at(-1)).toMatchObject({ event: 'final', status: 'completed' });
  });

  it('brings an answer that ends without a progress event at once, through the completed event', async () => {
    await s.stopWorkers();
    try {
      const { id } = await ask(s, documentId, 'Who owned the pilot?');
      const stream = await openStream(base, id);
      await vi.waitFor(() => expect(stream.events().map((e) => e.stage)).toEqual([null]));
      // The job fails on its first check, before any stage, so its end is the only event.
      await s.db
        .updateTable('documents')
        .set({ embedding_model: 'another-model' })
        .where('id', '=', documentId)
        .execute();
      s.restartWorkers();
      await stream.closed;
      expect(stream.events().at(-1)).toMatchObject({
        event: 'final',
        status: 'failed',
        error: { code: 'embedding_model_changed' },
      });
    } finally {
      await s.db
        .updateTable('documents')
        .set({ embedding_model: 'fake-embed' })
        .where('id', '=', documentId)
        .execute();
    }
  });

  it('forgets a client that goes away during the first read', async () => {
    // Pending, so a stream that missed the client leaving would stay open.
    const embedding = hold();
    s.fake.embeddingWait = embedding.wait;
    s.fake.script({ content: ANSWER });
    try {
      const { id } = await ask(s, documentId, 'Who owned the pilot?');
      await vi.waitFor(async () => expect((await state(s, id)).stage).toBe('searching'));
      // A lock holds the stream's first read until the client has gone.
      await s.db.transaction().execute(async (trx) => {
        await sql`lock table turns in access exclusive mode`.execute(trx);
        const req = get(`${base}/messages/${id}/events`, { agent: false }).on('error', () => {});
        await vi.waitFor(() => expect(s.answerEvents.watching()).toBe(1));
        req.destroy();
      });
      await vi.waitFor(() => expect(s.answerEvents.watching()).toBe(0));
      s.fake.embeddingWait = undefined;
      embedding.release();
      await vi.waitFor(async () => expect((await state(s, id)).status).toBe('completed'));
    } finally {
      s.fake.embeddingWait = undefined;
      embedding.release();
    }
  });

  it('reads again at once when a change is signalled during its first read', async () => {
    const embedding = hold();
    s.fake.embeddingWait = embedding.wait;
    s.fake.script({ content: ANSWER });
    try {
      const { id } = await ask(s, documentId, 'Who owned the pilot?');
      await vi.waitFor(async () => expect((await state(s, id)).stage).toBe('searching'));
      const reads = holdReads(s);
      let opening: ReturnType<typeof openStream> | undefined;
      try {
        await reads.locked;
        opening = openStream(base, id);
        await vi.waitFor(async () => expect(await waitingOnLock(s, 'select')).toBe(1));
        await nudge(s, id);
        await reads.changeBehind(id, 'writing');
      } finally {
        await reads.release();
      }
      const stream = await opening!;
      await vi.waitFor(() =>
        expect(stream.events().map((e) => e.stage)).toEqual(['searching', 'writing']),
      );
      stream.abort();
    } finally {
      s.fake.embeddingWait = undefined;
      embedding.release();
    }
  });

  it('reads again at once when a change is signalled during a later read', async () => {
    const embedding = hold();
    s.fake.embeddingWait = embedding.wait;
    s.fake.script({ content: ANSWER });
    try {
      const { id } = await ask(s, documentId, 'Who owned the pilot?');
      await vi.waitFor(async () => expect((await state(s, id)).stage).toBe('searching'));
      const stream = await openStream(base, id);
      await vi.waitFor(() => expect(stream.events()).toHaveLength(1));
      const reads = holdReads(s);
      try {
        await reads.locked;
        // The first signal starts a read that waits on the lock; the second comes while it waits.
        await nudge(s, id);
        await vi.waitFor(async () => expect(await waitingOnLock(s, 'select')).toBe(1));
        await nudge(s, id);
        await reads.changeBehind(id, 'writing');
      } finally {
        await reads.release();
      }
      await vi.waitFor(() =>
        expect(stream.events().map((e) => e.stage)).toEqual(['searching', 'writing']),
      );
      stream.abort();
    } finally {
      s.fake.embeddingWait = undefined;
      embedding.release();
    }
  });

  it('forgets a client that goes away', async () => {
    const embedding = hold();
    s.fake.embeddingWait = embedding.wait;
    s.fake.script({ content: ANSWER });
    try {
      const { id } = await ask(s, documentId, 'Who owned the pilot?');
      await vi.waitFor(async () => expect((await state(s, id)).stage).toBe('searching'));
      const stream = await openStream(base, id);
      await vi.waitFor(() => expect(stream.events()).toHaveLength(1));
      expect(s.answerEvents.watching()).toBe(1);
      stream.abort();
      await vi.waitFor(() => expect(s.answerEvents.watching()).toBe(0));
      s.fake.embeddingWait = undefined;
      embedding.release();
      await vi.waitFor(async () => expect((await state(s, id)).status).toBe('completed'));
    } finally {
      s.fake.embeddingWait = undefined;
      embedding.release();
    }
  });
});

describe('progress stream, without queue events', () => {
  let s: Stack;
  let base: string;
  let documentId: string;
  beforeAll(async () => {
    s = await startStack({ STREAM_HEARTBEAT_MS: 200 });
    // As if Redis had dropped every event: only the heartbeat's re-read is left.
    await s.answerEvents.close();
    base = await listen(s);
    documentId = await readyDocument(s);
  });
  afterAll(() => s.stop());

  it('still ends with the answer', async () => {
    const embedding = hold();
    s.fake.embeddingWait = embedding.wait;
    s.fake.script({ content: ANSWER });
    try {
      const { id } = await ask(s, documentId, 'Who owned the pilot?');
      await vi.waitFor(async () => expect((await state(s, id)).stage).toBe('searching'));
      const stream = await openStream(base, id);
      await vi.waitFor(() => expect(stream.events()).toHaveLength(1));
      s.fake.embeddingWait = undefined;
      embedding.release();
      await stream.closed;
      expect(stream.events().at(-1)).toMatchObject({ event: 'final', status: 'completed' });
    } finally {
      s.fake.embeddingWait = undefined;
      embedding.release();
    }
  });

  it('ends with a failure that no job reported, such as the sweeper giving up', async () => {
    const embedding = hold();
    s.fake.embeddingWait = embedding.wait;
    s.fake.script({ content: ANSWER });
    try {
      const { id } = await ask(s, documentId, 'Who owned the pilot?');
      await vi.waitFor(async () => expect((await state(s, id)).stage).toBe('searching'));
      const stream = await openStream(base, id);
      // Several heartbeats re-read the row; an unchanged stage is sent once.
      await vi.waitFor(() =>
        expect(stream.blocks.filter((b) => b.comment === 'heartbeat').length).toBeGreaterThan(2),
      );
      expect(stream.events()).toHaveLength(1);
      // What the sweeper writes for an answer out of attempts (sweep.ts).
      await s.db
        .updateTable('turns')
        .set({ status: 'failed', stage: null, error_code: 'max_attempts', updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      await stream.closed;
      expect(stream.events().at(-1)).toMatchObject({
        event: 'final',
        status: 'failed',
        error: { code: 'max_attempts' },
      });
    } finally {
      s.fake.embeddingWait = undefined;
      embedding.release();
    }
  });
});

describe('progress stream at shutdown', () => {
  it('refuses a stream whose first read was still running when shutdown began, so the server can stop', async () => {
    const s = await startStack({ STREAM_HEARTBEAT_MS: 60_000 });
    try {
      const base = await listen(s);
      const documentId = await readyDocument(s);
      s.fake.script({ content: ANSWER });
      const { id } = await ask(s, documentId, 'Who owned the pilot?');
      await vi.waitFor(async () => expect((await state(s, id)).status).toBe('completed'));
      let status: number | undefined;
      let closing: Promise<void> | undefined;
      await s.db.transaction().execute(async (trx) => {
        await sql`lock table turns in access exclusive mode`.execute(trx);
        get(`${base}/messages/${id}/events`, { agent: false }, (res) => {
          status = res.statusCode;
          res.resume();
        });
        await vi.waitFor(() => expect(s.answerEvents.watching()).toBe(1));
        closing = s.app.close();
      });
      await closing;
      await vi.waitFor(() => expect(status).toBe(503));
    } finally {
      await s.stop();
    }
  }, 15_000);

  it('is ended, so the server can stop', async () => {
    const s = await startStack({ STREAM_HEARTBEAT_MS: 60_000 });
    const embedding = hold();
    try {
      const base = await listen(s);
      const documentId = await readyDocument(s);
      s.fake.embeddingWait = embedding.wait;
      s.fake.script({ content: ANSWER });
      const { id } = await ask(s, documentId, 'Who owned the pilot?');
      await vi.waitFor(async () => expect((await state(s, id)).stage).toBe('searching'));
      const stream = await openStream(base, id);
      await vi.waitFor(() => expect(stream.events()).toHaveLength(1));
      await s.app.close();
      await stream.closed;
      expect(stream.events()).toHaveLength(1);
    } finally {
      embedding.release();
      await s.stop();
    }
  }, 15_000);
});
