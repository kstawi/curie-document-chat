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
