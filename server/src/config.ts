import { z } from 'zod';

// An empty variable means unset, not zero.
const optionalNumber = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.coerce.number().optional(),
);
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

// A comma-separated list in one variable, compared in lower case.
const commaList = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );

const schema = z.object({
  // Loopback by default so a host run never exposes the API to the network; Compose sets 0.0.0.0.
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  // Lets the tests keep their queues apart from a running stack's.
  QUEUE_PREFIX: z.string().default('curie'),

  // Any OpenAI-compatible service. LM Studio ignores the key; hosted providers need one.
  MODEL_BASE_URL: z.url().default('http://127.0.0.1:1234/v1'),
  MODEL_API_KEY: z.string().default('not-needed'),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),
  CHAT_MODEL: z.string().default('google/gemma-4-26b-a4b-qat'),
  // Thinking tokens plus room for the JSON answer; the token cap, not the clock, stops a runaway.
  CHAT_MAX_TOKENS: z.coerce.number().int().positive().default(1_700),
  // Sampling and thinking settings differ by model, so each is optional and sent only when set.
  CHAT_TEMPERATURE: optionalNumber,
  CHAT_TOP_P: optionalNumber,
  CHAT_TOP_K: optionalNumber,
  CHAT_REASONING_EFFORT: optionalString,
  EMBEDDING_MODEL: z.string().default('text-embedding-nomic-embed-text-v1.5'),
  EMBEDDING_DOC_PREFIX: z.string().default('search_document: '),
  EMBEDDING_QUERY_PREFIX: z.string().default('search_query: '),
  EMBEDDING_DIMENSIONS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  PASSAGE_TOKEN_BUDGET: z.coerce.number().int().positive().default(4_000),

  // The retry with thinking off, after a runaway, an unusable reply or a stuck call. Each model has its own switch
  // ("none" for Gemma in LM Studio, "low" for gemini-3.5-flash); an empty value sends none, leaving temperature 0.
  CHAT_RETRY_REASONING_EFFORT: z
    .string()
    .default('none')
    .transform((v) => (v === '' ? undefined : v)),
  CHAT_RETRY_TEMPERATURE: z.coerce.number().default(0),
  CHAT_RETRY_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // Rewriting a follow-up into a standalone search question: a short call with thinking off.
  REWRITE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  REWRITE_MAX_TOKENS: z.coerce.number().int().positive().default(400),
  // Attempts per job when the model server is down, overloaded or stuck, with exponential backoff between them.
  JOB_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  JOB_BACKOFF_MS: z.coerce.number().int().positive().default(5_000),
  // Caps on one run of a job, every call in it included. A run that reaches its limit ends the job with
  // model_unavailable; it isn't run again.
  ANSWER_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  PREPARE_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
  // The sweeper queues again rows left without a live job, and gives up after MAX_REQUEUES.
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SWEEP_STALE_MS: z.coerce.number().int().positive().default(120_000),
  MAX_REQUEUES: z.coerce.number().int().min(0).default(2),
  // One tiny call to each model when the worker starts, reported on /ready. Turn it off where the model server
  // loads models on demand and a worker restart shouldn't load one.
  MODEL_STARTUP_CHECK: z.stringbool().default(true),

  // New uploads and questions get 503 "busy" while this many jobs already wait. Approximate: two requests at the same
  // moment can both see one place left.
  MAX_WAITING_DOCUMENTS: z.coerce.number().int().min(1).default(20),
  MAX_WAITING_ANSWERS: z.coerce.number().int().min(1).default(20),
  // How long a repeated request with the same Idempotency-Key gets the first response.
  IDEMPOTENCY_KEY_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 3_600_000),
  // A request holding a key this long without finishing is presumed dead, and its key can be taken over.
  IDEMPOTENCY_TAKEOVER_MS: z.coerce.number().int().positive().default(60_000),

  // Host names the API answers to, compared without the port (one written with a port has it dropped; IPv6 goes in
  // brackets, as [::1]). Keep 127.0.0.1: the container's health check uses it. Then the web origins allowed to send
  // POSTs. A request without an Origin header (curl, scripts) is not a browser page and is allowed. Step 8 adds the
  // web app's origin.
  ALLOWED_HOSTS: commaList('localhost,127.0.0.1').transform((hosts) =>
    hosts.map((h) => {
      const name = h.replace(/^(\[[^\]]*\]|[^:]+):\d+$/, '$1');
      // A bare IPv6 address goes in brackets, as Fastify reports it.
      return name.includes(':') && !name.startsWith('[') ? `[${name}]` : name;
    }),
  ),
  ALLOWED_ORIGINS: commaList('').transform((origins, ctx) =>
    origins.map((o) => {
      // As a browser sends it: scheme, host and port, with a default port and any path dropped.
      const origin = URL.parse(o)?.origin;
      if (!origin || origin === 'null') {
        ctx.addIssue({ code: 'custom', message: `ALLOWED_ORIGINS: "${o}" is not a web origin` });
      }
      return origin ?? o;
    }),
  ),
  // Requests a minute, for uploads (with document retries) and for questions (with answer retries). Keyed by client
  // address; under Compose every request comes from the same Docker address, so these act as totals.
  RATE_LIMIT_UPLOADS_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_QUESTIONS_PER_MINUTE: z.coerce.number().int().min(1).default(30),
});

export type Config = z.infer<typeof schema>;

// What a document's vectors are stored under. The size is part of it: the same model asked for fewer dimensions
// produces vectors that can't be compared with the old ones.
export const embeddingIdentity = (c: Pick<Config, 'EMBEDDING_MODEL' | 'EMBEDDING_DIMENSIONS'>) =>
  c.EMBEDDING_DIMENSIONS ? `${c.EMBEDDING_MODEL}@${c.EMBEDDING_DIMENSIONS}` : c.EMBEDDING_MODEL;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
