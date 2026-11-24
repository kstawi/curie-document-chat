import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from './db.js';

export interface AppDeps {
  db: Kysely<Database>;
  redis: Redis;
  logger?: FastifyServerOptions['logger'];
}

const CHECK_TIMEOUT_MS = 2_000;
const checkState = z.enum(['ok', 'unavailable']);
const readyBody = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({ database: checkState, redis: checkState }),
});

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

export function buildApp({ db, redis, logger = false }: AppDeps) {
  const app = Fastify({ logger }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

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
      const [database, redisState] = await Promise.all([
        check(() => sql`select 1`.execute(db)),
        check(() => redis.ping()),
      ]);
      const ready = database === 'ok' && redisState === 'ok';
      return reply
        .code(ready ? 200 : 503)
        .send({ status: ready ? 'ready' : 'not_ready', checks: { database, redis: redisState } });
    },
  );

  return app;
}
