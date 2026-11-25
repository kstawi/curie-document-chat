import { readFileSync } from 'node:fs';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nameFromQuestion } from '../src/text/decode.js';
import { multipart, startStack } from './helpers/stack.js';

const sample = readFileSync(
  new URL('../../samples/harbor-archive-pilot.md', import.meta.url),
  'utf8',
);
const answer = {
  outcome: 'answered',
  answer: 'Mira Chen did.',
  quotes: ['Mira Chen owned the limited pilot.'],
};

let stack: Awaited<ReturnType<typeof startStack>>;
let documentId: string;

beforeAll(async () => {
  stack = await startStack();
  stack.fake.reply(answer);
  const res = await stack.app.inject({
    method: 'POST',
    url: '/documents',
    ...multipart({ content: sample }, { title: 'Harbor Archive' }),
  });
  documentId = res.json().id as string;
  await vi.waitFor(
    async () =>
      expect((await stack.app.inject(`/documents/${documentId}`)).json().status).toBe('ready'),
    { timeout: 10_000 },
  );
});
afterAll(() => stack.stop());

const newConversation = async () => {
  const res = await stack.app.inject({
    method: 'POST',
    url: `/documents/${documentId}/conversations`,
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().title).toBeNull();
  return res.json().id as string;
};
const ask = async (conversationId: string, question: string) => {
  const res = await stack.app.inject({
    method: 'POST',
    url: `/conversations/${conversationId}/messages`,
    payload: { question },
  });
  expect(res.statusCode).toBe(202);
  return res.json().id as string;
};
const finished = (turnId: string) =>
  vi.waitFor(
    async () => {
      const body = (await stack.app.inject(`/messages/${turnId}`)).json();
      expect(body.status).not.toBe('pending');
      return body as { status: string; outcome: string | null };
    },
    { timeout: 10_000 },
  );
const title = async (conversationId: string) => {
  const list = (await stack.app.inject(`/documents/${documentId}/conversations`)).json();
  return (list.items as { id: string; title: string | null }[]).find(
    (c) => c.id === conversationId,
  )!.title;
};
const rename = (conversationId: string, name: string, headers: Record<string, string> = {}) =>
  stack.app.inject({
    method: 'PATCH',
    url: `/conversations/${conversationId}`,
    payload: { title: name },
    headers,
  });
// A name reply held back until the test lets it go.
const heldName = (name: string) => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  stack.fake.nameReplies.push({ wait, content: JSON.stringify({ name }) });
  return release;
};

describe('conversation names', () => {
  it('names a conversation by its first question at once, then by the model from that question alone', async () => {
    const id = await newConversation();
    const question =
      'Who owned the limited pilot, and was anyone else involved in running it day to day?';
    const release = heldName('Pilot ownership');
    const before = stack.fake.nameRequests.length;
    const turn = await ask(id, question);
    expect(await title(id)).toBe(nameFromQuestion(question));
    expect(nameFromQuestion(question)).toHaveLength(60);
    expect(nameFromQuestion(question).endsWith('…')).toBe(true);

    release();
    expect((await finished(turn)).outcome).toBe('answered');
    expect(await title(id)).toBe('Pilot ownership');
    // One call, with the question and nothing of the document.
    expect(stack.fake.nameRequests.length - before).toBe(1);
    const sent = JSON.stringify(stack.fake.nameRequests.at(-1)!.messages);
    expect(sent).toContain('anyone else involved');
    expect(sent).not.toContain('Mira Chen');

    // A follow-up neither renames it nor asks the model again.
    await finished(await ask(id, 'And when did it start?'));
    expect(await title(id)).toBe('Pilot ownership');
    expect(stack.fake.nameRequests.length - before).toBe(1);
  });

  it('keeps the question as the name when the name call fails, and still answers', async () => {
    for (const failure of [
      { status: 500 },
      { content: 'not json' },
      { content: '{"name":"  "}' },
    ]) {
      const id = await newConversation();
      stack.fake.nameReplies.push(failure);
      const turn = await ask(id, 'Who owned the pilot?');
      expect((await finished(turn)).outcome).toBe('answered');
      expect(await title(id)).toBe('Who owned the pilot?');
    }
  });

  it('keeps a name a user gives while the model is naming', async () => {
    const id = await newConversation();
    const release = heldName('Pilot ownership');
    const before = stack.fake.nameRequests.length;
    const turn = await ask(id, 'Who owned the pilot?');
    // Renamed while the model's name is on its way.
    await vi.waitFor(() => expect(stack.fake.nameRequests.length).toBe(before + 1));
    expect((await rename(id, 'My own name')).statusCode).toBe(200);
    release();
    await finished(turn);
    expect(await title(id)).toBe('My own name');
  });

  it('names a conversation once, even when its first question is answered again', async () => {
    const id = await newConversation();
    // The answer call is refused, so the question fails; the name is in by then.
    stack.fake.script({ status: 400 }, { content: JSON.stringify(answer) });
    const turn = await ask(id, 'Who owned the pilot?');
    expect((await finished(turn)).status).toBe('failed');
    expect(await title(id)).toBe('Named by the model');

    const before = stack.fake.nameRequests.length;
    stack.fake.nameReplies.push({ content: JSON.stringify({ name: 'A second name' }) });
    const retry = await stack.app.inject({ method: 'POST', url: `/messages/${turn}/retry` });
    expect(retry.statusCode).toBe(202);
    expect((await finished(turn)).outcome).toBe('answered');
    expect(await title(id)).toBe('Named by the model');
    expect(stack.fake.nameRequests.length).toBe(before);
    stack.fake.nameReplies.length = 0;
    stack.fake.reply(answer);
  });

  it('removes the name with the question when the question cannot be queued', async () => {
    const id = await newConversation();
    vi.spyOn(stack.queues.answer as Queue, 'add').mockRejectedValueOnce(
      new Error('connection lost'),
    );
    const res = await stack.app.inject({
      method: 'POST',
      url: `/conversations/${id}/messages`,
      payload: { question: 'Who owned the pilot?' },
    });
    expect([res.statusCode, res.json().error]).toEqual([503, 'queue_unavailable']);
    expect(await title(id)).toBeNull();
  });
});

describe('renaming', () => {
  it('cleans a name and keeps it to 80 characters', async () => {
    const id = await newConversation();
    const zeroWidth = String.fromCharCode(0x200b);
    const res = await rename(id, `  Pilot${zeroWidth} notes\n  `);
    expect([res.statusCode, res.json().title]).toEqual([200, 'Pilot notes']);
    expect(await title(id)).toBe('Pilot notes');
    expect((await rename(id, 'x'.repeat(80))).statusCode).toBe(200);

    for (const bad of ['', '   ', zeroWidth, 'x'.repeat(81)]) {
      const r = await rename(id, bad);
      expect([r.statusCode, r.json().error]).toEqual([400, 'invalid_title']);
    }
    expect(await title(id)).toBe('x'.repeat(80));
  });

  it('answers 404 for an unknown conversation, and refuses a page on another origin', async () => {
    const missing = await rename('00000000-0000-4000-8000-000000000000', 'A name');
    expect([missing.statusCode, missing.json().error]).toEqual([404, 'not_found']);

    const id = await newConversation();
    const foreign = await rename(id, 'A name', { origin: 'http://elsewhere.example' });
    expect([foreign.statusCode, foreign.json().error]).toEqual([403, 'origin_not_allowed']);
    expect(await title(id)).toBeNull();
  });
});
