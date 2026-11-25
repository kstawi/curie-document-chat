// Writes the API description to docs/openapi.json from the routes' own schemas. A test checks the committed file
// still matches, so run this after changing a route: npm run openapi -w server
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';

export async function openApiDocument() {
  // Routes use their dependencies only when serving a request, so nothing here is connected.
  const app = buildApp({
    db: {} as never,
    redis: {} as never,
    queues: {} as never,
    answerEvents: { subscribe: () => () => {} },
    embeddingModel: '',
    modelStatusKey: '',
    settings: {
      MAX_WAITING_DOCUMENTS: 1,
      MAX_WAITING_ANSWERS: 1,
      IDEMPOTENCY_KEY_TTL_MS: 1,
      IDEMPOTENCY_TAKEOVER_MS: 1,
      ALLOWED_HOSTS: [],
      ALLOWED_ORIGINS: [],
      RATE_LIMIT_UPLOADS_PER_MINUTE: 1,
      RATE_LIMIT_QUESTIONS_PER_MINUTE: 1,
      STREAM_HEARTBEAT_MS: 1,
    },
  });
  await app.ready();
  const document: unknown = JSON.parse(JSON.stringify(app.swagger()));
  await app.close();
  return document;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = fileURLToPath(new URL('../../docs/openapi.json', import.meta.url));
  writeFileSync(out, `${JSON.stringify(await openApiDocument(), null, 2)}\n`);
  console.log(`wrote ${out}`);
}
