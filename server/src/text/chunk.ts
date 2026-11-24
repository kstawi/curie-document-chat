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

// About 300 tokens at the usual four characters per token; well under the embedding model's 2,048-token limit.
const TARGET_CHARS = 1_200;
const MAX_CHARS = 1_600;

// shortcut: a character-based estimate, not the model's tokenizer; budgets keep a margin for that.
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;

// Paragraphs (runs of non-blank lines) and Markdown headings, with offsets into the original text.
function blocks(content: string): (Span & { heading?: { level: number; title: string } })[] {
  const out: (Span & { heading?: { level: number; title: string } })[] = [];
  let paragraph: Span | null = null;
  let pos = 0;
  for (const line of content.split('\n')) {
    const span = { start: pos, end: pos + line.length };
    pos = span.end + 1;
    const heading = HEADING.exec(line);
    if (heading || line.trim() === '') {
      if (paragraph) out.push(paragraph);
      paragraph = null;
      if (heading) {
        out.push({ ...span, heading: { level: heading[1]!.length, title: heading[2]! } });
      }
    } else if (paragraph) {
      paragraph.end = span.end;
    } else {
      paragraph = span;
    }
  }
  if (paragraph) out.push(paragraph);
  return out;
}

function lastEnd(re: RegExp, text: string): number {
  let end = -1;
  for (const m of text.matchAll(re)) end = m.index + m[0].length;
  return end;
}

// A paragraph too long for one chunk is cut after a sentence, else at a space, else hard.
function splitLong(content: string, block: Span): Span[] {
  const pieces: Span[] = [];
  let start = block.start;
  while (block.end - start > MAX_CHARS) {
    const window = content.slice(start, start + TARGET_CHARS);
    let cut = lastEnd(/[.!?]["')\]]?\s+/g, window);
    if (cut <= 0) cut = lastEnd(/\s+/g, window);
    if (cut <= 0) cut = window.length;
    let end = start + cut;
    while (end > start && /\s/.test(content[end - 1]!)) end--;
    pieces.push({ start, end });
    start += cut;
    while (start < block.end && /\s/.test(content[start]!)) start++;
  }
  if (start < block.end) pieces.push({ start, end: block.end });
  return pieces;
}

// Splits on headings and paragraphs, packing paragraphs of one section up to about TARGET_CHARS. Each chunk is an
// exact slice of the stored text, so its offsets locate it in the document.
export function chunkText(content: string): Chunk[] {
  const chunks: Chunk[] = [];
  const path: string[] = [];
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

  for (const block of blocks(content)) {
    if (block.heading) {
      flush();
      path.length = block.heading.level - 1;
      path[block.heading.level - 1] = block.heading.title;
      current = { ...block, headingPath: path.filter(Boolean).join(' > '), hasBody: false };
      continue;
    }
    for (const piece of splitLong(content, block)) {
      if (current && piece.end - current.start <= TARGET_CHARS) {
        current.end = piece.end;
        current.hasBody = true;
        continue;
      }
      flush();
      current = { ...piece, headingPath: path.filter(Boolean).join(' > '), hasBody: true };
    }
  }
  flush();
  return chunks;
}
