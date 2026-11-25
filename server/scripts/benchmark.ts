// The search benchmark (docs/benchmark.md): prepares the benchmark document with the real job, ranks the passages for
// each question with the real search, and reports hit@1 and hit@3 for keyword, meaning and hybrid.
// Usage: npm run bench -w server              (the models in .env)
//        npm run bench -w server -- --gemini  (Gemini, with GEMINI_API_KEY from .env)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { pino } from 'pino';
import { loadConfig, type Config } from '../src/config.js';
import { createDb } from '../src/db.js';
import { prepareDocument } from '../src/jobs/prepare.js';
import { migrateToLatest } from '../src/migrate.js';
import { createModel } from '../src/model.js';
import { rewritePrompt, type EarlierTurn } from '../src/prompt.js';
import { rankPassages, searchDocument, type Passage } from '../src/search.js';

interface Question {
  id: string;
  kind: 'exact' | 'paraphrase' | 'follow-up';
  question: string;
  previous?: EarlierTurn;
  expect: string[];
}

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const content = read('samples/benchmark/saltmarsh-field-report.md');
const { questions } = JSON.parse(read('samples/benchmark/questions.json')) as {
  questions: Question[];
};

const gemini = process.argv.includes('--gemini');
const base = loadConfig();
const config: Config = gemini
  ? {
      ...base,
      // As in the Gemini block of .env.example; the key comes only from GEMINI_API_KEY and is never printed.
      MODEL_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      MODEL_API_KEY: process.env.GEMINI_API_KEY ?? '',
      CHAT_MODEL: 'gemini-3.5-flash',
      CHAT_TEMPERATURE: undefined,
      CHAT_TOP_P: undefined,
      CHAT_TOP_K: undefined,
      EMBEDDING_MODEL: 'gemini-embedding-2',
      EMBEDDING_DOC_PREFIX: 'title: none | text: ',
      EMBEDDING_QUERY_PREFIX: 'task: search result | query: ',
      CHAT_RETRY_REASONING_EFFORT: 'low',
    }
  : base;
if (gemini && !config.MODEL_API_KEY) throw new Error('GEMINI_API_KEY is not set in .env');

// Its own database, so a run never touches the app's or the tests' data.
const url = new URL(config.DATABASE_URL);
url.pathname = '/curie_bench';
const admin = new pg.Client({
  connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).href,
});
await admin.connect();
if (!(await admin.query("select 1 from pg_database where datname = 'curie_bench'")).rowCount) {
  await admin.query('create database curie_bench');
}
await admin.end();
const db = createDb(url.href);
await migrateToLatest(db);
await db.deleteFrom('documents').execute();

const log = pino({ level: 'warn' });
const model = createModel(config);
const spans = (q: Question) =>
  q.expect.map((text) => {
    const start = content.indexOf(text);
    if (start < 0 || content.indexOf(text, start + 1) >= 0) {
      throw new Error(`${q.id}: expected text must occur exactly once: ${JSON.stringify(text)}`);
    }
    return { start, end: start + text.length };
  });
const found = (q: Question, passages: Pick<Passage, 'start' | 'end'>[]) =>
  passages.some((p) => spans(q).some((s) => p.start < s.end && s.start < p.end));

try {
  const { id: documentId } = await db
    .insertInto('documents')
    .values({ title: 'Search benchmark', format: 'markdown', content })
    .returning('id')
    .executeTakeFirstOrThrow();
  const never = new AbortController().signal;
  await prepareDocument(
    { db, model, log, config },
    { documentId, attempt: 1 },
    { signal: never, shutdown: never, lastAttempt: true, log, progress: () => {} },
  );
  const doc = await db
    .selectFrom('documents')
    .select(['status', 'error_code'])
    .where('id', '=', documentId)
    .executeTakeFirstOrThrow();
  if (doc.status !== 'ready') throw new Error(`preparation failed: ${doc.error_code}`);

  // Follow-ups as the app searches them: rewritten by the chat model, falling back as the app does.
  const asked: { q: Question; text: string; variant: 'as asked' | 'rewritten'; note?: string }[] =
    [];
  for (const q of questions) {
    asked.push({ q, text: q.question, variant: 'as asked' });
    if (!q.previous) continue;
    try {
      asked.push({
        q,
        text: await model.rewrite(rewritePrompt(q.question, [q.previous])),
        variant: 'rewritten',
      });
    } catch (err) {
      asked.push({
        q,
        text: `${q.previous.question} ${q.question}`,
        variant: 'rewritten',
        note: `rewrite failed (${(err as Error).message}); searched with both questions`,
      });
    }
  }
  const vectors = await model.embed(
    asked.map((a) => a.text),
    'query',
  );

  const METHODS = ['keyword', 'meaning', 'hybrid'] as const;
  type Hits = Record<(typeof METHODS)[number], boolean>;
  const rows: {
    id: string;
    kind: Question['kind'];
    variant: 'as asked' | 'rewritten';
    searched: string;
    note?: string;
    hit1: Hits;
    hit3: Hits;
    inBudget: boolean;
  }[] = [];
  for (const [i, a] of asked.entries()) {
    const ranked = await rankPassages(db, documentId, a.text, vectors[i]!);
    const orders = {
      keyword: ranked
        .filter((p) => p.keywordRank !== null)
        .sort((x, y) => x.keywordRank! - y.keywordRank!),
      meaning: ranked
        .filter((p) => p.meaningRank !== null)
        .sort((x, y) => x.meaningRank! - y.meaningRank!),
      hybrid: ranked,
    };
    const sent = await searchDocument(
      db,
      documentId,
      a.text,
      vectors[i]!,
      config.PASSAGE_TOKEN_BUDGET,
    );
    rows.push({
      id: a.q.id,
      kind: a.q.kind,
      variant: a.variant,
      searched: a.text,
      ...(a.note ? { note: a.note } : {}),
      hit1: Object.fromEntries(METHODS.map((m) => [m, found(a.q, orders[m].slice(0, 1))])) as Hits,
      hit3: Object.fromEntries(METHODS.map((m) => [m, found(a.q, orders[m].slice(0, 3))])) as Hits,
      inBudget: found(a.q, sent),
    });
  }

  // The questions that decide: every first question, and the follow-ups as rewritten.
  const deciding = rows.filter((r) => r.kind !== 'follow-up' || r.variant === 'rewritten');
  const groups = {
    all: deciding,
    exact: deciding.filter((r) => r.kind === 'exact'),
    paraphrase: deciding.filter((r) => r.kind === 'paraphrase'),
    'follow-up (rewritten)': deciding.filter((r) => r.kind === 'follow-up'),
    'follow-up (as asked)': rows.filter((r) => r.kind === 'follow-up' && r.variant === 'as asked'),
  };
  const count = (list: typeof rows, pick: (r: (typeof rows)[number]) => boolean) =>
    `${list.filter(pick).length}/${list.length}`;
  const table = [
    '| Questions | Keyword hit@1 | Keyword hit@3 | Meaning hit@1 | Meaning hit@3 | Hybrid hit@1 | Hybrid hit@3 | Hybrid in budget |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(groups).map(
      ([name, list]) =>
        `| ${name} | ${METHODS.flatMap((m) => [
          count(list, (r) => r.hit1[m]),
          count(list, (r) => r.hit3[m]),
        ]).join(' | ')} | ${count(list, (r) => r.inBudget)} |`,
    ),
  ].join('\n');

  const date = new Date().toISOString().slice(0, 10);
  const result = {
    date,
    chatModel: config.CHAT_MODEL,
    embeddingModel: model.embeddingModel,
    passages: (
      await db
        .selectFrom('chunks')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('document_id', '=', documentId)
        .executeTakeFirstOrThrow()
    ).n,
    budgetTokens: config.PASSAGE_TOKEN_BUDGET,
    table,
    rows,
  };
  mkdirSync(new URL('docs/runs/', root), { recursive: true });
  const file = `docs/runs/${date}-benchmark-${config.EMBEDDING_MODEL.replace(/[^a-z0-9.]+/gi, '-')}.json`;
  writeFileSync(new URL(file, root), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `${config.EMBEDDING_MODEL} (chat ${config.CHAT_MODEL}), ${result.passages} passages\n\n${table}\n`,
  );
  for (const r of rows.filter((r) => !r.hit3.hybrid)) {
    console.log(`hybrid miss at 3: ${r.id} (${r.variant}): ${r.searched}`);
  }
  console.log(`\nwritten to ${file}`);
} finally {
  await db.destroy();
}
