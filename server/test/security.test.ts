import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { answerQuestion } from '../src/jobs/answer.js';
import { prepareDocument } from '../src/jobs/prepare.js';
import { modelStatusKey } from '../src/queue.js';
import { forModel } from '../src/text/clean.js';
import { jobContext, multipart, startStack } from './helpers/stack.js';

// Step 4: who may call the API, what it sends back, and what reaches the logs.

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
const hidden = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const tagged = (text: string) => hidden(...[...text].map((c) => 0xe0000 + c.codePointAt(0)!));

let stack: Awaited<ReturnType<typeof startStack>>;
let documentId: string;
beforeAll(async () => {
  stack = await startStack({ ALLOWED_ORIGINS: ['http://localhost:8080'] });
  stack.fake.script({ content: answered() });
  const res = await stack.app.inject({
    method: 'POST',
    url: '/documents',
    ...multipart({ content: sample }),
  });
  documentId = res.json().id;
  await vi.waitFor(
    async () =>
      expect((await stack.app.inject(`/documents/${documentId}`)).json().status).toBe('ready'),
    { timeout: 10_000 },
  );
});
afterAll(() => stack?.stop());

const conversation = async () =>
  (await stack.app.inject({ method: 'POST', url: `/documents/${documentId}/conversations` })).json()
    .id as string;

describe('who may call the API', () => {
  it('answers only to the allowed host names, on every route', async () => {
    for (const url of ['/health', '/documents', `/documents/${documentId}`]) {
      const res = await stack.app.inject({ url, headers: { host: 'attacker.example:3000' } });
      expect([url, res.statusCode, res.json().error]).toEqual([url, 403, 'host_not_allowed']);
    }
    // HTTP/1.0 allows a request with no Host header at all; inject always adds one, so this goes over a socket.
    const address = await stack.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = new URL(address);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1', () =>
        socket.end('GET /health HTTP/1.0\r\n\r\n'),
      );
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(reply.split('\r\n')[0]).toMatch(/^HTTP\/1\.[01] 403 Forbidden$/);
    for (const host of ['127.0.0.1:3000', 'LOCALHOST:3000', 'localhost']) {
      expect((await stack.app.inject({ url: '/health', headers: { host } })).statusCode).toBe(200);
    }
  });

  it('reads host names written with a port as the name alone', () => {
    const settings = loadConfig({
      ...process.env,
      ALLOWED_HOSTS: 'Example.test:8080,[::1]:3000,localhost',
    });
    expect(settings.ALLOWED_HOSTS).toEqual(['example.test', '[::1]', 'localhost']);
    expect(loadConfig({ ...process.env, ALLOWED_HOSTS: '::1' }).ALLOWED_HOSTS).toEqual(['[::1]']);
    // Origins as a browser sends them, and a list with something else in it refused at start.
    const origins = loadConfig({
      ...process.env,
      ALLOWED_ORIGINS: 'http://localhost:8080/,HTTP://Example.test:80',
    });
    expect(origins.ALLOWED_ORIGINS).toEqual(['http://localhost:8080', 'http://example.test']);
    expect(() => loadConfig({ ...process.env, ALLOWED_ORIGINS: 'not an origin' })).toThrow(
      /not a web origin/,
    );
  });

  it('refuses a POST from a web page on another origin, but not one without an Origin', async () => {
    const post = (origin?: string) =>
      stack.app.inject({
        method: 'POST',
        url: `/documents/${documentId}/conversations`,
        headers: origin ? { origin } : {},
      });
    const foreign = await post('https://attacker.example');
    expect([foreign.statusCode, foreign.json().error]).toEqual([403, 'origin_not_allowed']);
    expect((await post('null')).statusCode).toBe(403);
    expect((await post('http://localhost:8080')).statusCode).toBe(201);
    expect((await post()).statusCode).toBe(201);
    // A GET changes nothing, and with no CORS headers the foreign page can't read the answer anyway.
    const get = await stack.app.inject({
      url: `/documents/${documentId}`,
      headers: { origin: 'https://attacker.example' },
    });
    expect(get.statusCode).toBe(200);
  });
});

describe('responses', () => {
  it('carry the security headers, errors included', async () => {
    const requests = [
      { url: '/health' },
      { url: `/documents/${randomUUID()}` },
      { url: '/documents/not-a-uuid' },
      { url: '/health', headers: { host: 'attacker.example' } },
    ];
    for (const request of requests) {
      const res = await stack.app.inject(request);
      expect(res.headers).toMatchObject({
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'no-store',
      });
    }
  });
});

describe('request size', () => {
  it('refuses a JSON body over 64 KB, while an upload of nearly 1 MB still goes through', async () => {
    const big = await stack.app.inject({
      method: 'POST',
      url: `/conversations/${await conversation()}/messages`,
      payload: { question: 'x'.repeat(70 * 1024) },
    });
    expect(big.statusCode).toBe(413);
    const upload = await stack.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({
        content: `# Big\n\n${'Words in a long paragraph. '.repeat(38_000)}`.slice(0, 1_000_000),
      }),
    });
    expect(upload.statusCode).toBe(202);
  });

  it('refuses unknown query parameters', async () => {
    const res = await stack.app.inject('/documents?limit=5&debug=1');
    expect([res.statusCode, res.json().error]).toEqual([400, 'invalid_request']);
  });
});

describe('questions', () => {
  it('are stored without hidden characters, composed and on one line', async () => {
    const c = await conversation();
    // A NUL, a bidi override, tag characters spelling "ignore", a zero-width space, a line break, and an e plus a
    // combining acute accent (composed to é).
    const raw = `Who${hidden(0)} owned${hidden(0x202e)} the${hidden(0xe0069, 0xe0067, 0xe006e)} pi${hidden(0x200b)}lot\nin cafe${hidden(0x301)}?`;
    const res = await stack.app.inject({
      method: 'POST',
      url: `/conversations/${c}/messages`,
      payload: { question: raw },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().question).toBe('Who owned the pilot in café?');
  });

  it('are refused when nothing but hidden characters is left', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: `/conversations/${await conversation()}/messages`,
      payload: { question: hidden(0x200b, 0xe0041, 0x202e, 0x7) },
    });
    expect([res.statusCode, res.json().error]).toEqual([400, 'invalid_request']);
  });
});

describe('documents with hidden characters', () => {
  it('fail as empty when the body under a heading has nothing visible in it', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({ content: `# Title\n\n${hidden(0x200b, 0x200b)}\n` }),
    });
    const id = res.json().id as string;
    await vi.waitFor(
      async () =>
        expect((await stack.app.inject(`/documents/${id}`)).json()).toMatchObject({
          status: 'failed',
          error: { code: 'empty_document' },
        }),
      { timeout: 10_000 },
    );
  });

  it('skip a chunk with nothing visible left, and index the rest cleaned', async () => {
    const content = [
      `# Ti${hidden(0x200b)}tle`,
      '',
      'Visible words in a long paragraph. '.repeat(28).trim(),
      '',
      // One line too long for a chunk, cut in two: the second part is hidden characters only.
      `Visible words at the start.${tagged('x'.repeat(1_500))}`,
      '',
      'A short visible paragraph at the end.',
      '',
    ].join('\n');
    const res = await stack.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({ content }),
    });
    const id = res.json().id as string;
    await vi.waitFor(
      async () => expect((await stack.app.inject(`/documents/${id}`)).json().status).toBe('ready'),
      { timeout: 10_000 },
    );
    const chunks = await stack.db
      .selectFrom('chunks')
      .select(['ordinal', 'text', 'heading_path'])
      .where('document_id', '=', id)
      .orderBy('ordinal')
      .execute();
    // The hidden run made a chunk of its own, which was skipped, so the ordinals have a gap.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)!.ordinal).toBeGreaterThan(chunks.length - 1);
    for (const c of chunks) {
      expect(c.text.trim()).not.toBe('');
      expect(forModel(c.text)).toBe(c.text);
      expect(c.heading_path).toBe('Title');
    }
  });

  it('are refused when nothing visible is left', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({ content: hidden(0xe0049, 0xe0067, 0x200b, 0x202e) }),
    });
    expect([res.statusCode, res.json().error]).toEqual([400, 'empty_document']);
  });

  it('are indexed from the cleaned text, so a soft hyphen cannot hide a word from search', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({ content: `# Access\n\nThe pass${hidden(0xad)}word is kept in the vault.\n` }),
    });
    const id = res.json().id as string;
    await vi.waitFor(
      async () => expect((await stack.app.inject(`/documents/${id}`)).json().status).toBe('ready'),
      { timeout: 10_000 },
    );
    const { rows } = await sql<{ text: string; found: boolean }>`
      select text, tsv @@ plainto_tsquery('english', 'password') as found from chunks where document_id = ${id}
    `.execute(stack.db);
    expect(rows).toEqual([{ text: '# Access\n\nThe password is kept in the vault.', found: true }]);
  });
});

describe('model text and labels a reader sees', () => {
  it('carry no hidden characters: the answer, and the section of a quote', async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: '/documents',
      ...multipart({
        content: `# Pricing${hidden(0x202e)} and terms\n\nThe pricing section says the pilot ran for six weeks in total.\n`,
      }),
    });
    const doc = res.json().id as string;
    await vi.waitFor(
      async () => expect((await stack.app.inject(`/documents/${doc}`)).json().status).toBe('ready'),
      { timeout: 10_000 },
    );
    const c = (
      await stack.app.inject({ method: 'POST', url: `/documents/${doc}/conversations` })
    ).json().id as string;
    stack.fake.reply({
      outcome: 'answered',
      answer: `Six${hidden(0x202e)} weeks.`,
      quotes: ['the pilot ran for six weeks in total'],
    });
    const asked = await stack.app.inject({
      method: 'POST',
      url: `/conversations/${c}/messages`,
      payload: { question: 'How long did the pilot run?' },
    });
    let turn: { status: string; answer: string; quotes: { section: string }[] } = {
      status: 'pending',
      answer: '',
      quotes: [],
    };
    await vi.waitFor(
      async () => {
        turn = (await stack.app.inject(`/messages/${asked.json().id}`)).json();
        expect(turn.status).toBe('completed');
      },
      { timeout: 10_000 },
    );
    stack.fake.script({ content: answered() });
    expect(turn.answer).toBe('Six weeks.');
    expect(turn.quotes[0]!.section).toBe('Pricing and terms');
  });
});

describe('a document that failed for good', () => {
  it('is not prepared again', async () => {
    for (const code of ['empty_document', 'too_many_passages']) {
      const id = (
        await stack.db
          .insertInto('documents')
          .values({
            title: 'x',
            format: 'text',
            content: sample,
            status: 'failed',
            error_code: code,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const res = await stack.app.inject({ method: 'POST', url: `/documents/${id}/retry` });
      expect([code, res.statusCode, res.json().error]).toEqual([code, 409, 'not_retryable']);
    }
  });
});

describe('rate limits', () => {
  let limited: Awaited<ReturnType<typeof startStack>>;
  beforeAll(async () => {
    limited = await startStack({
      RATE_LIMIT_UPLOADS_PER_MINUTE: 1,
      RATE_LIMIT_QUESTIONS_PER_MINUTE: 2,
    });
    limited.fake.script({ content: answered() });
  });
  afterAll(() => limited?.stop());

  it('give 429 with Retry-After past the limit, uploads and questions counted apart', async () => {
    const upload = () =>
      limited.app.inject({ method: 'POST', url: '/documents', ...multipart({ content: sample }) });
    const first = await upload();
    expect(first.statusCode).toBe(202);
    const doc = first.json().id as string;
    const tooMany = await upload();
    expect([tooMany.statusCode, tooMany.json().error]).toEqual([429, 'rate_limited']);
    expect(tooMany.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    expect(Number(tooMany.headers['retry-after'])).toBeGreaterThan(0);
    // Document retries count with uploads.
    const retry = await limited.app.inject({ method: 'POST', url: `/documents/${doc}/retry` });
    expect(retry.statusCode).toBe(429);

    await vi.waitFor(
      async () =>
        expect((await limited.app.inject(`/documents/${doc}`)).json().status).toBe('ready'),
      { timeout: 10_000 },
    );
    const ask = async () => {
      const c = (
        await limited.app.inject({ method: 'POST', url: `/documents/${doc}/conversations` })
      ).json().id;
      return limited.app.inject({
        method: 'POST',
        url: `/conversations/${c}/messages`,
        payload: { question: 'Who owned the pilot?' },
      });
    };
    expect((await ask()).statusCode).toBe(202);
    expect((await ask()).statusCode).toBe(202);
    const third = await ask();
    expect([third.statusCode, third.json().error]).toEqual([429, 'rate_limited']);
    // Answer retries count with questions.
    const failed = (
      await limited.db
        .insertInto('turns')
        .values({
          conversation_id: (
            await limited.db
              .insertInto('conversations')
              .values({ document_id: doc })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id,
          sequence: 1,
          question: 'Who owned the pilot?',
          status: 'failed',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    expect(
      (await limited.app.inject({ method: 'POST', url: `/messages/${failed}/retry` })).statusCode,
    ).toBe(429);
  });
});

describe('logs', () => {
  it('never carry document text, titles, questions or answers', async () => {
    const lines: string[] = [];
    const stream = { write: (line: string) => void lines.push(line) };
    const app = buildApp({
      db: stack.db,
      redis: stack.redis,
      queues: stack.queues,
      embeddingModel: 'fake-embed',
      modelStatusKey: modelStatusKey(stack.deps.config.QUEUE_PREFIX),
      settings: stack.deps.config,
      logger: { level: 'trace', stream },
    });
    const log = pino({ level: 'trace' }, stream);
    const secret = `secret-${randomUUID()}`;
    try {
      // Through the API: an upload with the phrase in its title and text, and a question holding it.
      const upload = await app.inject({
        method: 'POST',
        url: '/documents',
        ...multipart(
          { content: `# ${secret}\n\nMira Chen owned the limited pilot. ${secret}.\n` },
          { title: secret },
        ),
      });
      expect(upload.statusCode).toBe(202);
      const c = (
        await app.inject({ method: 'POST', url: `/documents/${documentId}/conversations` })
      ).json().id as string;
      const ask = await app.inject({
        method: 'POST',
        url: `/conversations/${c}/messages`,
        payload: { question: `Who owned ${secret}?` },
      });
      expect(ask.statusCode).toBe(202);
      await app.inject({
        method: 'POST',
        url: `/conversations/${c}/messages`,
        payload: { question: `${secret} again, while the first is pending?` },
      });

      // Through the job handlers, with their own logger: a preparation, an answer that echoes the phrase, and one
      // that fails with the phrase in the model's reply.
      const doc = (
        await stack.db
          .insertInto('documents')
          .values({ title: secret, format: 'markdown', content: `# ${secret}\n\n${sample}` })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await prepareDocument(stack.deps, { documentId: doc, attempt: 1 }, jobContext({ log }));
      for (const content of [
        JSON.stringify({
          outcome: 'answered',
          answer: secret,
          quotes: ['Mira Chen owned the limited pilot.'],
        }),
        `not JSON: ${secret}`,
      ]) {
        stack.fake.script({ content });
        const turn = (
          await stack.db
            .insertInto('turns')
            .values({
              conversation_id: (
                await stack.db
                  .insertInto('conversations')
                  .values({ document_id: doc })
                  .returning('id')
                  .executeTakeFirstOrThrow()
              ).id,
              sequence: 1,
              question: `Who owned ${secret}?`,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        await answerQuestion(stack.deps, { turnId: turn, attempt: 1 }, jobContext({ log }));
      }
    } finally {
      stack.fake.script({ content: answered() });
      await app.close();
    }
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.filter((l) => l.includes(secret))).toEqual([]);
  });
});
