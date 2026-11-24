import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimKey, requestHash } from '../src/idempotency.js';
import { sweep } from '../src/jobs/sweep.js';
import { createQueues } from '../src/queue.js';
import { multipart, startStack } from './helpers/stack.js';

// Step 3b: retry endpoints, Idempotency-Key on every POST, and 503 "busy" when too much work waits.

vi.setConfig({ testTimeout: 20_000 });

const sample = readFileSync(
  new URL('../../samples/harbor-archive-pilot.md', import.meta.url),
  'utf8',
);
const answered = () =>
  JSON.stringify({
    outcome: 'answered',
    answer: 'Mira Chen.',
    quotes: ['Mira Chen owned the limited pilot.'],
  });

let stack: Awaited<ReturnType<typeof startStack>>;
let documentId: string;
beforeAll(async () => {
  stack = await startStack();
  stack.fake.script({ content: answered() });
  const res = await stack.app.inject({
    method: 'POST',
    url: '/documents',
    ...multipart({ content: sample }),
  });
  documentId = res.json().id;
  await waitFor(() => docRow(documentId), { status: 'ready' });
});
afterAll(() => stack?.stop());
beforeEach(() => stack.fake.script({ content: answered() }));

const keyed = (key?: string) => (key ? { 'idempotency-key': key } : {});
const post = (url: string, key?: string, payload?: object) =>
  stack.app.inject({ method: 'POST', url, headers: keyed(key), payload });

const docRow = (id: string) =>
  stack.db
    .selectFrom('documents')
    .select(['status', 'attempt', 'requeues', 'error_code', 'embedding_model'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
const turnRow = (id: string) =>
  stack.db
    .selectFrom('turns')
    .select(['status', 'attempt', 'requeues', 'error_code', 'outcome'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
async function waitFor<T>(read: () => Promise<T>, expected: Partial<T>) {
  await vi.waitFor(async () => expect(await read()).toMatchObject(expected), { timeout: 10_000 });
}

const insertDoc = async (values: Record<string, unknown>) =>
  (
    await stack.db
      .insertInto('documents')
      .values({ title: 'retry', format: 'markdown', content: sample, ...values })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
const newConversation = async () =>
  (
    await stack.db
      .insertInto('conversations')
      .values({ document_id: documentId })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
const insertTurn = async (conversation: string, values: Record<string, unknown> = {}) =>
  (
    await stack.db
      .insertInto('turns')
      .values({
        conversation_id: conversation,
        sequence: 1,
        question: 'Who owned the pilot?',
        ...values,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
const failedTurn = async () =>
  insertTurn(await newConversation(), { status: 'failed', error_code: 'model_unavailable' });
const failedDoc = () => insertDoc({ status: 'failed', error_code: 'model_unavailable' });

describe('retrying a document', () => {
  it('prepares a failed document again, with a fresh count of requeues', async () => {
    const id = await failedDoc();
    await stack.db.updateTable('documents').set({ requeues: 2 }).where('id', '=', id).execute();
    const res = await post(`/documents/${id}/retry`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id, status: 'queued', error: null });
    await waitFor(() => docRow(id), { status: 'ready', attempt: 2, requeues: 0 });
  });

  it('prepares again a document indexed with another embedding model', async () => {
    const id = await insertDoc({ status: 'ready', embedding_model: 'an-older-model' });
    expect((await post(`/documents/${id}/retry`)).statusCode).toBe(202);
    await waitFor(() => docRow(id), { status: 'ready', embedding_model: 'fake-embed' });
  });

  it('refuses a document that is ready with the current model, queued or processing', async () => {
    for (const status of ['ready', 'queued', 'processing']) {
      const id = await insertDoc({ status, embedding_model: 'fake-embed' });
      const res = await post(`/documents/${id}/retry`);
      expect([status, res.statusCode, res.json().error]).toEqual([status, 409, 'not_retryable']);
    }
    expect((await post(`/documents/${randomUUID()}/retry`)).statusCode).toBe(404);
  });
});

describe('retrying an answer', () => {
  it('answers a failed latest question again', async () => {
    const id = await failedTurn();
    const res = await post(`/messages/${id}/retry`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id, status: 'pending', error: null });
    await waitFor(() => turnRow(id), { status: 'completed', outcome: 'answered', attempt: 2 });
  });

  it('refuses a question that is not the latest, or did not fail', async () => {
    const conversation = await newConversation();
    const first = await insertTurn(conversation, {
      status: 'failed',
      error_code: 'model_rejected',
    });
    const second = await insertTurn(conversation, { sequence: 2, status: 'completed' });
    for (const id of [first, second]) {
      const res = await post(`/messages/${id}/retry`);
      expect([res.statusCode, res.json().error]).toEqual([409, 'not_retryable']);
    }
    expect((await post(`/messages/${randomUUID()}/retry`)).statusCode).toBe(404);
  });

  it('gives way with 409 answer_pending to a question asked at the same moment', async () => {
    const conversation = await newConversation();
    const first = await insertTurn(conversation, {
      status: 'failed',
      error_code: 'model_rejected',
    });
    // A second question inserted but not yet committed: the retry's check can't see it, the unique index can.
    let inserted = () => {};
    const asked = new Promise<void>((resolve) => (inserted = resolve));
    let commit = () => {};
    const held = new Promise<void>((resolve) => (commit = resolve));
    const question = stack.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('turns')
        .values({ conversation_id: conversation, sequence: 2, question: 'And the cost?' })
        .execute();
      inserted();
      await held;
    });
    await asked;
    const retry = post(`/messages/${first}/retry`);
    await vi.waitFor(async () => {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'
      `.execute(stack.db);
      expect(rows[0]!.n).toBeGreaterThan(0);
    });
    commit();
    await question;
    const res = await retry;
    expect([res.statusCode, res.json().error]).toEqual([409, 'answer_pending']);
  });

  it('refuses while the document is not ready', async () => {
    const doc = await insertDoc({ status: 'processing' });
    const conversation = (
      await stack.db
        .insertInto('conversations')
        .values({ document_id: doc })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const id = await insertTurn(conversation, {
      status: 'failed',
      error_code: 'model_unavailable',
    });
    const res = await post(`/messages/${id}/retry`);
    expect([res.statusCode, res.json().error]).toEqual([409, 'document_not_ready']);
  });
});

// Each POST, with the facts a test needs: how to send it (a variant is a different request) and whether it acted once.
const routes = [
  {
    route: 'an upload',
    async setup() {
      const title = randomUUID();
      return {
        send: (key: string, variant = false) =>
          stack.app.inject({
            method: 'POST',
            url: '/documents',
            ...(({ payload, headers }) => ({ payload, headers: { ...headers, ...keyed(key) } }))(
              multipart({ content: variant ? `${sample}\nMore.\n` : sample }, { title }),
            ),
          }),
        actedOnce: async () =>
          expect(
            await stack.db
              .selectFrom('documents')
              .select('id')
              .where('title', '=', title)
              .execute(),
          ).toHaveLength(1),
      };
    },
  },
  {
    route: 'a new conversation',
    async setup() {
      const doc = await insertDoc({ status: 'ready', embedding_model: 'fake-embed' });
      const other = await insertDoc({ status: 'ready', embedding_model: 'fake-embed' });
      return {
        send: (key: string, variant = false) =>
          post(`/documents/${variant ? other : doc}/conversations`, key),
        actedOnce: async () =>
          expect(
            await stack.db
              .selectFrom('conversations')
              .select('id')
              .where('document_id', '=', doc)
              .execute(),
          ).toHaveLength(1),
      };
    },
  },
  {
    route: 'a question',
    async setup() {
      const conversation = await newConversation();
      return {
        send: (key: string, variant = false) =>
          post(`/conversations/${conversation}/messages`, key, {
            question: variant ? 'What did the pilot cost?' : 'Who owned the pilot?',
          }),
        actedOnce: async () =>
          expect(
            await stack.db
              .selectFrom('turns')
              .select('id')
              .where('conversation_id', '=', conversation)
              .execute(),
          ).toHaveLength(1),
      };
    },
  },
  {
    route: 'a document retry',
    async setup() {
      const [doc, other] = [await failedDoc(), await failedDoc()];
      return {
        send: (key: string, variant = false) =>
          post(`/documents/${variant ? other : doc}/retry`, key),
        actedOnce: async () => expect((await docRow(doc)).attempt).toBe(2),
      };
    },
  },
  {
    route: 'an answer retry',
    async setup() {
      const [turn, other] = [await failedTurn(), await failedTurn()];
      return {
        send: (key: string, variant = false) =>
          post(`/messages/${variant ? other : turn}/retry`, key),
        actedOnce: async () => expect((await turnRow(turn)).attempt).toBe(2),
      };
    },
  },
];

describe.each(routes)('an Idempotency-Key on $route', ({ setup }) => {
  it('replays the first response byte for byte, and acts once', async () => {
    const { send, actedOnce } = await setup();
    const key = randomUUID();
    const first = await send(key);
    expect([201, 202]).toContain(first.statusCode);
    const again = await send(key);
    expect(again.statusCode).toBe(first.statusCode);
    expect(again.body).toBe(first.body);
    expect(again.headers['content-type']).toBe(first.headers['content-type']);
    await actedOnce();
  });

  it('refuses the same key for a different request with 422', async () => {
    const { send } = await setup();
    const key = randomUUID();
    expect([201, 202]).toContain((await send(key)).statusCode);
    const other = await send(key, true);
    expect([other.statusCode, other.json().error]).toEqual([422, 'idempotency_key_reused']);
  });
});

describe('a job that cannot be added', () => {
  // The queue counts still work (so the "busy" check passes); only adding the job fails, as when Redis drops then.
  const failNextAdd = (queue: unknown) =>
    vi.spyOn(queue as Queue, 'add').mockRejectedValueOnce(new Error('connection lost'));
  const keyRows = (key: string) =>
    stack.db.selectFrom('idempotency_keys').select('key').where('key', '=', key).execute();

  it('leaves no document behind and gives the key back', async () => {
    const title = randomUUID();
    const key = randomUUID();
    const upload = () =>
      stack.app.inject({
        method: 'POST',
        url: '/documents',
        ...(({ payload, headers }) => ({ payload, headers: { ...headers, ...keyed(key) } }))(
          multipart({ content: sample }, { title }),
        ),
      });
    failNextAdd(stack.queues.prepare);
    const res = await upload();
    expect([res.statusCode, res.json().error]).toEqual([503, 'queue_unavailable']);
    expect(
      await stack.db.selectFrom('documents').select('id').where('title', '=', title).execute(),
    ).toEqual([]);
    expect(await keyRows(key)).toEqual([]);
    expect((await upload()).statusCode).toBe(202);
  });

  it('leaves no question behind, so the conversation stays free, and gives the key back', async () => {
    const conversation = await newConversation();
    const key = randomUUID();
    const ask = () =>
      post(`/conversations/${conversation}/messages`, key, { question: 'Who owned the pilot?' });
    failNextAdd(stack.queues.answer);
    expect((await ask()).statusCode).toBe(503);
    expect(
      await stack.db
        .selectFrom('turns')
        .select('id')
        .where('conversation_id', '=', conversation)
        .execute(),
    ).toEqual([]);
    expect(await keyRows(key)).toEqual([]);
    expect((await ask()).statusCode).toBe(202);
  });

  it('puts a retried document back to failed, on its new attempt, and gives the key back', async () => {
    const id = await failedDoc();
    const key = randomUUID();
    failNextAdd(stack.queues.prepare);
    expect((await post(`/documents/${id}/retry`, key)).statusCode).toBe(503);
    expect(await docRow(id)).toMatchObject({
      status: 'failed',
      error_code: 'model_unavailable',
      attempt: 2,
    });
    expect(await keyRows(key)).toEqual([]);
    expect((await post(`/documents/${id}/retry`, key)).statusCode).toBe(202);
    await waitFor(() => docRow(id), { status: 'ready', attempt: 3 });
  });

  it('puts a retried document that was ready (with an older model) back to ready', async () => {
    const id = await insertDoc({ status: 'ready', embedding_model: 'an-older-model' });
    failNextAdd(stack.queues.prepare);
    expect((await post(`/documents/${id}/retry`)).statusCode).toBe(503);
    expect(await docRow(id)).toMatchObject({
      status: 'ready',
      embedding_model: 'an-older-model',
      attempt: 2,
    });
  });

  it('answers 409 to a repeat sent between storing the response and adding the job', async () => {
    const title = randomUUID();
    const key = randomUUID();
    const upload = () =>
      stack.app.inject({
        method: 'POST',
        url: '/documents',
        ...(({ payload, headers }) => ({ payload, headers: { ...headers, ...keyed(key) } }))(
          multipart({ content: sample }, { title }),
        ),
      });
    // The add starts, waits, then fails: the repeat arrives while the first request is in that gap.
    let started = () => {};
    const adding = new Promise<void>((resolve) => (started = resolve));
    let fail = () => {};
    const gate = new Promise<void>((resolve) => (fail = resolve));
    vi.spyOn(stack.queues.prepare as unknown as Queue, 'add').mockImplementationOnce(async () => {
      started();
      await gate;
      throw new Error('connection lost');
    });
    const first = upload();
    await adding;
    const repeat = await upload();
    expect([repeat.statusCode, repeat.json().error]).toEqual([409, 'request_in_progress']);
    fail();
    expect((await first).statusCode).toBe(503);
    expect((await upload()).statusCode).toBe(202);
  });

  it('puts a retried answer back to failed, on its new attempt, and gives the key back', async () => {
    const id = await failedTurn();
    const key = randomUUID();
    failNextAdd(stack.queues.answer);
    expect((await post(`/messages/${id}/retry`, key)).statusCode).toBe(503);
    expect(await turnRow(id)).toMatchObject({
      status: 'failed',
      error_code: 'model_unavailable',
      attempt: 2,
    });
    expect(await keyRows(key)).toEqual([]);
    expect((await post(`/messages/${id}/retry`, key)).statusCode).toBe(202);
    await waitFor(() => turnRow(id), { status: 'completed', attempt: 3 });
  });
});

describe('Idempotency-Key handling', () => {
  const scope = 'POST /conversations/:id/messages';
  const question = 'Who owned the pilot?';
  const insertKey = (conversation: string, values: Record<string, unknown>) =>
    stack.db
      .insertInto('idempotency_keys')
      .values({
        scope,
        key: values.key as string,
        request_hash: requestHash({ params: { id: conversation }, body: { question } }),
        claim: randomUUID(),
        state: 'in_flight',
        created_at: new Date(),
        expires_at: new Date(Date.now() + 3_600_000),
        ...values,
      })
      .execute();

  it('answers 409 while the first request with the key is still running, and takes over a stale one', async () => {
    const conversation = await newConversation();
    const key = randomUUID();
    await insertKey(conversation, { key });
    const res = await post(`/conversations/${conversation}/messages`, key, { question });
    expect([res.statusCode, res.json().error]).toEqual([409, 'request_in_progress']);

    // Held for longer than the takeover time: its request is presumed dead.
    await stack.db
      .updateTable('idempotency_keys')
      .set({ created_at: new Date(Date.now() - 120_000) })
      .where('key', '=', key)
      .execute();
    expect(
      (await post(`/conversations/${conversation}/messages`, key, { question })).statusCode,
    ).toBe(202);
  });

  it('replays a finished request even after what it checked has changed', async () => {
    const doc = await insertDoc({ status: 'ready', embedding_model: 'fake-embed' });
    const conversation = (
      await stack.db
        .insertInto('conversations')
        .values({ document_id: doc })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const key = randomUUID();
    const first = await post(`/conversations/${conversation}/messages`, key, { question });
    expect(first.statusCode).toBe(202);
    // Asked now, the same question would get 409 document_not_ready; repeated with its key, it gets its first answer.
    await stack.db
      .updateTable('documents')
      .set({ status: 'processing' })
      .where('id', '=', doc)
      .execute();
    const again = await post(`/conversations/${conversation}/messages`, key, { question });
    expect([again.statusCode, again.body]).toEqual([202, first.body]);
  });

  it('replays the stored response of a request that stopped after storing it', async () => {
    const conversation = await newConversation();
    const key = randomUUID();
    await insertKey(conversation, {
      key,
      status_code: 202,
      response: '{"stored":true}',
      created_at: new Date(Date.now() - 120_000),
    });
    const res = await post(`/conversations/${conversation}/messages`, key, { question });
    expect([res.statusCode, res.body]).toEqual([202, '{"stored":true}']);
  });

  it('treats an expired key as new', async () => {
    const conversation = await newConversation();
    const key = randomUUID();
    await insertKey(conversation, {
      key,
      state: 'done',
      request_hash: 'a different request',
      status_code: 202,
      response: '{}',
      expires_at: new Date(Date.now() - 1_000),
    });
    expect(
      (await post(`/conversations/${conversation}/messages`, key, { question })).statusCode,
    ).toBe(202);
  });

  it('gives the key back when the request fails, so the same key works once the cause is gone', async () => {
    const missing = randomUUID();
    const key = randomUUID();
    expect((await post(`/documents/${missing}/conversations`, key)).statusCode).toBe(404);
    await insertDoc({ id: missing, status: 'ready', embedding_model: 'fake-embed' });
    expect((await post(`/documents/${missing}/conversations`, key)).statusCode).toBe(201);
  });

  it('lets a request taken over record nothing: its transaction rolls back', async () => {
    const settings = { IDEMPOTENCY_KEY_TTL_MS: 3_600_000, IDEMPOTENCY_TAKEOVER_MS: 0 };
    const key = randomUUID();
    const first = await claimKey(stack.db, settings, 'test', key, 'same');
    const second = await claimKey(stack.db, settings, 'test', key, 'same');
    if (!('claim' in first) || !('claim' in second)) throw new Error('expected two claims');
    const conversation = randomUUID();
    await expect(
      stack.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('conversations')
          .values({ id: conversation, document_id: documentId })
          .execute();
        await first.claim.record(trx, 201, {});
      }),
    ).rejects.toMatchObject({ code: 'request_in_progress' });
    expect(
      await stack.db
        .selectFrom('conversations')
        .select('id')
        .where('id', '=', conversation)
        .execute(),
    ).toEqual([]);
    await stack.db.transaction().execute((trx) => second.claim.record(trx, 201, {}));
  });

  it('refuses a malformed key with 400', async () => {
    const conversation = await newConversation();
    for (const key of ['has space', 'x'.repeat(201)]) {
      const res = await post(`/conversations/${conversation}/messages`, key, { question });
      expect([res.statusCode, res.json().error]).toEqual([400, 'invalid_request']);
    }
  });

  it('purges expired keys in the sweep, even while Redis is unreachable', async () => {
    const key = randomUUID();
    await insertKey(randomUUID(), { key, expires_at: new Date(Date.now() - 1_000) });
    // A row old enough to need a Redis lookup, so a purge placed after the lookups would never run.
    const stale = await insertTurn(await newConversation(), {
      updated_at: new Date(Date.now() - 7_200_000),
    });
    const dead = createQueues('redis://127.0.0.1:1', `test-${randomUUID()}`, stack.deps.config);
    for (const q of Object.values(dead)) q.on('error', () => {});
    try {
      await expect(sweep(stack.deps, dead)).rejects.toThrow();
    } finally {
      await stack.db
        .updateTable('turns')
        .set({ status: 'failed' })
        .where('id', '=', stale)
        .execute();
      await Promise.race([
        Promise.allSettled(Object.values(dead).map((q) => q.close())),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    expect(
      await stack.db.selectFrom('idempotency_keys').select('key').where('key', '=', key).execute(),
    ).toEqual([]);
  });
});

describe('too much work waiting', () => {
  let small: Awaited<ReturnType<typeof startStack>>;
  beforeAll(async () => {
    small = await startStack({ MAX_WAITING_ANSWERS: 1, MAX_WAITING_DOCUMENTS: 1 });
  });
  afterAll(() => small?.stop());

  it('refuses new questions and answer retries with 503 busy, but still replays a finished request', async () => {
    small.fake.script({ content: answered() });
    const upload = await small.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({ content: sample }),
    });
    const doc = upload.json().id as string;
    await vi.waitFor(
      async () => expect((await small.app.inject(`/documents/${doc}`)).json().status).toBe('ready'),
      { timeout: 10_000 },
    );
    const conversation = async () =>
      (await small.app.inject({ method: 'POST', url: `/documents/${doc}/conversations` })).json()
        .id as string;
    const ask = async (c: string, key?: string) =>
      small.app.inject({
        method: 'POST',
        url: `/conversations/${c}/messages`,
        headers: keyed(key),
        payload: { question: 'Who owned the pilot?' },
      });

    await small.queues.answer.pause();
    try {
      const key = randomUUID();
      const c1 = await conversation();
      const first = await ask(c1, key);
      expect(first.statusCode).toBe(202);
      const busy = await ask(await conversation());
      expect([busy.statusCode, busy.json().error]).toEqual([503, 'busy']);
      expect(busy.headers['retry-after']).toBe('30');
      const replay = await ask(c1, key);
      expect([replay.statusCode, replay.body]).toEqual([202, first.body]);
      const failed = (
        await small.db
          .insertInto('turns')
          .values({
            conversation_id: await conversation(),
            sequence: 1,
            question: 'Who owned the pilot?',
            status: 'failed',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const retry = await small.app.inject({ method: 'POST', url: `/messages/${failed}/retry` });
      expect([retry.statusCode, retry.json().error]).toEqual([503, 'busy']);
    } finally {
      await small.queues.answer.resume();
    }
  });

  it('refuses new uploads and document retries with 503 busy', async () => {
    await small.queues.prepare.pause();
    try {
      const upload = () =>
        small.app.inject({ method: 'POST', url: '/documents', ...multipart({ content: sample }) });
      expect((await upload()).statusCode).toBe(202);
      const busy = await upload();
      expect([busy.statusCode, busy.json().error]).toEqual([503, 'busy']);
      const failed = (
        await small.db
          .insertInto('documents')
          .values({ title: 'retry', format: 'markdown', content: sample, status: 'failed' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const retry = await small.app.inject({ method: 'POST', url: `/documents/${failed}/retry` });
      expect([retry.statusCode, retry.json().error]).toEqual([503, 'busy']);
    } finally {
      await small.queues.prepare.resume();
    }
  });
});
