import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sweep } from '../src/jobs/sweep.js';
import { createModel } from '../src/model.js';
import { createQueues, jobId, modelStatusKey, type Queues } from '../src/queue.js';
import type { ChatRequest } from './helpers/fake-model.js';
import { multipart, startStack } from './helpers/stack.js';

// The failure table (DESIGN.md) against the fake model server, with real BullMQ workers: the thinking-off retry,
// job retries with backoff, shrinking the passages, the follow-up rewrite, shutdown, the job time limit, heartbeats,
// the sweeper and the start-up model check.

// Retries with backoff and call timeouts make some of these take a few seconds.
vi.setConfig({ testTimeout: 20_000 });

const sample = readFileSync(
  new URL('../../samples/harbor-archive-pilot.md', import.meta.url),
  'utf8',
);
const never = new Promise<void>(() => {});
const answered = (quotes = ['Mira Chen owned the limited pilot.']) =>
  JSON.stringify({ outcome: 'answered', answer: 'Mira Chen.', quotes });
const kind = (r: ChatRequest) =>
  (r.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;
const answerCalls = (requests: ChatRequest[]) => requests.filter((r) => kind(r) === 'answer');
const passagesOf = (r: ChatRequest) => {
  const user = r.messages.find((m) => m.role === 'user')!.content;
  const block = /kind="passages">\n([\s\S]*?)\n<\/data-/.exec(user)![1]!;
  return block.split(/(?:^|\n\n)\[\d+\]\n/).filter(Boolean);
};

let stack: Awaited<ReturnType<typeof startStack>>;
let documentId: string;
beforeAll(async () => {
  // Short call timeouts, frequent heartbeats, and a budget that fits the sample's three passages but not in half.
  stack = await startStack({
    MODEL_TIMEOUT_MS: 1_000,
    CHAT_RETRY_TIMEOUT_MS: 1_000,
    REWRITE_TIMEOUT_MS: 1_000,
    HEARTBEAT_MS: 100,
    PASSAGE_TOKEN_BUDGET: 500,
  });
  documentId = await upload();
});
afterAll(() => stack?.stop());

async function upload() {
  const res = await stack.app.inject({
    method: 'POST',
    url: '/documents',
    ...multipart({ content: sample }),
  });
  expect(res.statusCode).toBe(202);
  const id = res.json().id as string;
  await waitForDocument(id, 'ready');
  return id;
}

async function waitForDocument(id: string, status: string) {
  await vi.waitFor(
    async () => expect((await stack.app.inject(`/documents/${id}`)).json().status).toBe(status),
    { timeout: 10_000 },
  );
}

async function ask(question: string, conversation?: string) {
  const c =
    conversation ??
    (
      await stack.app.inject({ method: 'POST', url: `/documents/${documentId}/conversations` })
    ).json().id;
  const res = await stack.app.inject({
    method: 'POST',
    url: `/conversations/${c}/messages`,
    payload: { question },
  });
  expect(res.statusCode).toBe(202);
  return { conversation: c as string, turnId: res.json().id as string };
}

async function finished(turnId: string) {
  let body: Record<string, unknown> = {};
  await vi.waitFor(
    async () => {
      const res = await stack.app.inject(`/messages/${turnId}`);
      expect(res.statusCode).toBe(200);
      body = res.json();
      expect(body.status).not.toBe('pending');
    },
    { timeout: 15_000 },
  );
  return body as { status: string; outcome: string | null; error: { code: string } | null };
}

const turnRow = (id: string) =>
  stack.db
    .selectFrom('turns')
    .select([
      'status',
      'attempt',
      'requeues',
      'answer_path',
      'search_question',
      'debug',
      'heartbeat_at',
    ])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

describe('the thinking-off retry', () => {
  it.each([
    ['hits its token cap', { finish: 'length', content: '{"outcome":' }],
    ['returns something other than JSON', { content: 'Sure, here it is.' }],
    ['takes longer than its timeout', { wait: never }],
  ])('follows a first call that %s, and records that path', async (_label, first) => {
    stack.fake.chatRequests = [];
    stack.fake.script(first, { content: answered() });
    const { turnId } = await ask('Who owned the pilot?');
    expect(await finished(turnId)).toMatchObject({ status: 'completed', outcome: 'answered' });

    const [on, off] = answerCalls(stack.fake.chatRequests);
    expect(on).not.toHaveProperty('reasoning_effort');
    expect(off).toMatchObject({ reasoning_effort: 'none', temperature: 0 });
    const row = await turnRow(turnId);
    expect(row.answer_path).toBe('thinking_off_retry');
    expect(row.debug).toHaveProperty('firstCall');
  });

  it('treats an empty reply body like an unusable reply', async () => {
    stack.fake.chatRequests = [];
    stack.fake.script({ raw: '' }, { content: answered() });
    const { turnId } = await ask('Who owned the pilot?');
    expect(await finished(turnId)).toMatchObject({ status: 'completed', outcome: 'answered' });
    expect((await turnRow(turnId)).answer_path).toBe('thinking_off_retry');
  });

  it('fails with model_bad_output when the retry is unusable too', async () => {
    stack.fake.chatRequests = [];
    stack.fake.script({ finish: 'length', content: '{' }, { content: 'still not JSON' });
    const { turnId } = await ask('Who owned the pilot?');
    expect(await finished(turnId)).toMatchObject({
      status: 'failed',
      error: { code: 'model_bad_output' },
    });
    expect(answerCalls(stack.fake.chatRequests)).toHaveLength(2);
  });
});

describe('job retries', () => {
  it('runs the job again after a 429 and answers on the next attempt', async () => {
    stack.fake.chatRequests = [];
    stack.fake.script({ status: 429 }, { content: answered() });
    const { turnId } = await ask('Who owned the pilot?');
    expect(await finished(turnId)).toMatchObject({ status: 'completed', outcome: 'answered' });
    expect(answerCalls(stack.fake.chatRequests)).toHaveLength(2);
    // BullMQ counts every finished attempt, the successful one included.
    const job = await stack.queues.answer.getJob(jobId(turnId, 1));
    expect(job?.attemptsMade).toBe(2);
  });

  it('runs the job again after a reply body cut off half way', async () => {
    stack.fake.chatRequests = [];
    stack.fake.script({ raw: '{"choices":[{"mess' }, { content: answered() });
    const { turnId } = await ask('Who owned the pilot?');
    expect(await finished(turnId)).toMatchObject({ status: 'completed', outcome: 'answered' });
    expect((await turnRow(turnId)).answer_path).toBe('thinking');
    expect(answerCalls(stack.fake.chatRequests)).toHaveLength(2);
  });

  it('runs the job again when the thinking-off retry also times out', async () => {
    stack.fake.chatRequests = [];
    stack.fake.script({ wait: never }, { wait: never }, { content: answered() });
    const { turnId } = await ask('Who owned the pilot?');
    expect(await finished(turnId)).toMatchObject({ status: 'completed', outcome: 'answered' });
    expect((await turnRow(turnId)).answer_path).toBe('thinking');
    expect(answerCalls(stack.fake.chatRequests)).toHaveLength(3);
  });

  it('gives up with model_unavailable after the last of three attempts', async () => {
    stack.fake.chatRequests = [];
    stack.fake.script({ status: 503 });
    const { turnId } = await ask('Who owned the pilot?');
    expect(await finished(turnId)).toMatchObject({
      status: 'failed',
      error: { code: 'model_unavailable' },
    });
    expect(answerCalls(stack.fake.chatRequests)).toHaveLength(3);
  });

  it('runs preparation again after the embedding model answers 503', async () => {
    stack.fake.embeddingErrors = [{ status: 503 }];
    await upload();
    expect(stack.fake.embeddingErrors).toEqual([]);
  });

  it('fails preparation with internal_error when a passage is too long for the embedding model', async () => {
    stack.fake.embeddingErrors = [
      { status: 400, message: 'input exceeds the available context size' },
    ];
    const res = await stack.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({ content: sample }),
    });
    const id = res.json().id as string;
    await waitForDocument(id, 'failed');
    expect((await stack.app.inject(`/documents/${id}`)).json().error.code).toBe('internal_error');
  });
});

describe('a prompt too long for the model context', () => {
  const tooLong = {
    status: 400,
    body: { error: { message: 'The number of tokens exceeds the available context size' } },
  };

  it('is sent again once with half the passages, and quotes are checked against those', async () => {
    stack.fake.chatRequests = [];
    let calls = 0;
    stack.fake.onChat = (req) => {
      if (calls++ === 0) return tooLong;
      // One quote from a passage still sent, one from a passage dropped by the shrinking.
      const [first] = answerCalls(stack.fake.chatRequests).map(passagesOf);
      const kept = passagesOf(req);
      const dropped = first!.find((p) => !kept.includes(p))!;
      return { content: answered([kept[0]!.slice(20, 60), dropped.slice(20, 60)]) };
    };
    const { turnId } = await ask('Who owned the pilot?');
    expect(await finished(turnId)).toMatchObject({ status: 'completed', outcome: 'answered' });

    const [before, after] = answerCalls(stack.fake.chatRequests).map(passagesOf);
    expect(before).toHaveLength(3);
    expect(after!.length).toBeLessThan(3);
    const turn = (await stack.app.inject(`/messages/${turnId}`)).json();
    expect(turn.quotes).toHaveLength(1);
    expect((await turnRow(turnId)).debug).toMatchObject({ shrunk: true });
  });

  it('fails with context_too_long when half the passages are still too many', async () => {
    stack.fake.chatRequests = [];
    stack.fake.script(tooLong);
    const { turnId } = await ask('Who owned the pilot?');
    expect(await finished(turnId)).toMatchObject({
      status: 'failed',
      error: { code: 'context_too_long' },
    });
    expect(answerCalls(stack.fake.chatRequests)).toHaveLength(2);
  });
});

describe('follow-up questions', () => {
  const firstTurn = async () => {
    stack.fake.script({
      content: answered(['Median response time was 0.7 seconds for keyword search']),
    });
    const { conversation, turnId } = await ask('How fast was keyword search?');
    await finished(turnId);
    stack.fake.chatRequests = [];
    return conversation;
  };

  it('are searched with a standalone version written by the model', async () => {
    const conversation = await firstTurn();
    stack.fake.onChat = (req) =>
      kind(req) === 'rewrite'
        ? { content: JSON.stringify({ question: 'How fast was the hybrid prototype?' }) }
        : { content: answered(['1.2 seconds for the hybrid prototype']) };
    const { turnId } = await ask('And the hybrid one?', conversation);
    expect(await finished(turnId)).toMatchObject({ status: 'completed', outcome: 'answered' });

    expect((await turnRow(turnId)).search_question).toBe('How fast was the hybrid prototype?');
    const rewrite = stack.fake.chatRequests.find((r) => kind(r) === 'rewrite')!;
    expect(rewrite).toMatchObject({ reasoning_effort: 'none', temperature: 0 });
    const user = rewrite.messages.find((m) => m.role === 'user')!.content;
    expect(user).toMatch(/kind="earlier-turns">\nQ: How fast was keyword search\?/);
    expect(user).toMatch(/kind="question">\nAnd the hybrid one\?\n/);
    // The answer call still gets the question as asked.
    const answer = answerCalls(stack.fake.chatRequests)[0]!.messages.find((m) => m.role === 'user');
    expect(answer!.content).toMatch(/kind="question">\nAnd the hybrid one\?\n/);
  });

  it.each([
    ['is unusable', { content: 'not JSON' }],
    ['takes longer than its timeout', { wait: never }],
  ])(
    'fall back to the last two questions together when the rewrite %s',
    async (_label, rewrite) => {
      const conversation = await firstTurn();
      stack.fake.onChat = (req) => (kind(req) === 'rewrite' ? rewrite : { content: answered() });
      const { turnId } = await ask('And the hybrid one?', conversation);
      await finished(turnId);
      const row = await turnRow(turnId);
      expect(row.search_question).toBe('How fast was keyword search? And the hybrid one?');
      expect(row.debug).toHaveProperty('rewriteFailed');
    },
  );

  it('run the job again when the rewrite finds the model server down', async () => {
    const conversation = await firstTurn();
    let rewrites = 0;
    stack.fake.onChat = (req) =>
      kind(req) !== 'rewrite'
        ? { content: answered() }
        : rewrites++ === 0
          ? { status: 503 }
          : { content: JSON.stringify({ question: 'How fast was the hybrid prototype?' }) };
    const { turnId } = await ask('And the hybrid one?', conversation);
    await finished(turnId);
    expect(rewrites).toBe(2);
    expect((await turnRow(turnId)).search_question).toBe('How fast was the hybrid prototype?');
  });
});

describe('a running job', () => {
  it('touches its heartbeat while it waits for the model', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    stack.fake.chatRequests = [];
    stack.fake.script({ wait: held, content: answered() });
    const { turnId } = await ask('Who owned the pilot?');
    await vi.waitFor(() => expect(stack.fake.chatRequests).toHaveLength(1));
    const first = (await turnRow(turnId)).heartbeat_at!;
    await vi.waitFor(async () =>
      expect((await turnRow(turnId)).heartbeat_at!.getTime()).toBeGreaterThan(first.getTime()),
    );
    release();
    await finished(turnId);
  });

  it('goes back to the queue without spending an attempt when the worker stops, and runs on restart', async () => {
    stack.fake.chatRequests = [];
    stack.fake.script({ wait: never });
    const { turnId } = await ask('Who owned the pilot?');
    await vi.waitFor(() => expect(stack.fake.chatRequests).toHaveLength(1));

    await stack.stopWorkers();
    const job = await stack.queues.answer.getJob(jobId(turnId, 1));
    expect(['delayed', 'waiting']).toContain(await job!.getState());
    expect(job!.attemptsMade).toBe(0);
    expect((await turnRow(turnId)).status).toBe('pending');

    stack.fake.script({ content: answered() });
    stack.restartWorkers();
    expect(await finished(turnId)).toMatchObject({ status: 'completed', outcome: 'answered' });
  });
});

describe('the job time limit', () => {
  let limited: Awaited<ReturnType<typeof startStack>>;
  beforeAll(async () => {
    limited = await startStack({ ANSWER_JOB_TIMEOUT_MS: 1_500 });
  });
  afterAll(() => limited?.stop());

  it('fails an answer that runs past it with model_unavailable', async () => {
    const doc = (
      await limited.app.inject({
        method: 'POST',
        url: '/documents',
        ...multipart({ content: sample }),
      })
    ).json().id as string;
    await vi.waitFor(
      async () =>
        expect((await limited.app.inject(`/documents/${doc}`)).json().status).toBe('ready'),
      { timeout: 10_000 },
    );
    const c = (
      await limited.app.inject({ method: 'POST', url: `/documents/${doc}/conversations` })
    ).json().id;
    limited.fake.script({ wait: never });
    const id = (
      await limited.app.inject({
        method: 'POST',
        url: `/conversations/${c}/messages`,
        payload: { question: 'Who owned the pilot?' },
      })
    ).json().id as string;
    await vi.waitFor(
      async () => {
        const turn = (await limited.app.inject(`/messages/${id}`)).json();
        expect(turn).toMatchObject({ status: 'failed', error: { code: 'model_unavailable' } });
      },
      { timeout: 5_000 },
    );
    expect(limited.fake.chatRequests).toHaveLength(1);
  });
});

describe('the sweeper', () => {
  // The sweeper's own rows are made to look an hour old, so sweeps at the real time pick them up but not rows other
  // test files left unfinished moments ago.
  const hourAgo = () => new Date(Date.now() - 3_600_000);
  const insertDoc = (values: Record<string, unknown> = {}) =>
    stack.db
      .insertInto('documents')
      .values({
        title: 'swept',
        format: 'markdown',
        content: sample,
        updated_at: hourAgo(),
        ...values,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  const docRow = (id: string) =>
    stack.db
      .selectFrom('documents')
      .select(['status', 'attempt', 'requeues', 'error_code'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const insertTurn = async (values: Record<string, unknown> = {}) => {
    const conversation = await stack.db
      .insertInto('conversations')
      .values({ document_id: documentId })
      .returning('id')
      .executeTakeFirstOrThrow();
    return stack.db
      .insertInto('turns')
      .values({
        conversation_id: conversation.id,
        sequence: 1,
        question: 'Who owned the pilot?',
        updated_at: hourAgo(),
        ...values,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  };

  it('queues again a document whose job was lost, and it gets prepared', async () => {
    const doc = await insertDoc();
    await sweep(stack.deps, stack.queues);
    expect(await docRow(doc.id)).toMatchObject({ attempt: 2, requeues: 1 });
    await waitForDocument(doc.id, 'ready');
  });

  it('queues again a question whose job was lost, and it gets answered', async () => {
    stack.fake.script({ content: answered() });
    const turn = await insertTurn();
    await sweep(stack.deps, stack.queues);
    expect(await turnRow(turn.id)).toMatchObject({ attempt: 2, requeues: 1 });
    expect(await finished(turn.id)).toMatchObject({ status: 'completed', outcome: 'answered' });
  });

  it('leaves alone a row touched recently, or with a recent heartbeat, even with no job', async () => {
    const fresh = await insertDoc({ updated_at: new Date() });
    const beating = await insertDoc({ heartbeat_at: new Date() });
    await sweep(stack.deps, stack.queues);
    for (const doc of [fresh, beating]) {
      expect(await docRow(doc.id)).toMatchObject({ status: 'queued', attempt: 1, requeues: 0 });
    }
    // Finished, so later sweeps in this file leave them alone too.
    await stack.db
      .updateTable('documents')
      .set({ status: 'failed' })
      .where('id', 'in', [fresh.id, beating.id])
      .execute();
  });

  it('leaves a row alone while its job is still waiting', async () => {
    stack.fake.script({ content: answered() });
    await stack.queues.answer.pause();
    try {
      const turn = await insertTurn();
      await stack.queues.answer.add(
        'answer',
        { turnId: turn.id, attempt: 1 },
        { jobId: jobId(turn.id, 1) },
      );
      await sweep(stack.deps, stack.queues);
      expect(await turnRow(turn.id)).toMatchObject({ attempt: 1, requeues: 0, status: 'pending' });
    } finally {
      await stack.queues.answer.resume();
    }
  });

  it('counts no requeue when the new job cannot be added, and keeps the new attempt', async () => {
    const doc = await insertDoc();
    // A queue that finds no job for this row (so it needs one) but can't add one, as when Redis drops mid-sweep.
    // Every other row's job looks alive, so this row is the one the sweep acts on.
    const failing = {
      getJob: async (id: string) =>
        id === jobId(doc.id, 1) ? undefined : { getState: async () => 'waiting' },
      add: async () => {
        throw new Error('connection lost');
      },
    };
    const queues = { prepare: failing, answer: failing } as unknown as Queues;
    await expect(sweep(stack.deps, queues)).rejects.toThrow('connection lost');
    expect(await docRow(doc.id)).toMatchObject({ status: 'queued', attempt: 2, requeues: 0 });
    // As if the add had landed after all: the job for the new attempt runs.
    await stack.queues.prepare.add(
      'prepare',
      { documentId: doc.id, attempt: 2 },
      { jobId: jobId(doc.id, 2) },
    );
    await waitForDocument(doc.id, 'ready');
  });

  it('commits the new attempt before adding the job, so a worker that takes it at once finds it', async () => {
    const doc = await insertDoc();
    // Waits for the job to finish before returning, so the worker always runs it before the sweep goes on.
    const waiting = {
      name: 'prepare',
      getJob: (id: string) => stack.queues.prepare.getJob(id),
      add: async (...args: Parameters<typeof stack.queues.prepare.add>) => {
        const job = await stack.queues.prepare.add(...args);
        await vi.waitFor(async () => expect(await job.getState()).toBe('completed'), {
          timeout: 1_900,
        });
        return job;
      },
    };
    await sweep(stack.deps, { prepare: waiting, answer: stack.queues.answer } as unknown as Queues);
    expect(await docRow(doc.id)).toMatchObject({ status: 'ready', attempt: 2 });
  });

  it('fails a row with max_attempts once its requeues are used up', async () => {
    const doc = await insertDoc({ requeues: 2 });
    await sweep(stack.deps, stack.queues);
    expect(await docRow(doc.id)).toMatchObject({
      status: 'failed',
      attempt: 1,
      error_code: 'max_attempts',
    });
  });

  it('fails a question with max_attempts once its requeues are used up', async () => {
    const turn = await insertTurn({ requeues: 2 });
    await sweep(stack.deps, stack.queues);
    const row = await stack.db
      .selectFrom('turns')
      .select(['status', 'stage', 'error_code'])
      .where('id', '=', turn.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'failed', stage: null, error_code: 'max_attempts' });
  });

  it('changes nothing and uses up no requeue while Redis is unreachable', async () => {
    const doc = await insertDoc();
    // A row at its cap would be failed by a sweep that went on past Redis errors.
    const capped = await insertDoc({ requeues: 2 });
    const dead = createQueues('redis://127.0.0.1:1', `test-${randomUUID()}`, stack.deps.config);
    for (const q of Object.values(dead)) q.on('error', () => {});
    try {
      await expect(sweep(stack.deps, dead)).rejects.toThrow();
      expect(await docRow(doc.id)).toMatchObject({ status: 'queued', attempt: 1, requeues: 0 });
      expect(await docRow(capped.id)).toMatchObject({ status: 'queued', requeues: 2 });
    } finally {
      await Promise.race([
        Promise.allSettled(Object.values(dead).map((q) => q.close())),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    await sweep(stack.deps, stack.queues);
    await waitForDocument(doc.id, 'ready');
  });
});

describe('the start-up model check', () => {
  it('reports each model as ok, misconfigured or unavailable', async () => {
    expect(await stack.deps.model.check()).toEqual({ chat: 'ok', embedding: 'ok' });

    stack.fake.script({ status: 404, body: { error: { message: 'model not found' } } });
    stack.fake.embeddingErrors = [{ status: 400, message: 'unknown model' }];
    expect(await stack.deps.model.check()).toEqual({
      chat: 'misconfigured',
      embedding: 'misconfigured',
    });

    const unreachable = createModel({
      ...stack.deps.config,
      MODEL_BASE_URL: 'http://127.0.0.1:1/v1',
    });
    expect(await unreachable.check()).toEqual({ chat: 'unavailable', embedding: 'unavailable' });
  });

  it('shows the stored result on /ready', async () => {
    const result = { chat: 'ok', embedding: 'misconfigured', checkedAt: new Date().toISOString() };
    await stack.redis.set(modelStatusKey(stack.deps.config.QUEUE_PREFIX), JSON.stringify(result));
    const res = await stack.app.inject('/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json().model).toEqual(result);
  });
});
