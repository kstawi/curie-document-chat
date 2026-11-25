import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { openApiDocument } from '../scripts/openapi.js';

it('matches the committed docs/openapi.json (regenerate with npm run openapi -w server)', async () => {
  const committed: unknown = JSON.parse(
    readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'),
  );
  const generated = await openApiDocument();
  expect(generated).toEqual(committed);
  // Every route is described, including the two declared outside the route modules.
  expect(Object.keys((generated as { paths: object }).paths)).toEqual(
    expect.arrayContaining(['/health', '/ready', '/documents', '/messages/{id}/events']),
  );
});
