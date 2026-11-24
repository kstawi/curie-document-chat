import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { HttpError } from './errors.js';
import { withTimeout, type Queues } from './queue.js';
import { conversationRoutes } from './routes/conversations.js';
import { documentRoutes } from './routes/documents.js';

export interface AppDeps {
  db: Kysely<Database>;
  redis: Redis;
  queues: Queues;
  // Questions are refused for documents embedded by another model; their vectors can't be compared.
  embeddingModel: string;
  // Where the worker leaves its start-up model check.
  modelStatusKey: string;
  settings: Pick<
    Config,
    | 'MAX_WAITING_DOCUMENTS'
    | 'MAX_WAITING_ANSWERS'
    | 'IDEMPOTENCY_KEY_TTL_MS'
    | 'IDEMPOTENCY_TAKEOVER_MS'
    | 'ALLOWED_HOSTS'
    | 'ALLOWED_ORIGINS'
    | 'RATE_LIMIT_UPLOADS_PER_MINUTE'
    | 'RATE_LIMIT_QUESTIONS_PER_MINUTE'
  >;
  logger?: FastifyServerOptions['logger'];
}

const CHECK_TIMEOUT_MS = 2_000;
const checkState = z.enum(['ok', 'unavailable']);
const modelState = z.enum(['ok', 'unavailable', 'misconfigured']);
const modelCheck = z.object({ chat: modelState, embedding: modelState, checkedAt: z.string() });
const readyBody = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({ database: checkState, redis: checkState }),
  // The worker's last start-up check of the model settings (null if it hasn't run). Reported only: questions wait
  // in the queue while the model server is away, so the API stays ready.
  model: modelCheck.nullable(),
});

// A JSON API needs few of the usual security headers: no sniffing, no framing, no referrer, nothing cached, and a
// policy that lets a response load nothing.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

// JSON bodies are a question at most; uploads go through the multipart parser, which has its own limits.
const JSON_BODY_LIMIT = 64 * 1024;

function parseModelCheck(stored: string | null) {
  try {
    return modelCheck.safeParse(JSON.parse(stored ?? 'null')).data ?? null;
  } catch {
    return null;
  }
}

// A dependency that hangs must not hang the readiness probe, so every check races a timeout.
async function check(probe: () => Promise<unknown>): Promise<z.infer<typeof checkState>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return 'ok';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

export function buildApp(deps: AppDeps) {
  const { db, redis, logger = false } = deps;
  const app = Fastify({ logger, bodyLimit: JSON_BODY_LIMIT }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Clients get a fixed code and a safe message. Unexpected errors are logged as their message only: Fastify's
  // default handler would log the whole error object, and a pg error can carry row data.
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof HttpError) {
      return reply
        .code(err.statusCode)
        .headers(err.headers)
        .send({ error: err.code, message: err.message });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: 'invalid_request', message: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: 'invalid_request', message: (err as Error).message });
    }
    request.log.error({ err: (err as Error).message }, 'request failed');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong.' });
  });
  // Without accounts, these two checks keep other websites off a local API. The Host check stops DNS rebinding (a page
  // on another name that resolves to 127.0.0.1); the Origin check stops a page on another site from posting to it.
  const hosts = new Set(deps.settings.ALLOWED_HOSTS);
  const origins = new Set(deps.settings.ALLOWED_ORIGINS);
  app.addHook('onRequest', async (request) => {
    if (!hosts.has((request.hostname ?? '').toLowerCase())) {
      throw new HttpError(
        403,
        'host_not_allowed',
        'This server does not answer to that host name.',
      );
    }
    const origin = request.headers.origin;
    const writes = request.method !== 'GET' && request.method !== 'HEAD';
    if (writes && origin !== undefined && !origins.has(origin.toLowerCase())) {
      throw new HttpError(
        403,
        'origin_not_allowed',
        'Requests from that web page are not accepted.',
      );
    }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers(SECURITY_HEADERS);
    return payload;
  });
  // Off by default; the upload and question routes set their own limits. Raised as an HttpError, so the client gets
  // the usual body with a fixed code.
  void app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      new HttpError(429, 'rate_limited', `Too many requests. Try again in ${context.after}.`, {
        'retry-after': String(Math.ceil(context.ttl / 1000)),
      }),
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'No such route.' }),
  );

  // Liveness: the process is up and serving. Says nothing about dependencies on purpose. Logged at warn only,
  // since the container healthcheck calls it every 10 s.
  app.get(
    '/health',
    { logLevel: 'warn', schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/ready',
    { schema: { response: { 200: readyBody, 503: readyBody } } },
    async (_request, reply) => {
      const [database, redisState, stored] = await Promise.all([
        check(() => sql`select 1`.execute(db)),
        check(() => redis.ping()),
        withTimeout(redis.get(deps.modelStatusKey)).catch(() => null),
      ]);
      const ready = database === 'ok' && redisState === 'ok';
      return reply.code(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'not_ready',
        checks: { database, redis: redisState },
        model: parseModelCheck(stored),
      });
    },
  );

  void app.register(documentRoutes, deps);
  void app.register(conversationRoutes, deps);

  return app;
}
