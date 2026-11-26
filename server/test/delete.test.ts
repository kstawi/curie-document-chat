import { readFileSync } from 'node:fs';
import type { Queue } from 'bullmq';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jobId } from '../src/queue.js';
import { plainPdf } from './helpers/pdf-fixtures.js';
import { multipart, startStack } from './helpers/stack.js';

const sample = readFileSync(
  new URL('../../samples/harbor-archive-pilot.md', import.meta.url),
  'utf8',
);
const ANSWER = JSON.stringify({
  outcome: 'answered',
  answer: 'Mira Chen.',
  quotes: ['Mira Chen owned the limited pilot.'],
});
const NOTHING_LEFT = { documents: 0, chunks: 0, files: 0, conversations: 0, turns: 0 };

let s: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => {
  s = await startStack({ ALLOWED_ORIGINS: ['http://localhost:8080'] });
}, 30_000);
afterAll(async () => s?.stop());

const hold = () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
};
const keyed = (key?: string) => (key ? { 'idempotency-key': key } : {});

async function upload(content: string | Buffer, key?: string, filename = 'doc.md') {
  const form = multipart({ content, filename });
  const res = await s.app.inject({
    method: 'POST',
    url: '/documents',
    payload: form.payload,
    headers: { ...form.headers, ...keyed(key) },
  });
  expect(res.statusCode).toBe(202);
  return res.json().id as string;
}
const status = async (id: string) => (await s.app.inject(`/documents/${id}`)).json().status;
const ready = (id: string) =>
  vi.waitFor(async () => expect(await status(id)).toBe('ready'), { timeout: 10_000 });

async function ask(documentId: string, question: string, key?: string) {
  const c = await s.app.inject({
    method: 'POST',
    url: `/documents/${documentId}/conversations`,
    headers: keyed(key && `${key}-conversation`),
  });
  const res = await s.app.inject({
    method: 'POST',
    url: `/conversations/${c.json().id}/messages`,
    payload: { question },
    headers: keyed(key && `${key}-message`),
  });
  expect(res.statusCode).toBe(202);
  return { id: res.json().id as string, conversationId: c.json().id as string };
}
const message = async (id: string) => (await s.app.inject(`/messages/${id}`)).json();
const remove = (id: string, headers: Record<string, string> = {}) =>
  s.app.inject({ method: 'DELETE', url: `/documents/${id}`, headers });

// Rows anywhere that still belong to the document, its conversations or their messages.
const leftovers = async (id: string, conversationIds: string[]) =>
  (
    await sql<typeof NOTHING_LEFT>`
      select
        (select count(*)::int from documents where id = ${id}) as documents,
        (select count(*)::int from chunks where document_id = ${id}) as chunks,
        (select count(*)::int from document_files where document_id = ${id}) as files,
        (select count(*)::int from conversations where document_id = ${id}) as conversations,
        (select count(*)::int from turns where conversation_id = any(${conversationIds}::uuid[])) as turns
    `.execute(s.db)
  ).rows[0];
const keptReplies = async (...ids: string[]) =>
  (
    await sql<{ n: number }>`
      select count(*)::int as n from idempotency_keys
      where response like any(${ids.map((i) => `%${i}%`)}::text[])
    `.execute(s.db)
  ).rows[0]!.n;

// Waits for a job to finish, and gives what tells whether it ever failed (a retry leaves its error behind).
const finished = (queue: Queue, id: string) =>
  vi.waitFor(
    async () => {
      const job = await queue.getJob(id);
      expect(await job?.getState()).toBe('completed');
      return { failedReason: job!.failedReason ?? null, errors: job!.stacktrace };
    },
    { timeout: 10_000 },
  );

describe('deleting a document', () => {
  it('removes its passages, stored PDF, conversations, messages and kept replies, and nothing else', async () => {
    const other = await upload(sample, 'delete-other');
    const pdf = Buffer.from(await plainPdf(['Mira Chen owned the limited pilot. '.repeat(4)]));
    const id = await upload(pdf, 'delete-upload', 'note.pdf');
    await ready(other);
    await ready(id);
    s.fake.script({ content: ANSWER });
    const asked = await ask(id, 'Who owned the pilot?', 'delete-ask');
    await vi.waitFor(async () => expect((await message(asked.id)).outcome).toBe('answered'), {
      timeout: 10_000,
    });
    expect(await leftovers(id, [asked.conversationId])).toEqual({
      documents: 1,
      chunks: 1,
      files: 1,
      conversations: 1,
      turns: 1,
    });
    // The upload's, the conversation's and the question's.
    expect(await keptReplies(id, asked.conversationId)).toBe(3);

    // Written in capitals, as a path id may be; the kept responses hold it in lowercase.
    const res = await remove(id.toUpperCase());
    expect([res.statusCode, res.body]).toEqual([204, '']);
    expect(await leftovers(id, [asked.conversationId])).toEqual(NOTHING_LEFT);
    expect(await keptReplies(id, asked.conversationId)).toBe(0);
    expect((await message(asked.id)).error).toBe('not_found');

    expect(await keptReplies(other)).toBe(1);
    expect(await status(other)).toBe('ready');
    const again = await remove(id);
    expect([again.statusCode, again.json().error]).toEqual([404, 'not_found']);
  });

  it('lets a document go while it is being prepared; the job ends without an error or a retry', async () => {
    const embedding = hold();
    s.fake.embeddingWait = embedding.wait;
    const id = await upload(sample);
    await vi.waitFor(async () => expect(await status(id)).toBe('processing'));

    expect((await remove(id)).statusCode).toBe(204);
    s.fake.embeddingWait = undefined;
    embedding.release();
    expect(await finished(s.queues.prepare, jobId(id, 1))).toEqual({
      failedReason: null,
      errors: [],
    });
    expect(await leftovers(id, [])).toEqual(NOTHING_LEFT);
    // One job runs at a time, so the next one shows the queue moved on.
    await ready(await upload(sample));
  });

  it('lets a document go while an answer is being written; the job ends without an error or a retry', async () => {
    const id = await upload(sample);
    await ready(id);
    const chat = hold();
    s.fake.script({ wait: chat.wait, content: ANSWER });
    const asked = await ask(id, 'Who owned the pilot?');
    await vi.waitFor(async () => expect((await message(asked.id)).stage).toBe('writing'));

    expect((await remove(id)).statusCode).toBe(204);
    chat.release();
    expect(await finished(s.queues.answer, jobId(asked.id, 1))).toEqual({
      failedReason: null,
      errors: [],
    });
    expect(await leftovers(id, [asked.conversationId])).toEqual(NOTHING_LEFT);

    const other = await upload(sample);
    await ready(other);
    s.fake.script({ content: ANSWER });
    const next = await ask(other, 'Who owned the pilot?');
    await vi.waitFor(async () => expect((await message(next.id)).outcome).toBe('answered'), {
      timeout: 10_000,
    });
  });

  it('refuses a delete from a web page on another origin', async () => {
    const id = await upload(sample);
    const foreign = await remove(id, { origin: 'https://attacker.example' });
    expect([foreign.statusCode, foreign.json().error]).toEqual([403, 'origin_not_allowed']);
    expect(await status(id)).not.toBeUndefined();
    expect((await remove(id, { origin: 'http://localhost:8080' })).statusCode).toBe(204);
  });
});
