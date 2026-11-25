import { z } from 'zod';
import type { PageSpan } from '../db.js';
import { isBlank } from '../text/clean.js';
import { MAX_PAGES } from './limits.js';

// 100 dense pages come to well under 1 MB of text; anything far past that is not a reply to trust.
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

const FAILURES = [
  'pdf_encrypted',
  'pdf_no_text',
  'pdf_too_many_pages',
  'pdf_parse_failed',
  'pdf_parse_timeout',
] as const;

const parserReply = z.union([
  z.strictObject({ pages: z.array(z.string()).min(1).max(MAX_PAGES) }),
  z.strictObject({ error: z.enum(FAILURES) }),
]);

// The parser could not be reached or answered with a server error: worth trying again later.
export class ParserUnavailable extends Error {}

// A reply that says the file can't be used, or a reply that can't be trusted.
export class PdfFailure extends Error {
  constructor(readonly code: (typeof FAILURES)[number]) {
    super(code);
  }
}

async function readCapped(res: Response, limit: number): Promise<string | null> {
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

// Sends a PDF to the parser and turns its page texts into the stored text and page map. The pages are joined by a
// blank line; NUL, which Postgres text can't hold, is dropped, and line endings become LF as for uploads.
export async function extractPdf(
  parserUrl: string,
  bytes: Uint8Array,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ content: string; pages: PageSpan[] }> {
  // The job's own signal (shutdown, the job's time limit) is passed on as it is; the call's own time limit, like a
  // refused connection or a server error, means the parser is unavailable for now.
  const call = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let body: string | null;
  try {
    const res = await fetch(new URL('/extract', parserUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: bytes,
      signal: call,
    });
    if (!res.ok) await res.body?.cancel();
    if (res.status >= 500) throw new ParserUnavailable(`parser answered ${res.status}`);
    body = res.ok ? await readCapped(res, MAX_REPLY_BYTES) : null;
  } catch (err) {
    if (signal.aborted || err instanceof ParserUnavailable) throw err;
    throw new ParserUnavailable((err as Error).message);
  }
  let reply;
  try {
    reply = parserReply.safeParse(JSON.parse(body ?? 'null'));
  } catch {
    throw new PdfFailure('pdf_parse_failed');
  }
  if (!reply.success) throw new PdfFailure('pdf_parse_failed');
  if ('error' in reply.data) throw new PdfFailure(reply.data.error);

  let content = '';
  const pages: PageSpan[] = [];
  reply.data.pages.forEach((raw, i) => {
    const text = raw.replace(/\0/g, '').replace(/\r\n?/g, '\n');
    if (i > 0) content += '\n\n';
    pages.push({ page: i + 1, start: content.length, end: content.length + text.length });
    content += text;
  });
  if (isBlank(content)) throw new PdfFailure('pdf_no_text');
  return { content, pages };
}
