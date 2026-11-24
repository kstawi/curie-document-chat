// Follows one question and one follow-up over the event stream of the running stack, then checks the reconnect
// after the end (204) and a client arriving late. Usage: node scripts/stream-check.mjs samples/harbor-archive-pilot.md
import { readFileSync } from 'node:fs';
import { get } from 'node:http';

const BASE = 'http://127.0.0.1:3000';
const sample = readFileSync(process.argv[2]);

const json = async (res) => ({ status: res.status, body: await res.json() });

function follow(id) {
  const start = Date.now();
  const s = () => ((Date.now() - start) / 1000).toFixed(1).padStart(5);
  return new Promise((resolve, reject) => {
    const req = get(`${BASE}/messages/${id}/events`, { agent: false }, (res) => {
      console.log(`${s()} s  HTTP ${res.statusCode} ${res.headers['content-type']}`);
      let buffer = '';
      let final;
      res.setEncoding('utf8').on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const fields = Object.fromEntries(
            block
              .split('\n')
              .map((l) => [
                l.slice(0, l.indexOf(':')) || 'comment',
                l.slice(l.indexOf(':') + 1).trim(),
              ]),
          );
          if (fields.comment !== undefined) {
            console.log(`${s()} s  : ${fields.comment}`);
            continue;
          }
          const m = JSON.parse(fields.data);
          if (fields.event === 'final') final = m;
          console.log(
            `${s()} s  ${fields.event}${fields.id ? ` (id ${fields.id})` : ''}: status ${m.status}, stage ${m.stage}` +
              (m.outcome ? `, outcome ${m.outcome}, ${m.quotes.length} quote(s)` : ''),
          );
        }
      });
      res.on('close', () => {
        console.log(`${s()} s  stream closed by the server`);
        resolve(final);
      });
    });
    req.on('error', reject);
  });
}

const form = new FormData();
form.append('file', new Blob([sample], { type: 'text/markdown' }), 'harbor-archive-pilot.md');
form.append('title', 'Harbor Archive');
const up = await json(await fetch(`${BASE}/documents`, { method: 'POST', body: form }));
const docId = up.body.id;
for (;;) {
  const d = await json(await fetch(`${BASE}/documents/${docId}`));
  if (d.body.status === 'ready') break;
  if (d.body.status === 'failed')
    throw new Error(`document failed: ${JSON.stringify(d.body.error)}`);
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('document ready');
const conv = await json(
  await fetch(`${BASE}/documents/${docId}/conversations`, { method: 'POST' }),
);

for (const question of ['Who owned the limited pilot?', 'And what did they decide about it?']) {
  console.log(`\nQuestion: ${question}`);
  const asked = await json(
    await fetch(`${BASE}/conversations/${conv.body.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    }),
  );
  const final = await follow(asked.body.id);
  console.log(`Answer: ${final?.answer ?? final?.note ?? JSON.stringify(final?.error)}`);
  const again = await fetch(`${BASE}/messages/${asked.body.id}/events`, {
    headers: { 'last-event-id': 'final' },
  });
  console.log(`Reconnect with Last-Event-ID: final -> HTTP ${again.status}`);
  console.log('Late client:');
  await follow(asked.body.id);
}
