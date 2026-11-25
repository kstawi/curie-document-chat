import { fork } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { PdfResult } from './extract.js';
import { MAX_PDF_BYTES } from './limits.js';

export type ParseReply = PdfResult | { error: 'pdf_parse_timeout' };

// Built code runs the compiled child; tests run from source, through tsx.
const childFile = fileURLToPath(
  new URL(`./child${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url),
);
const loader = childFile.endsWith('.ts') ? ['--import', 'tsx'] : [];

// Runs one extraction in a child process with its own heap cap, killed at the time limit.
function extractInChild(data: Buffer, timeoutMs: number, heapMb: number, signal: AbortSignal) {
  return new Promise<{ reply: ParseReply; pid?: number }>((resolve) => {
    const child = fork(childFile, [], {
      execArgv: [...loader, `--max-old-space-size=${heapMb}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const finish = (reply: ParseReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      child.kill('SIGKILL');
      resolve({ reply, pid: child.pid });
    };
    const stop = () => finish({ error: 'pdf_parse_failed' });
    const timer = setTimeout(() => finish({ error: 'pdf_parse_timeout' }), timeoutMs);
    signal.addEventListener('abort', stop);
    child.once('message', (reply) => finish(reply as PdfResult));
    // Out of memory, a crash, or a kill from outside: no reply came.
    child.once('exit', () => finish({ error: 'pdf_parse_failed' }));
    child.once('error', () => finish({ error: 'pdf_parse_failed' }));
    child.send(data);
  });
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts);
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// The PDF parser: POST /extract with the file as the body, answered with the page texts or a fixed error code.
// It has no database, queue or model access, and in Compose sits on an internal network with the worker only.
export function createPdfParser({
  timeoutMs,
  heapMb,
  log,
}: {
  timeoutMs: number;
  heapMb: number;
  log: Logger;
}) {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/extract')
      return json(res, 404, { error: 'not_found' });
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    void (async () => {
      const data = await readBody(req, MAX_PDF_BYTES);
      if (!data) {
        json(res, 413, { error: 'file_too_large' });
        req.destroy();
        return;
      }
      const started = Date.now();
      const { reply, pid } = await extractInChild(data, timeoutMs, heapMb, abort.signal);
      log.info(
        {
          child: pid,
          bytes: data.length,
          ms: Date.now() - started,
          result: 'error' in reply ? reply.error : 'ok',
        },
        'pdf extracted',
      );
      json(res, 200, reply);
    })().catch((err: Error) => {
      log.error({ err: err.message }, 'pdf extraction failed');
      if (!res.headersSent) json(res, 500, { error: 'pdf_parse_failed' });
    });
  });
}
