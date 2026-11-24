import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { answerQuestion } from '../src/jobs/answer.js';
import { prepareDocument } from '../src/jobs/prepare.js';
import { createModel } from '../src/model.js';
import { multipart, startStack } from './helpers/stack.js';

const sample = readFileSync(
  new URL('../../samples/harbor-archive-pilot.md', import.meta.url),
  'utf8',
);

let stack: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

async function upload(
  content: string | Buffer,
  fields: Record<string, string> = {},
  filename?: string,
) {
  return stack.app.inject({
    method: 'POST',
    url: '/documents',
    ...multipart({ content, filename }, fields),
  });
}

async function readyDocument() {
  const res = await upload(sample, { title: 'Harbor Archive' });
  expect(res.statusCode).toBe(202);
  const id = res.json().id as string;
  await vi.waitFor(
    async () => expect((await stack.app.inject(`/documents/${id}`)).json().status).toBe('ready'),
    { timeout: 10_000 },
  );
  return id;
}

async function newConversation(documentId: string) {
  const res = await stack.app.inject({
    method: 'POST',
    url: `/documents/${documentId}/conversations`,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function ask(conversationId: string, question: string) {
  return stack.app.inject({
    method: 'POST',
    url: `/conversations/${conversationId}/messages`,
    payload: { question },
  });
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
    { timeout: 10_000 },
  );
  return body as {
    status: string;
    outcome: string | null;
    answer: string | null;
    note: string | null;
    quotes: { text: string; start: number; end: number; section: string }[];
    error: { code: string } | null;
  };
}

describe('upload and preparation', () => {
  it('prepares a Markdown document into chunks and serves its text back', async () => {
    const id = await readyDocument();
    const doc = (await stack.app.inject(`/documents/${id}`)).json();
    expect(doc).toMatchObject({
      title: 'Harbor Archive',
      format: 'markdown',
      status: 'ready',
      error: null,
    });
    const chunks = await stack.db
      .selectFrom('chunks')
      .select('text')
      .where('document_id', '=', id)
      .execute();
    expect(chunks).toHaveLength(3);
    const content = (await stack.app.inject(`/documents/${id}/content`)).json();
    expect(content.content).toBe(sample);
  });

  it('stores Windows line endings as LF and drops a UTF-8 byte-order mark', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# Title\r\n\r\nSome text.\r\n'),
    ]);
    const res = await upload(bytes);
    const content = (await stack.app.inject(`/documents/${res.json().id}/content`)).json();
    expect(content.content).toBe('# Title\n\nSome text.\n');
  });

  it.each([
    ['an empty file', '   \n', 400, 'empty_document'],
    ['a binary file', Buffer.from([0x41, 0x00, 0x42]), 415, 'unsupported_type'],
    ['a UTF-16 file', Buffer.from([0xff, 0xfe, 0x41, 0x00]), 400, 'invalid_encoding'],
    ['invalid UTF-8', Buffer.from([0x41, 0xc3, 0x28]), 400, 'invalid_encoding'],
    ['a PDF (not yet supported)', Buffer.from('%PDF-1.7\n'), 415, 'unsupported_type'],
    ['a file over 1 MB', 'a'.repeat(1024 * 1024 + 1), 413, 'file_too_large'],
  ])('rejects %s', async (_label, content, status, code) => {
    const before = await stack.db
      .selectFrom('documents')
      .select(({ fn }) => fn.countAll().as('n'))
      .executeTakeFirst();
    const res = await upload(content);
    expect(res.statusCode).toBe(status);
    expect(res.json().error).toBe(code);
    const after = await stack.db
      .selectFrom('documents')
      .select(({ fn }) => fn.countAll().as('n'))
      .executeTakeFirst();
    expect(after?.n).toBe(before?.n);
  });

  it('refuses an upload that is not readable multipart form data', async () => {
    const post = (headers: Record<string, string>, payload: string | Buffer) =>
      stack.app.inject({ method: 'POST', url: '/documents', headers, payload });
    const json = await post({ 'content-type': 'application/json' }, '{"text":"hi"}');
    expect([json.statusCode, json.json().error]).toEqual([415, 'unsupported_type']);
    const noBoundary = await post({ 'content-type': 'multipart/form-data' }, 'x');
    expect([noBoundary.statusCode, noBoundary.json().error]).toEqual([400, 'invalid_request']);
    const { payload, headers } = multipart({ content: '# Title\n\nText.\n' });
    const cut = await post(headers, payload.subarray(0, payload.length - 20));
    expect([cut.statusCode, cut.json().error]).toEqual([400, 'invalid_request']);
  });

  it('marks the document failed with a reason when the embedding model is down', async () => {
    stack.fake.embeddingStatus = 503;
    try {
      const res = await upload('# Doc\n\nSome text to embed.\n');
      const id = res.json().id as string;
      await vi.waitFor(
        async () => {
          const doc = (await stack.app.inject(`/documents/${id}`)).json();
          expect(doc.status).toBe('failed');
          expect(doc.error.code).toBe('model_unavailable');
        },
        { timeout: 10_000 },
      );
    } finally {
      stack.fake.embeddingStatus = 200;
    }
  });

  it('fails a document with headings and no text as empty', async () => {
    const id = (await upload('# Title\n\n## Section\n')).json().id as string;
    await vi.waitFor(
      async () =>
        expect((await stack.app.inject(`/documents/${id}`)).json().error?.code).toBe(
          'empty_document',
        ),
      { timeout: 10_000 },
    );
  });

  it('refuses questions about a document whose preparation failed', async () => {
    const doc = await stack.db
      .insertInto('documents')
      .values({
        title: 'broken',
        format: 'text',
        content: 'text',
        status: 'failed',
        error_code: 'model_unavailable',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const conversation = (
      await stack.app.inject({ method: 'POST', url: `/documents/${doc.id}/conversations` })
    ).json().id;
    const res = await stack.app.inject({
      method: 'POST',
      url: `/conversations/${conversation}/messages`,
      payload: { question: 'Anything?' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('document_failed');
  });
});

describe('job handlers', () => {
  const insertDoc = (values: Record<string, unknown>) =>
    stack.db
      .insertInto('documents')
      .values({ title: 'job', format: 'markdown', content: sample, ...values })
      .returning('id')
      .executeTakeFirstOrThrow();
  const chunkCount = async (id: string) =>
    (await stack.db.selectFrom('chunks').select('id').where('document_id', '=', id).execute())
      .length;

  it('ignores a preparation job for a document that is gone, already ready, or on a newer attempt', async () => {
    await expect(
      prepareDocument(stack.deps, { documentId: randomUUID(), attempt: 1 }),
    ).resolves.toBeUndefined();
    const calls = stack.fake.embeddingCalls;
    for (const [values, expected] of [
      [
        { status: 'ready', embedding_model: 'fake-embed' },
        { status: 'ready', attempt: 1 },
      ],
      [{ attempt: 2 }, { status: 'queued', attempt: 2 }],
    ] as const) {
      const doc = await insertDoc(values);
      await prepareDocument(stack.deps, { documentId: doc.id, attempt: 1 });
      const after = await stack.db
        .selectFrom('documents')
        .select(['status', 'attempt'])
        .where('id', '=', doc.id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual(expected);
      expect(await chunkCount(doc.id)).toBe(0);
    }
    expect(stack.fake.embeddingCalls).toBe(calls);
  });

  // Sections of about 450 characters each, so every section becomes its own chunk.
  const sections = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `## Part ${i}\n\n${'Words about this part of the report. '.repeat(12)}`,
    ).join('\n\n');

  it('prepares a document with 1,200 chunks', async () => {
    const doc = await insertDoc({ content: sections(1_200) });
    await prepareDocument(stack.deps, { documentId: doc.id, attempt: 1 });
    const after = await stack.db
      .selectFrom('documents')
      .select('status')
      .where('id', '=', doc.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('ready');
    expect(await chunkCount(doc.id)).toBe(1_200);
  });

  it('refuses a document that would make more than 5,000 chunks, before embedding anything', async () => {
    const doc = await insertDoc({ content: sections(5_001) });
    const before = stack.fake.embeddingCalls;
    await prepareDocument(stack.deps, { documentId: doc.id, attempt: 1 });
    const after = await stack.db
      .selectFrom('documents')
      .select(['status', 'error_code'])
      .where('id', '=', doc.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ status: 'failed', error_code: 'too_many_passages' });
    expect(stack.fake.embeddingCalls).toBe(before);
  });

  it('rejects vectors of the wrong shape from the embedding model', async () => {
    type Items = { index: number; embedding: unknown }[];
    for (const transform of [
      (d: Items) => d.slice(1), // one missing
      (d: Items) => d.map((x) => ({ ...x, index: 0 })), // the same position twice
      (d: Items) => d.map((x, i) => (i === 0 ? { ...x, embedding: [0.5] } : x)), // sizes differ
      (d: Items) => d.map((x) => ({ ...x, embedding: ['not', 'numbers'] })),
      () => undefined as unknown as Items, // no list at all
    ]) {
      stack.fake.embeddingTransform = transform;
      try {
        const doc = await insertDoc({});
        await prepareDocument(stack.deps, { documentId: doc.id, attempt: 1 });
        const after = await stack.db
          .selectFrom('documents')
          .select(['status', 'error_code'])
          .where('id', '=', doc.id)
          .executeTakeFirstOrThrow();
        expect(after).toEqual({ status: 'failed', error_code: 'model_bad_output' });
      } finally {
        stack.fake.embeddingTransform = undefined;
      }
    }
  });

  it('rejects vectors that do not have the configured size, and names the model with that size', async () => {
    const config = { ...stack.deps.config, EMBEDDING_DIMENSIONS: 32 };
    const model = createModel(config);
    expect(model.embeddingModel).toBe('fake-embed@32');
    // The fake server ignores the requested size and returns 64 numbers.
    await expect(model.embed(['text'], 'query')).rejects.toMatchObject({
      code: 'model_bad_output',
    });
    expect(
      await createModel({ ...config, EMBEDDING_DIMENSIONS: 64 }).embed(['text'], 'query'),
    ).toHaveLength(1);
  });

  it('does not mark a document ready if it moved on while it was embedding', async () => {
    // A newer attempt that has already claimed the row, or the same attempt marked failed (as a sweeper would).
    for (const change of [
      { attempt: 2, status: 'processing' as const },
      { attempt: 1, status: 'failed' as const },
    ]) {
      let release = () => {};
      stack.fake.embeddingWait = new Promise<void>((resolve) => (release = resolve));
      try {
        const doc = await insertDoc({});
        const job = prepareDocument(stack.deps, { documentId: doc.id, attempt: 1 });
        await vi.waitFor(async () => {
          const row = await stack.db
            .selectFrom('documents')
            .select('status')
            .where('id', '=', doc.id)
            .executeTakeFirstOrThrow();
          expect(row.status).toBe('processing');
        });
        await stack.db.updateTable('documents').set(change).where('id', '=', doc.id).execute();
        release();
        await job;
        const after = await stack.db
          .selectFrom('documents')
          .select(['status', 'attempt'])
          .where('id', '=', doc.id)
          .executeTakeFirstOrThrow();
        expect(after).toEqual(change);
        expect(await chunkCount(doc.id)).toBe(0);
      } finally {
        stack.fake.embeddingWait = undefined;
      }
    }
  });

  it('redoes preparation cleanly when run again after a crash', async () => {
    const doc = await insertDoc({ status: 'processing' });
    await stack.db
      .insertInto('chunks')
      .values({ document_id: doc.id, ordinal: 0, start_offset: 0, end_offset: 5, text: 'stale' })
      .execute();
    await prepareDocument(stack.deps, { documentId: doc.id, attempt: 1 });
    const chunks = await stack.db
      .selectFrom('chunks')
      .select('text')
      .where('document_id', '=', doc.id)
      .execute();
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.text)).not.toContain('stale');
  });

  it('ignores an answer job for a turn that is final or on a newer attempt', async () => {
    const doc = await insertDoc({ status: 'ready', embedding_model: 'fake-embed' });
    const conversation = await stack.db
      .insertInto('conversations')
      .values({ document_id: doc.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    const turn = await stack.db
      .insertInto('turns')
      .values({
        conversation_id: conversation.id,
        sequence: 1,
        question: 'Q?',
        status: 'completed',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    stack.fake.chatRequests = [];
    await answerQuestion(stack.deps, { turnId: turn.id, attempt: 1 });
    const newer = await stack.db
      .insertInto('turns')
      .values({ conversation_id: conversation.id, sequence: 2, question: 'Q?', attempt: 2 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await answerQuestion(stack.deps, { turnId: newer.id, attempt: 1 });
    expect(stack.fake.chatRequests).toHaveLength(0);
    const after = await stack.db
      .selectFrom('turns')
      .select(['status'])
      .where('id', '=', newer.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('pending');
  });

  it('does not record an answer if the turn moved on while the model was answering', async () => {
    const doc = await insertDoc({ status: 'ready', embedding_model: 'fake-embed' });
    await stack.db
      .updateTable('documents')
      .set({ status: 'processing' })
      .where('id', '=', doc.id)
      .execute();
    await prepareDocument(stack.deps, { documentId: doc.id, attempt: 1 });
    // A newer attempt, or the same attempt marked failed (as a sweeper would).
    for (const change of [
      { attempt: 2, status: 'pending' as const },
      { attempt: 1, status: 'failed' as const },
    ]) {
      const conversation = await stack.db
        .insertInto('conversations')
        .values({ document_id: doc.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      const turn = await stack.db
        .insertInto('turns')
        .values({ conversation_id: conversation.id, sequence: 1, question: 'Who owned the pilot?' })
        .returning('id')
        .executeTakeFirstOrThrow();
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      stack.fake.onChat = () => ({
        wait: held,
        content: JSON.stringify({
          outcome: 'answered',
          answer: 'Mira Chen.',
          quotes: ['Mira Chen owned the limited pilot.'],
        }),
      });
      stack.fake.chatRequests = [];
      const job = answerQuestion(stack.deps, { turnId: turn.id, attempt: 1 });
      await vi.waitFor(() => expect(stack.fake.chatRequests).toHaveLength(1));
      await stack.db.updateTable('turns').set(change).where('id', '=', turn.id).execute();
      release();
      await job;
      const after = await stack.db
        .selectFrom('turns')
        .select(['status', 'outcome', 'attempt'])
        .where('id', '=', turn.id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual({ ...change, outcome: null });
    }
  });

  it('fails an answer whose document changed after the question was accepted', async () => {
    for (const [values, code] of [
      [{ status: 'processing' }, 'document_not_ready'],
      [{ status: 'ready', embedding_model: 'another-model' }, 'embedding_model_changed'],
    ] as const) {
      const doc = await insertDoc(values);
      const conversation = await stack.db
        .insertInto('conversations')
        .values({ document_id: doc.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      const turn = await stack.db
        .insertInto('turns')
        .values({ conversation_id: conversation.id, sequence: 1, question: 'Q?' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await answerQuestion(stack.deps, { turnId: turn.id, attempt: 1 });
      const after = await stack.db
        .selectFrom('turns')
        .select(['status', 'error_code'])
        .where('id', '=', turn.id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual({ status: 'failed', error_code: code });
    }
  });
});

describe('questions and answers', () => {
  let documentId: string;
  beforeAll(async () => {
    documentId = await readyDocument();
  });

  it('answers with a quote that is located in the document', async () => {
    stack.fake.reply({
      outcome: 'answered',
      answer: 'Mira Chen owned the limited pilot.',
      quotes: ['Mira Chen owned the limited pilot.'],
    });
    const conversation = await newConversation(documentId);
    const res = await ask(conversation, 'Who owned the pilot?');
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('pending');

    const turn = await finished(res.json().id);
    expect(turn).toMatchObject({ status: 'completed', outcome: 'answered', error: null });
    expect(turn.quotes).toHaveLength(1);
    const [q] = turn.quotes;
    expect(sample.slice(q!.start, q!.end)).toBe('Mira Chen owned the limited pilot.');
    expect(q!.section).toBe('Harbor Archive retrieval pilot > Decision');
  });

  it('sends the question, the passages and earlier turns to the model as data blocks', async () => {
    const conversation = await newConversation(documentId);
    stack.fake.reply({
      outcome: 'answered',
      answer: 'Keyword search took 0.7 seconds.',
      quotes: ['Median response time was 0.7 seconds for keyword search'],
    });
    await finished((await ask(conversation, 'How fast was keyword search?')).json().id);
    stack.fake.chatRequests = [];
    await finished((await ask(conversation, 'And the hybrid one?')).json().id);

    const user = stack.fake.chatRequests[0]!.messages.find((m) => m.role === 'user')!.content;
    const tag = /<(data-[0-9a-f]{12}) kind="passages">/.exec(user)?.[1];
    expect(tag).toBeDefined();
    expect(user).toContain(`<${tag} kind="earlier-turns">\nQ: How fast was keyword search?`);
    expect(user).toContain(`<${tag} kind="question">\nAnd the hybrid one?\n</${tag}>`);
    expect(user).toContain('Mira Chen owned the limited pilot.');
  });

  it('hides an answer whose quotes are not in the document', async () => {
    stack.fake.reply({
      outcome: 'answered',
      answer: 'The pilot cost five million dollars.',
      quotes: ['The pilot cost five million dollars in total.'],
    });
    const turn = await finished(
      (await ask(await newConversation(documentId), 'What did it cost?')).json().id,
    );
    expect(turn).toMatchObject({ outcome: 'unsupported', answer: null, quotes: [] });
  });

  it('keeps the model note when the document does not cover the question', async () => {
    stack.fake.reply({
      outcome: 'not_in_document',
      answer: 'The document does not mention the cost of the pilot.',
      quotes: [],
    });
    const turn = await finished(
      (await ask(await newConversation(documentId), 'What did it cost?')).json().id,
    );
    expect(turn).toMatchObject({
      outcome: 'not_in_document',
      answer: null,
      note: 'The document does not mention the cost of the pilot.',
      quotes: [],
    });
  });

  it('accepts a not-in-document reply with an empty note', async () => {
    stack.fake.reply({ outcome: 'not_in_document', answer: ' ', quotes: [] });
    const turn = await finished(
      (await ask(await newConversation(documentId), 'What did it cost?')).json().id,
    );
    expect(turn).toMatchObject({ status: 'completed', outcome: 'not_in_document', note: '' });
  });

  it('cuts a long note to 300 characters without splitting an emoji', async () => {
    stack.fake.reply({
      outcome: 'not_in_document',
      answer: `${'x'.repeat(299)}😀${'y'.repeat(100)}`,
      quotes: [],
    });
    const turn = await finished(
      (await ask(await newConversation(documentId), 'What did it cost?')).json().id,
    );
    expect(turn.note).toBe(`${'x'.repeat(299)}😀`);
  });

  it('stores model text that holds a NUL character or half an emoji', async () => {
    stack.fake.reply({
      outcome: 'answered',
      answer: 'Mira\u0000 Chen \ud83d',
      quotes: ['Mira Chen owned the limited pilot.', 'half an emoji \ud83d at the end of this'],
    });
    const turn = await finished(
      (await ask(await newConversation(documentId), 'Who owned the pilot?')).json().id,
    );
    expect(turn).toMatchObject({
      status: 'completed',
      outcome: 'answered',
      answer: 'Mira Chen \uFFFD',
    });
  });

  it.each([
    ['hits its token cap', { finish: 'length', content: '{"outcome":' }, 'model_bad_output'],
    ['returns non-JSON holding a NUL character', { content: 'Sure.\u0000' }, 'model_bad_output'],
    ['answers 200 without any choices', { body: {} }, 'model_bad_output'],
    [
      'answers with an empty answer',
      { content: '{"outcome":"answered","answer":" ","quotes":[]}' },
      'model_bad_output',
    ],
    [
      'returns something other than JSON',
      { content: 'Sure! Here is the answer.' },
      'model_bad_output',
    ],
    ['returns the wrong JSON shape', { content: '{"answer":"x"}' }, 'model_bad_output'],
    ['answers 500', { status: 500 }, 'model_unavailable'],
    ['answers 429', { status: 429 }, 'model_unavailable'],
    ['answers 400', { status: 400 }, 'model_rejected'],
  ])(
    'fails the answer, and frees the conversation, when the model %s',
    async (_label, reply, code) => {
      stack.fake.onChat = () => reply;
      const conversation = await newConversation(documentId);
      const turn = await finished((await ask(conversation, 'Who owned the pilot?')).json().id);
      expect(turn).toMatchObject({ status: 'failed', error: { code } });

      stack.fake.reply({ outcome: 'not_in_document', answer: 'Not covered.', quotes: [] });
      const next = await ask(conversation, 'Another question?');
      expect(next.statusCode).toBe(202);
      await finished(next.json().id);
    },
  );

  it('refuses a second question while the first is still being answered', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    stack.fake.onChat = () => ({
      wait: held,
      content: JSON.stringify({ outcome: 'not_in_document', answer: 'No.', quotes: [] }),
    });
    const conversation = await newConversation(documentId);
    const first = await ask(conversation, 'First question?');
    expect(first.statusCode).toBe(202);
    const second = await ask(conversation, 'Second question?');
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('answer_pending');
    release();
    await finished(first.json().id);
  });

  it('refuses questions before the document is ready', async () => {
    const doc = await stack.db
      .insertInto('documents')
      .values({ title: 'queued', format: 'text', content: 'text' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const res = await ask(await newConversation(doc.id), 'Too early?');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('document_not_ready');
  });

  it('refuses questions about a document embedded by another model', async () => {
    const doc = await stack.db
      .insertInto('documents')
      .values({
        title: 'old',
        format: 'text',
        content: 'text',
        status: 'ready',
        embedding_model: 'other-model',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const res = await ask(await newConversation(doc.id), 'Still comparable?');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('embedding_model_changed');
  });

  it('validates input', async () => {
    const conversation = await newConversation(documentId);
    expect((await ask(conversation, '')).statusCode).toBe(400);
    expect((await ask(conversation, 'x'.repeat(2_001))).statusCode).toBe(400);
    expect((await ask(conversation, 'a\u0000b')).statusCode).toBe(400);
    const routes: [method: 'GET' | 'POST', path: (id: string) => string][] = [
      ['GET', (id) => `/documents/${id}`],
      ['GET', (id) => `/documents/${id}/content`],
      ['GET', (id) => `/documents/${id}/conversations`],
      ['POST', (id) => `/documents/${id}/conversations`],
      ['GET', (id) => `/conversations/${id}/messages`],
      ['POST', (id) => `/conversations/${id}/messages`],
      ['GET', (id) => `/messages/${id}`],
    ];
    for (const [method, path] of routes) {
      const payload = method === 'POST' ? { question: 'Q?' } : undefined;
      const unknown = await stack.app.inject({ method, url: path(randomUUID()), payload });
      expect([path('id'), unknown.statusCode, unknown.json().error]).toEqual([
        path('id'),
        404,
        'not_found',
      ]);
      const malformed = await stack.app.inject({ method, url: path('not-a-uuid'), payload });
      expect([path('id'), malformed.statusCode]).toEqual([path('id'), 400]);
    }
  });

  it('lists a conversation in order', async () => {
    stack.fake.reply({ outcome: 'not_in_document', answer: 'No.', quotes: [] });
    const conversation = await newConversation(documentId);
    await finished((await ask(conversation, 'One?')).json().id);
    await finished((await ask(conversation, 'Two?')).json().id);
    const list = (await stack.app.inject(`/conversations/${conversation}/messages`)).json();
    expect(list.items.map((t: { question: string }) => t.question)).toEqual(['One?', 'Two?']);
  });

  it('ignores a job whose row is gone', async () => {
    await expect(
      answerQuestion(stack.deps, { turnId: randomUUID(), attempt: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe('with Redis unreachable for the queue', () => {
  let down: Awaited<ReturnType<typeof startStack>>;
  beforeAll(async () => {
    // The API's queues point at a closed port: Postgres works, the queue's Redis doesn't.
    down = await startStack({}, 'redis://127.0.0.1:1');
  });
  afterAll(() => down?.stop());

  it('answers 503 to an upload and keeps no half-created document', async () => {
    const before = await down.db.selectFrom('documents').select('id').execute();
    const res = await down.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({ content: '# A\n\nText.\n' }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('queue_unavailable');
    expect(await down.db.selectFrom('documents').select('id').execute()).toHaveLength(
      before.length,
    );
  });

  it('answers 503 to a question and leaves the conversation free', async () => {
    const doc = await down.db
      .insertInto('documents')
      .values({
        title: 'r',
        format: 'text',
        content: 'text',
        status: 'ready',
        embedding_model: 'fake-embed',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const conversation = (
      await down.app.inject({ method: 'POST', url: `/documents/${doc.id}/conversations` })
    ).json().id;
    const ask503 = () =>
      down.app.inject({
        method: 'POST',
        url: `/conversations/${conversation}/messages`,
        payload: { question: 'Q?' },
      });
    expect((await ask503()).statusCode).toBe(503);
    // Had the pending row stayed, this would be a 409.
    expect((await ask503()).json().error).toBe('queue_unavailable');
  });
});

describe('trouble while an answer is in progress', () => {
  let s: Awaited<ReturnType<typeof startStack>>;
  let documentId: string;
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.searchParams.set('application_name', 'flow-trouble');

  beforeAll(async () => {
    s = await startStack({ MODEL_TIMEOUT_MS: 1_000, DATABASE_URL: url.href });
    const res = await s.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({ content: sample }),
    });
    documentId = res.json().id;
    await vi.waitFor(
      async () =>
        expect((await s.app.inject(`/documents/${documentId}`)).json().status).toBe('ready'),
      { timeout: 10_000 },
    );
  });
  afterAll(() => s?.stop());

  const askIn = async (question: string) => {
    const c = (
      await s.app.inject({ method: 'POST', url: `/documents/${documentId}/conversations` })
    ).json().id;
    return (
      await s.app.inject({
        method: 'POST',
        url: `/conversations/${c}/messages`,
        payload: { question },
      })
    ).json().id as string;
  };
  const settle = async (id: string) => {
    let body: { status: string; outcome: string | null; error: { code: string } | null } = {
      status: 'pending',
      outcome: null,
      error: null,
    };
    await vi.waitFor(
      async () => {
        const res = await s.app.inject(`/messages/${id}`);
        expect(res.statusCode).toBe(200);
        body = res.json();
        expect(body.status).not.toBe('pending');
      },
      { timeout: 10_000 },
    );
    return body;
  };

  it('fails the answer as model_unavailable when the model never replies', async () => {
    s.fake.onChat = () => ({ wait: new Promise(() => {}) });
    const turn = await settle(await askIn('Who owned the pilot?'));
    expect(turn).toMatchObject({ status: 'failed', error: { code: 'model_unavailable' } });
  });

  it('still records the answer when Postgres drops the connections mid-answer', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    s.fake.onChat = () => ({
      wait: held,
      content: JSON.stringify({
        outcome: 'answered',
        answer: 'Mira Chen.',
        quotes: ['Mira Chen owned the limited pilot.'],
      }),
    });
    s.fake.chatRequests = [];
    const id = await askIn('Who owned the pilot?');
    // Wait until the job is really holding at the model call before dropping its connections.
    await vi.waitFor(async () => {
      expect(s.fake.chatRequests).toHaveLength(1);
      expect((await s.app.inject(`/messages/${id}`)).json().stage).toBe('writing');
    });
    const pg = await import('pg');
    const admin = new pg.default.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const { rowCount } = await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'flow-trouble'`,
    );
    await admin.end();
    expect(rowCount).toBeGreaterThan(0);
    // Let the pool notice the dropped connections, as the db tests do, before the job writes its result.
    for (let i = 0; i < 3; i++) await vi.waitFor(() => sql`select 1`.execute(s.db));
    release();
    expect(await settle(id)).toMatchObject({ status: 'completed', outcome: 'answered' });
  });
});
