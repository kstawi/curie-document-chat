export interface Chunk {
  ordinal: number;
  start: number;
  end: number;
  headingPath: string;
  text: string;
}

interface Span {
  start: number;
  end: number;
}

export interface Section {
  start: number;
  path: string;
}

// About 300 tokens at the usual four characters per token; well under the embedding model's 2,048-token limit.
const TARGET_CHARS = 1_200;
const MAX_CHARS = 1_600;
// A section shorter than this is packed together with the next one, so a glossary or changelog with thousands of
// one-line sections still makes passages of a useful size (and a manageable number of them).
const MIN_CHARS = 400;

// shortcut: a character-based estimate, not the model's tokenizer; budgets keep a margin for that.
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

// A heading longer than this is treated as an ordinary paragraph. Real headings are short, and the cap keeps every
// pattern below cheap: run over a long line of spaces or "#", the heading pattern takes time that grows with the
// square of the length (a crafted 1 MB line would block the worker for minutes).
const MAX_HEADING_CHARS = 200;
const HEADING = /^(#{1,6})[ \t]+(.*)$/;
// An optional closing run of "#", as in "## Results ##"; a "#" inside the title (as in "C#") stays.
const CLOSING_HASHES = /[ \t]+#+[ \t]*$/;

function parseHeading(line: string): { level: number; title: string } | null {
  if (line.length > MAX_HEADING_CHARS) return null;
  const m = HEADING.exec(line);
  const title = m?.[2]!.replace(CLOSING_HASHES, '').trim();
  return m && title ? { level: m[1]!.length, title } : null;
}

type Block = Span & { heading?: { level: number; title: string } };

// Paragraphs (runs of non-blank lines) and Markdown headings, with offsets into the original text.
function blocks(content: string): Block[] {
  const out: Block[] = [];
  let paragraph: Span | null = null;
  let pos = 0;
  // Inside a fenced code block a line starting with "#" is code (a shell comment, say), not a heading.
  let inFence = false;
  for (const line of content.split('\n')) {
    const span = { start: pos, end: pos + line.length };
    pos = span.end + 1;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : parseHeading(line);
    if (heading || line.trim() === '') {
      if (paragraph) out.push(paragraph);
      paragraph = null;
      if (heading) out.push({ ...span, heading });
    } else if (paragraph) {
      paragraph.end = span.end;
    } else {
      paragraph = span;
    }
  }
  if (paragraph) out.push(paragraph);
  return out;
}

function headingPaths(content: string): (Block & { path?: string })[] {
  const path: string[] = [];
  return blocks(content).map((block) => {
    if (!block.heading) return block;
    path.length = block.heading.level - 1;
    path[block.heading.level - 1] = block.heading.title;
    return { ...block, path: path.filter(Boolean).join(' > ') };
  });
}

// Where each section starts, for labelling a quote with the section it was found in.
export function sectionIndex(content: string): Section[] {
  return headingPaths(content).flatMap((b) =>
    b.path === undefined ? [] : [{ start: b.start, path: b.path }],
  );
}

export function sectionAt(sections: Section[], offset: number): string {
  let path = '';
  for (const s of sections) {
    if (s.start > offset) break;
    path = s.path;
  }
  return path;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

function lastEnd(re: RegExp, text: string): number {
  let end = -1;
  for (const m of text.matchAll(re)) end = m.index + m[0].length;
  return end;
}

// A paragraph too long for one chunk is cut after a sentence, else at a space, else hard (never inside a
// surrogate pair). Leading whitespace is skipped and a cut piece's trailing whitespace dropped, so no piece is empty.
function splitLong(content: string, block: Span): Span[] {
  const pieces: Span[] = [];
  let start = block.start;
  while (start < block.end && /\s/.test(content[start]!)) start++;
  while (block.end - start > MAX_CHARS) {
    const window = content.slice(start, start + TARGET_CHARS);
    let cut = lastEnd(/[.!?]["')\]]?\s+/g, window);
    if (cut <= 0) cut = lastEnd(/\s+/g, window);
    if (cut <= 0)
      cut = window.length - (isHighSurrogate(window.charCodeAt(window.length - 1)) ? 1 : 0);
    let end = start + cut;
    while (end > start && /\s/.test(content[end - 1]!)) end--;
    if (end > start) pieces.push({ start, end });
    start += cut;
    while (start < block.end && /\s/.test(content[start]!)) start++;
  }
  if (start < block.end) pieces.push({ start, end: block.end });
  return pieces;
}

// Splits on headings and paragraphs, packing paragraphs up to about TARGET_CHARS. A chunk normally stays inside
// one section; a section shorter than MIN_CHARS is packed together with the next. Each chunk is an exact slice of
// the stored text, so its offsets locate it in the document. Its heading path is that of the section it starts in.
export function chunkText(content: string): Chunk[] {
  const chunks: Chunk[] = [];
  let path = '';
  let current: (Span & { headingPath: string; hasBody: boolean }) | null = null;

  const flush = () => {
    if (current?.hasBody) {
      const { start, end, headingPath } = current;
      chunks.push({
        ordinal: chunks.length,
        start,
        end,
        headingPath,
        text: content.slice(start, end),
      });
    }
    current = null;
  };

  for (const block of headingPaths(content)) {
    if (block.path !== undefined) {
      path = block.path;
      // Packing stops once the chunk would pass TARGET_CHARS, so a long run of blank lines can't stretch it.
      if (
        current &&
        current.end - current.start < MIN_CHARS &&
        block.end - current.start <= TARGET_CHARS
      ) {
        current.end = block.end;
        continue;
      }
      flush();
      current = { ...block, headingPath: path, hasBody: false };
      continue;
    }
    for (const piece of splitLong(content, block)) {
      if (current && piece.end - current.start <= TARGET_CHARS) {
        current.end = piece.end;
        current.hasBody = true;
        continue;
      }
      flush();
      current = { ...piece, headingPath: path, hasBody: true };
    }
  }
  flush();
  return chunks;
}
