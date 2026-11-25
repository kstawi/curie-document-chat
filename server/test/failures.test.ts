import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  // Short call timeouts, frequent heartbeats, a budget that fits the sample's three passages but not in half, and
  // a sweeper that only counts rows untouched for 30 minutes as stale (see the sweeper tests).
  stack = await startStack({
    MODEL_TIMEOUT_MS: 1_000,
    CHAT_RETRY_TIMEOUT_MS: 1_000,
    REWRITE_TIMEOUT_MS: 1_000,
    HEARTBEAT_MS: 100,
    PASSAGE_TOKEN_BUDGET: 500,
    SWEEP_STALE_MS: 30 * 60_000,
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

  it('treats a reply whose text is not a string like an unusable reply', async () => {
    stack.fake.chatRequests = [];
    const odd = {
      body: {
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: [{ type: 'text', text: answered() }] },
          },
        ],
      },
    };
    stack.fake.script(odd, { content: answered() });
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
    stack.fake.embeddingReplies = [{ status: 503 }];
    await upload();
    expect(stack.fake.embeddingReplies).toEqual([]);
  });

  it.each([
    ['an empty body', () => (stack.fake.embeddingReplies = [{ status: 200, raw: '' }])],
    [
      // The right number of items, one of them missing.
      'a list with a missing item',
      () => (stack.fake.embeddingTransform = (d) => d.map((x, i) => (i === 0 ? null : x))),
    ],
  ])(
    'fails preparation with model_bad_output when embeddings come back as %s',
    async (_label, setup) => {
      setup();
      try {
        const res = await stack.app.inject({
          method: 'POST',
          url: '/documents',
          ...multipart({ content: sample }),
        });
        const id = res.json().id as string;
        await waitForDocument(id, 'failed');
        expect((await stack.app.inject(`/documents/${id}`)).json().error.code).toBe(
          'model_bad_output',
        );
      } finally {
        stack.fake.embeddingTransform = undefined;
      }
    },
  );

  it('runs preparation again when an embedding call takes longer than its timeout', async () => {
    const calls = stack.fake.embeddingCalls;
    // Only the first call hangs: the wait is cleared once it has started.
    stack.fake.embeddingWait = never;
    const res = await stack.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({ content: sample }),
    });
    await vi.waitFor(() => expect(stack.fake.embeddingCalls).toBe(calls + 1));
    stack.fake.embeddingWait = undefined;
    await waitForDocument(res.json().id as string, 'ready');
    expect(stack.fake.embeddingCalls - calls).toBe(2);
  });

  it('fails preparation with internal_error when a passage is too long for the embedding model', async () => {
    stack.fake.embeddingReplies = [
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

  it('puts a preparation back without spending an attempt when the worker stops, and runs it on restart', async () => {
    const calls = stack.fake.embeddingCalls;
    stack.fake.embeddingWait = never;
    const res = await stack.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({ content: sample }),
    });
    const id = res.json().id as string;
    await vi.waitFor(() => expect(stack.fake.embeddingCalls).toBe(calls + 1));

    await stack.stopWorkers();
    stack.fake.embeddingWait = undefined;
    const job = await stack.queues.prepare.getJob(jobId(id, 1));
    expect(['delayed', 'waiting']).toContain(await job!.getState());
    expect(job!.attemptsMade).toBe(0);
    expect((await stack.app.inject(`/documents/${id}`)).json().status).toBe('processing');

    stack.restartWorkers();
    await waitForDocument(id, 'ready');
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
    // Shown as waiting in the queue again, not as still being written.
    expect((await stack.app.inject(`/messages/${turnId}`)).json().stage).toBeNull();

    stack.fake.script({ content: answered() });
    stack.restartWorkers();
    expect(await finished(turnId)).toMatchObject({ status: 'completed', outcome: 'answered' });
  });
});

describe('the job time limit', () => {
  let limited: Awaited<ReturnType<typeof startStack>>;
  beforeAll(async () => {
    limited = await startStack({ ANSWER_JOB_TIMEOUT_MS: 1_500, PREPARE_JOB_TIMEOUT_MS: 1_500 });
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

  it('fails a preparation that runs past it with model_unavailable', async () => {
    const calls = limited.fake.embeddingCalls;
    limited.fake.embeddingWait = never;
    try {
      const res = await limited.app.inject({
        method: 'POST',
        url: '/documents',
        ...multipart({ content: sample }),
      });
      await vi.waitFor(
        async () => {
          const doc = (await limited.app.inject(`/documents/${res.json().id}`)).json();
          expect(doc).toMatchObject({ status: 'failed', error: { code: 'model_unavailable' } });
        },
        { timeout: 5_000 },
      );
      expect(limited.fake.embeddingCalls - calls).toBe(1);
    } finally {
      limited.fake.embeddingWait = undefined;
    }
  });
});

describe('the sweeper', () => {
  // The sweeper's own rows are made to look an hour old; the stack only counts rows untouched for 30 minutes as stale,
  // so rows other test files left unfinished stay out of these sweeps however long the suite runs.
  const hourAgo = () => new Date(Date.now() - 3_600_000);

  // Every test runs for both kinds of row the sweeper looks after.
  const kinds = [
    {
      kind: 'document',
      queue: 'prepare' as const,
      open: 'queued',
      done: 'ready',
      async insert(values: Record<string, unknown> = {}) {
        const row = await stack.db
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
        return row.id;
      },
      row: (id: string) =>
        stack.db
          .selectFrom('documents')
          .select(['status', 'attempt', 'requeues', 'error_code'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      data: (id: string, attempt: number) => ({ documentId: id, attempt }),
      finish: (id: string) =>
        stack.db.updateTable('documents').set({ status: 'failed' }).where('id', '=', id).execute(),
    },
    {
      kind: 'question',
      queue: 'answer' as const,
      open: 'pending',
      done: 'completed',
      async insert(values: Record<string, unknown> = {}) {
        const conversation = await stack.db
          .insertInto('conversations')
          .values({ document_id: documentId })
          .returning('id')
          .executeTakeFirstOrThrow();
        const row = await stack.db
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
        return row.id;
      },
      row: (id: string) =>
        stack.db
          .selectFrom('turns')
          .select(['status', 'attempt', 'requeues', 'error_code', 'stage'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      data: (id: string, attempt: number) => ({ turnId: id, attempt }),
      finish: (id: string) =>
        stack.db.updateTable('turns').set({ status: 'failed' }).where('id', '=', id).execute(),
    },
  ];

  describe.each(kinds)('for a $kind', (k) => {
    const waitUntilDone = (id: string) =>
      vi.waitFor(async () => expect((await k.row(id)).status).toBe(k.done), { timeout: 10_000 });
    // Every other row's job looks alive, so the sweep acts only on the test's own row.
    const onlyFor = (id: string, add: (...args: never[]) => Promise<unknown>) => {
      const queue = {
        name: k.queue,
        getJob: async (jobIdToFind: string) =>
          jobIdToFind === jobId(id, 1) ? undefined : { getState: async () => 'waiting' },
        add,
      };
      return { ...stack.queues, [k.queue]: queue } as unknown as Queues;
    };

    beforeEach(() => stack.fake.script({ content: answered() }));

    it('queues it again when its job was lost, and it gets done', async () => {
      const id = await k.insert();
      await sweep(stack.deps, stack.queues);
      expect(await k.row(id)).toMatchObject({ attempt: 2, requeues: 1 });
      await waitUntilDone(id);
    });

    it('leaves it alone when touched recently, or with a recent heartbeat, even with no job', async () => {
      const fresh = await k.insert({ updated_at: new Date() });
      const beating = await k.insert({ heartbeat_at: new Date() });
      await sweep(stack.deps, stack.queues);
      for (const id of [fresh, beating]) {
        expect(await k.row(id)).toMatchObject({ status: k.open, attempt: 1, requeues: 0 });
        await k.finish(id);
      }
    });

    it('leaves it alone while its job is still waiting', async () => {
      const queue = stack.queues[k.queue] as unknown as Queue;
      const id = await k.insert();
      await queue.pause();
      try {
        await queue.add(k.queue, k.data(id, 1), { jobId: jobId(id, 1) });
        await sweep(stack.deps, stack.queues);
        expect(await k.row(id)).toMatchObject({ status: k.open, attempt: 1, requeues: 0 });
      } finally {
        await queue.resume();
      }
      await waitUntilDone(id);
    });

    it('counts no requeue when the new job cannot be added, and keeps the new attempt', async () => {
      const id = await k.insert();
      // As when Redis drops mid-sweep: the row needs a job, and adding one fails.
      const queues = onlyFor(id, async () => {
        throw new Error('connection lost');
      });
      await expect(sweep(stack.deps, queues)).rejects.toThrow('connection lost');
      expect(await k.row(id)).toMatchObject({ status: k.open, attempt: 2, requeues: 0 });
      // As if the add had landed after all: the job for the new attempt runs.
      const queue = stack.queues[k.queue] as unknown as Queue;
      await queue.add(k.queue, k.data(id, 2), { jobId: jobId(id, 2) });
      await waitUntilDone(id);
    });

    it('commits the new attempt before adding the job, so a worker that takes it at once finds it', async () => {
      const id = await k.insert();
      const queue = stack.queues[k.queue] as unknown as Queue;
      // Waits for the job to finish before returning, so the worker always runs it before the sweep goes on.
      const queues = onlyFor(id, async (...args: Parameters<Queue['add']>) => {
        const job = await queue.add(...args);
        await vi.waitFor(async () => expect(await job.getState()).toBe('completed'), {
          timeout: 1_900,
        });
        return job;
      });
      await sweep(stack.deps, queues);
      expect(await k.row(id)).toMatchObject({ status: k.done, attempt: 2 });
    });

    it('fails it with max_attempts once its requeues are used up', async () => {
      const id = await k.insert({ requeues: 2 });
      await sweep(stack.deps, stack.queues);
      expect(await k.row(id)).toMatchObject({
        status: 'failed',
        attempt: 1,
        error_code: 'max_attempts',
      });
      if (k.kind === 'question') expect(await k.row(id)).toMatchObject({ stage: null });
    });

    it('changes nothing and uses up no requeue while Redis is unreachable', async () => {
      const id = await k.insert();
      // A row at its cap would be failed by a sweep that went on past Redis errors.
      const capped = await k.insert({ requeues: 2 });
      const dead = createQueues('redis://127.0.0.1:1', `test-${randomUUID()}`, stack.deps.config);
      for (const q of Object.values(dead)) q.on('error', () => {});
      try {
        await expect(sweep(stack.deps, dead)).rejects.toThrow();
        expect(await k.row(id)).toMatchObject({ status: k.open, attempt: 1, requeues: 0 });
        expect(await k.row(capped)).toMatchObject({ status: k.open, requeues: 2 });
      } finally {
        await Promise.race([
          Promise.allSettled(Object.values(dead).map((q) => q.close())),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
      await k.finish(capped);
      await sweep(stack.deps, stack.queues);
      await waitUntilDone(id);
    });
  });
});

describe('the start-up model check', () => {
  it('reports each model as ok, misconfigured or unavailable', async () => {
    expect(await stack.deps.model.check()).toEqual({ chat: 'ok', embedding: 'ok' });

    stack.fake.script({ status: 404, body: { error: { message: 'model not found' } } });
    stack.fake.embeddingReplies = [{ status: 400, message: 'unknown model' }];
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
